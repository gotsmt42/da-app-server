const crypto = require("crypto");
const webpush = require("web-push");
const PushSubscription = require("../models/PushSubscription");
const User = require("../models/User");
const { rankFilter } = require("../config/roles");

webpush.setVapidDetails(
  process.env.VAPID_SUBJECT,
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

/**
 * ตัวเลือกการส่งของ push service (Web Push มาตรฐาน: TTL · Topic · Urgency)
 *
 * 🐛 ปัญหาที่แก้ (ผู้ใช้: "เครื่องที่ปิดไว้ พอเปิดเครื่องแจ้งเตือนเด้งมาพรวดทีเดียว"): เดิมไม่ได้ตั้งอะไรเลย →
 *   push service (FCM/Apple/Mozilla) เก็บทุกข้อความไว้สูงสุด 4 สัปดาห์ แล้วปล่อยรวดเดียวตอนเครื่องกลับมาออนไลน์
 * ✅ แบบที่แอปมืออาชีพทำ:
 *   • TTL    — ข้อความหมดอายุถ้าส่งไม่ถึงในเวลาที่สมเหตุสมผล (เตือนประจำวัน 4 ชม. · เหตุการณ์ 12 ชม.) ของเก่าไม่โผล่ทีหลัง
 *   • Topic  — เรื่องเดียวกัน (tag เดียวกัน) ระหว่างเครื่องออฟไลน์ เก็บไว้แค่ "ข้อความล่าสุด" อันเดียว ไม่กองซ้ำ
 *   • Urgency — เตือนประจำวัน = low (ไม่ปลุกเครื่องที่ประหยัดแบต) · เหตุการณ์ที่ต้องลงมือ = high
 * ⚠️ topic ต้องเป็นอักขระ URL-safe base64 ไม่เกิน 32 ตัว — แปลง tag เป็น hash เสมอ (tag มีภาษาไทย/ขีด/ยาวได้)
 */
const REMINDER_TAGS = /reminder|overdue|unassigned/i;
function deliveryOptions(payload = {}) {
  const tag = String(payload.tag || "");
  const isReminder = payload.kind === "reminder" || REMINDER_TAGS.test(tag);
  const opts = {
    TTL: Number(payload.ttl) > 0 ? Number(payload.ttl) : (isReminder ? 4 : 12) * 60 * 60,
    urgency: payload.urgency || (isReminder ? "low" : "high"),
  };
  if (tag) opts.topic = crypto.createHash("sha256").update(tag).digest("base64url").slice(0, 32);
  return opts;
}

// ✅ ส่ง push ให้ผู้ใช้ตาม userId ทุกอุปกรณ์/เบราว์เซอร์ที่เคย subscribe ไว้
// ถ้า endpoint หมดอายุ/ถูกยกเลิก (404/410) ให้ลบ subscription นั้นทิ้งจาก DB ไปเลย
async function sendPushToUsers(userIds, payload) {
  const ids = [...new Set((Array.isArray(userIds) ? userIds : [userIds]).filter(Boolean).map(String))];
  if (ids.length === 0) return;

  const subs = await PushSubscription.find({ userId: { $in: ids } });
  const body = JSON.stringify(payload);
  const options = deliveryOptions(payload);

  await Promise.all(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: sub.keys },
          body,
          options
        );
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) {
          await PushSubscription.deleteOne({ _id: sub._id });
        } else {
          console.error("❌ Push notification error:", err.statusCode, err.body);
        }
      }
    })
  );
}

// ✅ ส่ง push ให้ทุกคนที่มี Rank (ตำแหน่งในองค์กร) อยู่ในรายการที่ระบุ (เช่น แจ้งแอดมิน/ผู้จัดการตอนช่างขอปิดงาน)
async function sendPushToRoles(roles, payload) {
  const users = await User.find(rankFilter(roles)).select("_id").lean();
  await sendPushToUsers(users.map((u) => u._id.toString()), payload);
}

// ✅ ส่ง push ให้ทุกคนในระบบ (เช่น แจ้งตอนมีการเพิ่มงานใหม่) ยกเว้นคนที่ระบุ (เช่น คนที่เพิ่งเพิ่มงานเอง)
async function sendPushToAllUsers(payload, excludeUserIds = []) {
  const excluded = new Set((Array.isArray(excludeUserIds) ? excludeUserIds : [excludeUserIds]).filter(Boolean).map(String));
  const users = await User.find({}).select("_id").lean();
  const ids = users.map((u) => u._id.toString()).filter((id) => !excluded.has(id));
  await sendPushToUsers(ids, payload);
}

module.exports = { sendPushToUsers, sendPushToRoles, sendPushToAllUsers, deliveryOptions };
