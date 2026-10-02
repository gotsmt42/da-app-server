const express = require("express");
const router = express.Router();

const PushSubscription = require("../models/PushSubscription");
const verifyToken = require("../middleware/auth");
const Notification = require("../models/Notification");
const { sendPushToUsers } = require("../services/PushNotify");
const { publish } = require("../services/realtime");
const { isValidObjectId } = require("mongoose");

// ✅ ให้ frontend ดึง public key ไปใช้ตอน subscribe (ไม่ต้อง hardcode ซ้ำสองที่)
router.get("/vapid-public-key", (req, res) => {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
});

// ✅ บันทึก/อัปเดต subscription ของอุปกรณ์นี้ ผูกกับผู้ใช้ที่ล็อกอินอยู่
router.post("/subscribe", verifyToken, async (req, res) => {
  try {
    const { endpoint, keys } = req.body;
    if (!endpoint || !keys?.p256dh || !keys?.auth) {
      return res.status(400).json({ message: "ข้อมูล subscription ไม่ครบ" });
    }

    await PushSubscription.findOneAndUpdate(
      { endpoint },
      { endpoint, keys, userId: req.userId },
      { upsert: true, new: true }
    );

    res.status(200).json({ message: "subscribed" });
  } catch (err) {
    console.error("❌ Push subscribe error:", err);
    res.status(500).json({ message: "ไม่สามารถบันทึกการแจ้งเตือนได้" });
  }
});

// ✅ ยกเลิกรับแจ้งเตือนของอุปกรณ์นี้
router.post("/unsubscribe", verifyToken, async (req, res) => {
  try {
    const { endpoint } = req.body;
    if (!endpoint) return res.status(400).json({ message: "ไม่พบ endpoint" });

    await PushSubscription.deleteOne({ endpoint, userId: req.userId });
    res.status(200).json({ message: "unsubscribed" });
  } catch (err) {
    console.error("❌ Push unsubscribe error:", err);
    res.status(500).json({ message: "ไม่สามารถยกเลิกการแจ้งเตือนได้" });
  }
});

// ══ กล่องแจ้งเตือน (แบบ LINE) ═══════════════════════════════════════════════
// ✅ ทุกข้อความที่เด้ง push ถูกเก็บไว้ (models/Notification.js) — กระดิ่งในแอปอ่านจากที่นี่ทุกเครื่อง

const unreadOf = (userId) => Notification.countDocuments({ userId, readAt: null });
/** แจ้งเครื่องอื่นของคนเดียวกันให้อัปเดตกระดิ่ง/ตัวเลขบนไอคอน (อ่านบนมือถือ → คอมเคลียร์ตาม) */
const syncDevices = (userId) => publish({ topic: "inbox", userIds: [userId], action: "read" });

/** รายการล่าสุด + จำนวนที่ยังไม่อ่าน · ?before=<ISO date> = โหลดหน้าถัดไป */
router.get("/inbox", verifyToken, async (req, res) => {
  try {
    const userId = String(req.userId);
    const limit = Math.min(Math.max(Number(req.query.limit) || 40, 1), 100);
    const query = { userId };
    const before = req.query.before ? new Date(String(req.query.before)) : null;
    if (before && !Number.isNaN(before.getTime())) query.createdAt = { $lt: before };
    const [items, unread] = await Promise.all([
      Notification.find(query).sort({ createdAt: -1 }).limit(limit + 1).lean(),
      unreadOf(userId),
    ]);
    res.json({ items: items.slice(0, limit), unread, hasMore: items.length > limit });
  } catch (err) {
    console.error("❌ ดึงกล่องแจ้งเตือนไม่สำเร็จ:", err);
    res.status(500).json({ message: "ดึงการแจ้งเตือนไม่สำเร็จ" });
  }
});

/** ทำเครื่องหมายอ่านแล้ว — { ids: [...] } หรือ { all: true } */
router.post("/inbox/read", verifyToken, async (req, res) => {
  try {
    const userId = String(req.userId);
    const query = { userId, readAt: null };
    if (!req.body?.all) {
      const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).map(String).filter(isValidObjectId).slice(0, 200);
      if (!ids.length) return res.json({ unread: await unreadOf(userId) });
      query._id = { $in: ids };
    }
    const r = await Notification.updateMany(query, { $set: { readAt: new Date() } });
    if (r.modifiedCount) syncDevices(userId);
    res.json({ unread: await unreadOf(userId) });
  } catch (err) {
    console.error("❌ ทำเครื่องหมายอ่านแล้วไม่สำเร็จ:", err);
    res.status(500).json({ message: "บันทึกไม่สำเร็จ" });
  }
});

/** ล้างรายการที่อ่านแล้วทั้งหมดของฉัน */
router.delete("/inbox/read", verifyToken, async (req, res) => {
  try {
    const userId = String(req.userId);
    await Notification.deleteMany({ userId, readAt: { $ne: null } });
    syncDevices(userId);
    res.json({ unread: await unreadOf(userId) });
  } catch (err) {
    console.error("❌ ล้างการแจ้งเตือนไม่สำเร็จ:", err);
    res.status(500).json({ message: "ล้างไม่สำเร็จ" });
  }
});

/** สถานะของฉัน — จำนวนอุปกรณ์ที่รับแจ้งเตือนได้ (หน้าตั้งค่าใช้บอกผู้ใช้) */
router.get("/status", verifyToken, async (req, res) => {
  try {
    const devices = await PushSubscription.countDocuments({ userId: String(req.userId) });
    res.json({ devices, configured: Boolean(process.env.VAPID_PUBLIC_KEY) });
  } catch (err) {
    res.status(500).json({ message: "ดึงสถานะไม่สำเร็จ" });
  }
});

/** ส่งแจ้งเตือนทดสอบหาตัวเอง (ทุกอุปกรณ์ที่เปิดไว้) — ไม่เก็บลงกล่อง */
router.post("/test", verifyToken, async (req, res) => {
  try {
    const userId = String(req.userId);
    const devices = await PushSubscription.countDocuments({ userId });
    if (!devices) return res.status(409).json({ message: "ยังไม่มีอุปกรณ์ที่เปิดรับแจ้งเตือน — เปิดสวิตช์ก่อนแล้วลองใหม่" });
    await sendPushToUsers(userId, {
      title: "🔔 ทดสอบการแจ้งเตือน",
      body: "ถ้าเห็นข้อความนี้บนจอมือถือ แปลว่าระบบแจ้งเตือนพร้อมใช้งานแล้ว",
      url: "/about", tag: `push-test-${userId}`, renotify: true, inbox: false, ttl: 120,
    });
    res.json({ devices });
  } catch (err) {
    console.error("❌ ส่งแจ้งเตือนทดสอบไม่สำเร็จ:", err);
    res.status(500).json({ message: "ส่งแจ้งเตือนทดสอบไม่สำเร็จ" });
  }
});

module.exports = router;
