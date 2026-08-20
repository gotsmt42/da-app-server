const express = require("express");
const morgan = require("morgan");
const cors = require("cors");
const compression = require("compression");
const helmet = require("helmet");

const apiRouter = require("./routes");
const { notFoundHandler, errorHandler } = require("./middleware/errorHandler");
const {
  UPLOADS_DIR,
  UPLOAD_FILES_DIR,
  IMAGE_DIR,
  WORKORDER_BEFORE_DIR,
  WORKORDER_AFTER_DIR,
} = require("./config/paths");

/**
 * สร้าง Express app แล้ว export ออกไปเฉยๆ — "ไม่ listen ที่นี่"
 *
 * ✅ ทำไมต้องแยกจากการ listen: ทำให้เอา app ไปทดสอบได้โดยไม่ต้องเปิดพอร์ตจริง และแยกเรื่อง
 * "แอปประกอบด้วยอะไร" ออกจาก "แอปถูกรันยังไง" ได้ชัดเจน (index.js ที่รากเป็นตัวรัน)
 */
const app = express();

/**
 * 🐛 ปัญหาที่แก้ (อาการ: "หน้าค้าง กดอะไรไม่ได้ ข้อมูลไม่โหลด" แต่เปิดบน localhost ปกติ):
 * เดิมอนุญาตแค่ 2 origin คือ https://da-app.vercel.app กับ localhost:3000 — แต่ Vercel สร้าง
 * URL เฉพาะให้ทุก deployment (เช่น da-esw1vi827-gotsmt42s-projects.vercel.app) ซึ่งเป็น URL ที่
 * ได้เวลากดลิงก์จากหน้า dashboard ตอนไปเช็คงาน พอ origin ไม่ตรงรายการ เบราว์เซอร์บล็อกทุก
 * API call ทิ้งหมด → ข้อมูลไม่โหลดสักอย่าง และหน้าค้างอยู่ที่ loading
 *
 * ⚠️ ไม่ได้เปิดกว้างเป็น "*" เพราะ credentials: true (ส่ง cookie/token ข้ามโดเมน) — เปิดกว้าง
 * เมื่อไหร่ เว็บไหนก็ยิง API แทนผู้ใช้ที่ล็อกอินอยู่ได้ทันที จึงจำกัดเป็นรูปแบบที่แน่นอนแทน
 */
const ALLOWED_ORIGINS = [
  "https://da-app.vercel.app", // production
  "http://localhost:3000", // dev
];

// URL ของ deployment/preview บน Vercel ของโปรเจกต์นี้เท่านั้น
// รูปแบบ: da-<hash>-<ทีม>.vercel.app  หรือ  da-app-<branch>-<ทีม>.vercel.app
const VERCEL_PREVIEW = /^https:\/\/da-app?[a-z0-9-]*-gotsmt42s-projects\.vercel\.app$/;

const corsOptions = {
  origin(origin, callback) {
    // ไม่มี origin = เรียกจาก server/curl/แอปมือถือ ไม่ใช่เบราว์เซอร์ → ปล่อยผ่าน
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.includes(origin) || VERCEL_PREVIEW.test(origin)) {
      return callback(null, true);
    }
    // ⚠️ ไม่โยน error — ตอบ false เฉยๆ ให้ cors ไม่ใส่ header แล้วเบราว์เซอร์บล็อกเอง
    // (ถ้าโยน error จะกลายเป็น 500 ซึ่งอ่าน log แล้วเข้าใจผิดว่าเซิร์ฟเวอร์พัง)
    console.warn(`⚠️  CORS ปฏิเสธ origin: ${origin}`);
    return callback(null, false);
  },
  credentials: true,
  optionsSuccessStatus: 200,
};

app.use(morgan("dev"));
app.use(cors(corsOptions));
app.use(helmet());
app.use(compression());

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ── API ทั้งหมด ────────────────────────────────────────────────────────────
app.use("/api", apiRouter);

// ── ไฟล์นิ่ง (รูป/ไฟล์แนบที่เก็บบนดิสก์) ──────────────────────────────────────
// ⚠️ ใช้พาธจาก config/paths.js เสมอ อย่านับ ../ เอง — ตอนย้ายซอร์สเข้า src/ พาธพวกนี้เพี้ยนไป
// ทั้งชุดเพราะความลึกเปลี่ยน และเป็นความผิดพลาดที่ syntax check/ESLint จับไม่ได้
app.use("/api/workorder/images/before", express.static(WORKORDER_BEFORE_DIR));
app.use("/api/workorder/images/after", express.static(WORKORDER_AFTER_DIR));
app.use("/uploads", express.static(UPLOADS_DIR));
app.use("/api/asset/uploads/files", express.static(UPLOAD_FILES_DIR));
app.use("/api/asset/image", express.static(IMAGE_DIR));

// ── ตัวรับ error ตัวสุดท้าย ─────────────────────────────────────────────────
// ⚠️ ต้องอยู่ "ท้ายสุด" หลัง route และ static ทั้งหมด — Express ไล่ middleware ตามลำดับ
// ถ้าเอาขึ้นไปไว้ก่อน route ทุก request จะจบที่ 404 ทันที
app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
