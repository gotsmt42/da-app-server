const express = require("express");

const checkInternetConnection = require("../middleware/checkInternetConnection");

const authRouter = require("./auth");
const customerRouter = require("./customer");
const productRouter = require("./product");
const stockProductRouter = require("./stockProduct");
const fileRouter = require("./file");
const holidayRouter = require("./fetchHolidays");
const calendarEventRouter = require("./calendarEvent");
const pushRouter = require("./push");
const jobTypeRouter = require("./jobType");
const systemTypeRouter = require("./systemType");
// ✅ เลขที่เอกสารแบบเดินหน้าอย่างเดียว (ใบส่งมอบงาน ฯลฯ) — ดูเหตุผลที่ต้องออกเลขฝั่ง server
// ไม่ใช่ฝั่งเบราว์เซอร์ ที่ src/models/DocCounter.js
const docNumberRouter = require("./docNumber");
const issuedDocumentRouter = require("./issuedDocument");
const workOrderRouter = require("./workOrder");

/**
 * รวมการ mount router ของ API ทั้งหมดไว้ที่เดียว — เดิมกระจายอยู่ใน index.js ปนกับการตั้งค่า
 * middleware และการเสิร์ฟไฟล์นิ่ง ทำให้ดูไม่ออกว่าระบบมี endpoint อะไรบ้าง
 *
 * ⚠️ ลำดับการ mount มีผลจริงใน Express — router ที่ path เจาะจงกว่าต้องมาก่อนเสมอ
 * ตอนนี้แต่ละตัวมี prefix ไม่ทับกันจึงสลับลำดับได้ แต่ถ้าจะเพิ่มตัวใหม่ให้ระวังจุดนี้
 */
const router = express.Router();

router.use("/auth", authRouter);
router.use("/customer", customerRouter);
router.use("/product", productRouter);
router.use("/stockproduct", stockProductRouter);
router.use("/files", fileRouter);
router.use("/events", calendarEventRouter);
router.use("/push", pushRouter);
router.use("/jobtype", jobTypeRouter);
router.use("/systemtype", systemTypeRouter);
router.use("/doc-number", docNumberRouter);
router.use("/issued-documents", issuedDocumentRouter);
router.use("/workorder", workOrderRouter);
// ✅ เช็คอินเทอร์เน็ตเฉพาะเส้นทางนี้เส้นเดียว (ตัวเดียวที่ต้องยิงออกไปข้างนอก) ไม่ใช่ทั้งแอป
router.use("/holidays", checkInternetConnection, holidayRouter);

module.exports = router;
