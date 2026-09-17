/**
 * /api/realtime — ช่องสัญญาณอัปเดตหน้าจอแบบเรียลไทม์ (ดูหลักการเต็มที่ services/realtime.js)
 *
 * 🔒 ต้องล็อกอิน (verifyToken) — หน้าจอเชื่อมต่อด้วย fetch ที่แนบ Authorization header
 * ⚠️ ไม่ใช้ EventSource ของเบราว์เซอร์เพราะแนบ header ไม่ได้ ต้องใส่ token ใน URL ซึ่งจะไปโผล่ใน log
 * ของเซิร์ฟเวอร์/พร็อกซีทุกตัวที่ผ่าน
 */
const express = require("express");
const verifyToken = require("../middleware/auth");
const { attach } = require("../services/realtime");

const router = express.Router();

router.get("/stream", verifyToken, (req, res) => {
  attach(req, res);
});

module.exports = router;
