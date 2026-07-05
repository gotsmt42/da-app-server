const express = require("express");
const router = express.Router();

const PushSubscription = require("../models/PushSubscription");
const verifyToken = require("../middleware/auth");

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

module.exports = router;
