/**
 * NativePush.js — ส่งแจ้งเตือนเข้า "แอป TidTam" บนมือถือ (Android / iPhone) ผ่าน Firebase Cloud Messaging
 *
 * ✅ (18 ต.ค. 2569) คู่กับ Web Push เดิมใน PushNotify.js — คนที่ใช้เว็บได้ Web Push · คนที่ใช้แอปได้ FCM
 *    ข้อความ/ลิงก์/ตัวเลขบนไอคอนชุดเดียวกัน (สร้างที่ PushNotify แล้วส่งมาที่นี่)
 *
 * ⚙️ เปิดใช้เมื่อตั้งค่า FIREBASE_SERVICE_ACCOUNT (เนื้อไฟล์ service account JSON หรือแบบ base64) เท่านั้น
 *    ยังไม่ตั้ง = ข้ามเงียบๆ (log ครั้งเดียว) — เว็บและ Web Push ทำงานตามปกติ ไม่มีอะไรพัง
 *
 * ⚠️ พฤติกรรมเดียวกับ Web Push (ดู deliveryOptions):
 *    • ttl — ส่งไม่ถึงในเวลาที่กำหนด = ทิ้ง (ไม่เด้งพรวดตอนเปิดเครื่อง)
 *    • collapse (Android collapseKey / iOS apns-collapse-id) — เรื่องเดียวกันเก็บแค่ข้อความล่าสุด
 *    • priority สูง + เสียง — เด้งทับหน้าจอแบบ LINE
 */
const DeviceToken = require("../models/DeviceToken");

let messaging = null;
let initTried = false;

function getMessaging() {
  if (initTried) return messaging;
  initTried = true;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) {
    console.log("ℹ️  ไม่ได้ตั้ง FIREBASE_SERVICE_ACCOUNT — ข้ามแจ้งเตือนแบบแอปมือถือ (Web Push ทำงานปกติ)");
    return null;
  }
  try {
    const json = JSON.parse(raw.trim().startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8"));
    // eslint-disable-next-line global-require
    const admin = require("firebase-admin");
    const app = admin.apps.length ? admin.app() : admin.initializeApp({ credential: admin.credential.cert(json) });
    messaging = app.messaging();
    console.log("✅ แจ้งเตือนแบบแอปมือถือ (Firebase) พร้อมใช้งาน");
  } catch (err) {
    console.error("❌ ตั้งค่า Firebase ไม่สำเร็จ — ตรวจ FIREBASE_SERVICE_ACCOUNT:", err.message);
    messaging = null;
  }
  return messaging;
}

const DEAD_TOKEN = new Set([
  "messaging/registration-token-not-registered",
  "messaging/invalid-registration-token",
  "messaging/invalid-argument",
]);

/**
 * @param {string[]} userIds
 * @param {object}   payload   ข้อความที่จัดรูปแล้ว (title/body/url/tag)
 * @param {object}   opts      { ttlSec, collapse, metaFor(userId) → { nid, unread } }
 */
async function sendNativeToUsers(userIds, payload, { ttlSec = 12 * 3600, collapse = "", metaFor = () => ({}) } = {}) {
  const m = getMessaging();
  if (!m || !userIds.length) return;
  const devices = await DeviceToken.find({ userId: { $in: userIds } }).lean();
  if (!devices.length) return;

  const title = String(payload.title || "แจ้งเตือน");
  const body = String(payload.body || "");
  const results = await Promise.allSettled(devices.map((d) => {
    const meta = metaFor(d.userId) || {};
    const badge = Number.isFinite(meta.unread) ? meta.unread : undefined;
    // ⚠️ data ต้องเป็น string ทุกค่า (ข้อกำหนดของ FCM)
    const data = {
      url: String(payload.url || "/"),
      tag: String(payload.tag || ""),
      ...(meta.nid ? { nid: String(meta.nid) } : {}),
      ...(badge !== undefined ? { badge: String(badge) } : {}),
    };
    return m.send({
      token: d.token,
      notification: { title, body },
      data,
      android: {
        priority: "high",
        ttl: ttlSec * 1000,
        ...(collapse ? { collapseKey: collapse } : {}),
        notification: {
          channelId: "tidtam_default",
          sound: "default",
          ...(payload.tag ? { tag: String(payload.tag).slice(0, 60) } : {}),
          ...(badge !== undefined ? { notificationCount: badge } : {}),
        },
      },
      apns: {
        headers: {
          "apns-priority": "10",
          "apns-expiration": String(Math.floor(Date.now() / 1000) + ttlSec),
          ...(collapse ? { "apns-collapse-id": collapse.slice(0, 64) } : {}),
        },
        payload: { aps: { sound: "default", ...(badge !== undefined ? { badge } : {}) } },
      },
    });
  }));

  // เครื่องที่ถอนแอป/token หมดอายุ — ลบทิ้ง ไม่ส่งซ้ำไปเรื่อยๆ
  const dead = [];
  results.forEach((r, i) => {
    if (r.status === "rejected") {
      const code = r.reason?.code || r.reason?.errorInfo?.code;
      if (DEAD_TOKEN.has(code)) dead.push(devices[i]._id);
      else console.error("❌ FCM ส่งไม่สำเร็จ:", code || r.reason?.message);
    }
  });
  if (dead.length) await DeviceToken.deleteMany({ _id: { $in: dead } });
}

module.exports = { sendNativeToUsers, getMessaging };
