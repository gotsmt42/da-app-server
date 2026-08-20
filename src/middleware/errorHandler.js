/**
 * ตัวรับ error ตัวสุดท้ายของแอป — ต้อง app.use() "หลัง" route ทั้งหมด
 *
 * 🐛 ปัญหาเดิม: ทุก route ดักและตอบ error เอง แต่ error ที่ "หลุด" ออกมานอก try/catch
 * (เช่น JSON ที่ส่งมาเสียรูป, error ที่โยนใน middleware, promise ที่ไม่ได้ await)
 * จะตกไปที่ error handler ปริยายของ Express ซึ่งตอบกลับเป็น **หน้า HTML พร้อม stack trace**
 * — ฝั่งเบราว์เซอร์ที่คาดว่าจะได้ JSON ก็ parse ไม่ได้ ขึ้นเป็น error งงๆ แทนข้อความจริง
 * และ stack trace ยังเปิดเผยพาธไฟล์/โครงสร้างภายในเซิร์ฟเวอร์ให้คนนอกเห็นด้วย
 *
 * ⚠️ ตัวนี้ "เพิ่มเข้ามาเฉยๆ" ไม่ได้ไปแก้ระบบเดิม — route ที่ตอบ error เองอยู่แล้วยังทำงาน
 * เหมือนเดิมทุกประการ ตัวนี้จะทำงานเฉพาะตอนที่ไม่มีใครดักไว้เท่านั้น
 */

// ── 404: เส้นทางที่ไม่มีอยู่จริง ────────────────────────────────────────────
// ตอบเป็น JSON ให้เหมือนกับ endpoint อื่นๆ (ปริยายของ Express จะตอบเป็น HTML)
function notFoundHandler(req, res) {
  res.status(404).json({ message: `ไม่พบเส้นทาง ${req.method} ${req.originalUrl}` });
}

// ── error ที่หลุดออกมา ─────────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars -- Express รู้ว่าเป็น error handler จาก "จำนวนพารามิเตอร์ = 4"
// เท่านั้น ถ้าตัด next ทิ้งมันจะกลายเป็น middleware ธรรมดาทันทีและไม่เคยถูกเรียก
function errorHandler(err, req, res, next) {
  // ถ้าเริ่มส่ง response ไปแล้วบางส่วน แก้อะไรไม่ได้แล้ว ต้องปล่อยให้ Express ปิด connection เอง
  if (res.headersSent) return next(err);

  const status = err.status || err.statusCode || 500;

  // ✅ log ฝั่งเซิร์ฟเวอร์ให้ครบ (มี stack) แต่ส่งออกไปแค่ข้อความกลางๆ
  console.error(`❌ ${req.method} ${req.originalUrl} →`, err);

  // ⚠️ ไม่ส่ง err.message ออกไปตอน 500 เพราะข้อความจาก mongoose/driver มักมีชื่อ collection,
  // ชื่อฟิลด์ หรือพาธไฟล์ติดมาด้วย — ส่วน 4xx เป็น error ที่เราตั้งใจบอกผู้ใช้ จึงส่งได้
  const message =
    status >= 500 ? "เกิดข้อผิดพลาดที่เซิร์ฟเวอร์ กรุณาลองใหม่อีกครั้ง" : err.message || "คำขอไม่ถูกต้อง";

  res.status(status).json({ message });
}

module.exports = { notFoundHandler, errorHandler };
