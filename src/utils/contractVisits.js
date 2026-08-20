// ✅ ค่าเริ่มต้นของ "ระยะห่างระหว่างรอบ" (เดือน) สำหรับสัญญาที่ยังไม่เคยระบุ intervalMonths ไว้ —
// ใช้เป็นเกณฑ์เตือน "เกินกำหนดรอบถัดไป" เท่านั้น (ดู services/OverdueReminder.js,
// src/utils/contractOverdue.js ฝั่ง frontend) ไม่เกี่ยวกับ/ไม่คำนวณทับ visitCount ซึ่งผู้ใช้กำหนด
// เองอิสระเสมอ เพราะงานจริงเลื่อน/ชนกันได้ตลอด
const DEFAULT_INTERVAL_MONTHS = 3;

module.exports = { DEFAULT_INTERVAL_MONTHS };
