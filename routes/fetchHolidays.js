const express = require("express");
const router = express.Router();
const holidaysData = require("../data/thai-holidays-2026-2028.json");

// 🐛 BUG ที่แก้ (วันหยุดแสดงไม่ครบ — ทั้งปี 2027 ไม่เคยขึ้นเลยสักวัน): เดิม default เป็น "ปีปัจจุบัน"
// เสมอเมื่อไม่ได้ระบุ ?year= — แต่ฝั่งปฏิทิน (fetchThaiHolidaysFromAPI ใน EventCalendar/index.js) เรียก
// GET /holidays เปล่าๆ ครั้งเดียวตอนโหลดหน้า ไม่เคยส่งปีมาเลย และไม่ได้ดึงใหม่ตอนผู้ใช้กดเลื่อนเดือน/ปี
// → ปฏิทินจึงมีข้อมูลวันหยุดแค่ปีปัจจุบันปีเดียวตลอด พอเลื่อนไปดูปีถัดไปจะไม่มีวันหยุดสักวัน ทั้งที่ไฟล์
// ข้อมูลมีปี 2027 ครบ 24 วันอยู่แล้ว (ดู data/thai-holidays-2026-2028.json)
// ✅ ไม่ระบุปี = คืนทุกปีที่มีข้อมูล (รวมกันไม่กี่สิบรายการ เบามาก) ปฏิทินจึงมีวันหยุดครบทุกปีตั้งแต่
// โหลดครั้งเดียว ไม่ต้องดึงซ้ำตอนเลื่อนเดือน — ทุกรายการมีวันที่เต็มรูปแบบ (YYYY-MM-DD) อยู่แล้ว
// จึงนำไปวางบนปฏิทินได้ถูกวันทันทีโดยไม่ต้องรู้ว่ามาจากปีไหน
// ⚠️ ยังรองรับ ?year= แบบเดิมทุกประการ (ผู้เรียกที่ระบุปีมาเจาะจงได้ผลลัพธ์เหมือนเดิมไม่เปลี่ยน)
router.get("/", (req, res) => {
  const { year } = req.query;

  if (year) {
    return res.json(holidaysData[year] || []);
  }

  const allHolidays = Object.values(holidaysData).flat();
  res.json(allHolidays);
});

module.exports = router;

