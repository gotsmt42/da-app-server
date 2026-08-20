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

const corsOptions = {
  origin: ["https://da-app.vercel.app", "http://localhost:3000"],
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
