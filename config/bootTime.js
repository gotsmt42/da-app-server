// เวลาที่ process นี้เริ่มทำงาน (boot) — ใช้เป็นจุดตัดเพื่อ invalidate token ทุกใบที่ออกก่อนหน้านี้
// ทุกครั้งที่ deploy ใหม่ (push ขึ้น production) เซิร์ฟเวอร์จะ restart process ใหม่ ค่านี้จึงเปลี่ยนโดยอัตโนมัติ
// ทำให้ผู้ใช้ทุกคนถูกบังคับ login ใหม่ทันทีหลัง deploy โดยไม่ต้องรันสคริปต์เพิ่ม
module.exports = Date.now();
