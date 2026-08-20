/**
 * กฎกลางของการรับไฟล์อัปโหลดทุก route — ขนาดสูงสุด และชนิดที่อนุญาต
 *
 * 🐛 สภาพเดิม: ไม่มี route ไหนตั้ง `limits` ให้ multer เลยสักจุด แปลว่า
 *   • อัปไฟล์ใหญ่แค่ไหนก็ได้ ไม่มีเพดาน
 *   • route ที่ใช้ memoryStorage (calendarEvent) โหลดไฟล์ทั้งก้อนเข้า RAM ก่อนส่งต่อ Cloudinary
 *     → อัปไฟล์ 500 MB ครั้งเดียวก็กิน RAM 500 MB ทันที ซึ่งบน Render แผนเล็กคือ process ตาย
 *   • ไม่มี fileFilter (ยกเว้น uploadWorkOrderImage) = อัป .exe / .svg / .html ขึ้นไปเก็บได้
 *
 * ⚠️ MAX_UPLOAD_BYTES ต้องตรงกับ MAX_UPLOAD_MB ฝั่งหน้าเว็บ (src/shared/utils/fileUpload.js)
 * ถ้าสองฝั่งไม่ตรงกัน ผู้ใช้จะเจอ "อัปได้ที่หน้าจอแต่ server ปฏิเสธ" ซึ่งงงกว่าการห้ามตั้งแต่แรก
 */

const MAX_UPLOAD_MB = 15;
const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;

const ALLOWED_IMAGE_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  // iPhone ถ่ายเป็น HEIC เป็นค่าเริ่มต้น — ไม่รับ = ช่างอัปรูปจาก iPhone ไม่ได้
  "image/heic",
  "image/heif",
];

const ALLOWED_DOC_TYPES = [
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
];

const ALLOWED_TYPES = [...ALLOWED_IMAGE_TYPES, ...ALLOWED_DOC_TYPES];

/**
 * ⚠️ นามสกุลที่ปฏิเสธเสมอ แม้ MIME type จะดูปกติ — client แต่งค่า Content-Type ส่งมาได้
 * .svg คือตัวอันตรายที่สุดในรายการนี้: เป็น XML ที่ฝัง <script> ได้ พอเปิดจากลิงก์ Cloudinary
 * จะรันสคริปต์ในบริบทของโดเมนนั้น = ช่องทาง XSS มาตรฐานของระบบอัปโหลดรูป
 */
const BLOCKED_EXTENSIONS = [
  "svg", "html", "htm", "js", "mjs",
  "exe", "msi", "bat", "cmd", "com", "scr", "ps1", "sh",
  "docm", "xlsm", "pptm",
  "zip", "rar", "7z",
];

const extOf = (name = "") => String(name).split(".").pop().toLowerCase();

/** ใช้เป็น fileFilter ของ multer — ปฏิเสธตั้งแต่ยังไม่ทันอ่านไฟล์จบ */
const fileFilter = (req, file, cb) => {
  const ext = extOf(file.originalname);
  if (BLOCKED_EXTENSIONS.includes(ext)) {
    return cb(new Error(`ไม่รองรับไฟล์ .${ext} ด้วยเหตุผลด้านความปลอดภัย`));
  }
  // บางเครื่องส่ง mimetype เป็น application/octet-stream มา (เช่น .heic บน Windows) → เช็คนามสกุลสำรอง
  const okByType = ALLOWED_TYPES.includes(file.mimetype);
  const okByExt = ["jpg", "jpeg", "png", "webp", "heic", "heif", "pdf", "doc", "docx", "xls", "xlsx"].includes(ext);
  if (!okByType && !okByExt) {
    return cb(new Error("รองรับเฉพาะรูปภาพ (JPG, PNG, WebP, HEIC) และเอกสาร (PDF, Word, Excel)"));
  }
  cb(null, true);
};

const limits = { fileSize: MAX_UPLOAD_BYTES };

/**
 * ตัวจัดการ error ของ multer — ต้อง app.use() "หลัง" route ที่รับไฟล์
 * ⚠️ ถ้าไม่ดัก error ของ multer เอง มันจะกลายเป็น 500 เปล่าๆ ผู้ใช้เห็นแค่ "บันทึกไม่สำเร็จ"
 * ไม่มีทางรู้ว่าเพราะไฟล์ใหญ่เกินหรือชนิดไม่รองรับ
 */
const uploadErrorHandler = (err, req, res, next) => {
  if (!err) return next();
  if (err.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ message: `ไฟล์ใหญ่เกินไป — จำกัดที่ ${MAX_UPLOAD_MB} MB ต่อไฟล์` });
  }
  if (err.code === "LIMIT_FILE_COUNT" || err.code === "LIMIT_UNEXPECTED_FILE") {
    return res.status(400).json({ message: "จำนวนไฟล์เกินที่กำหนด" });
  }
  // error จาก fileFilter ของเรา (ข้อความไทยพร้อมใช้อยู่แล้ว)
  if (err instanceof Error && !err.code && err.message) {
    return res.status(415).json({ message: err.message });
  }
  return next(err);
};

module.exports = {
  MAX_UPLOAD_MB,
  MAX_UPLOAD_BYTES,
  ALLOWED_IMAGE_TYPES,
  ALLOWED_DOC_TYPES,
  ALLOWED_TYPES,
  BLOCKED_EXTENSIONS,
  fileFilter,
  limits,
  uploadErrorHandler,
};
