require("dotenv").config();
const express = require("express");
const morgan = require("morgan");
const cors = require("cors");
const compression = require("compression");
const helmet = require("helmet");
const path = require("path");

const workOrderRoutes = require("./routes/workOrderRoutes");
const authRouter = require("./routes/auth");
const customerRouter = require("./routes/customer");
const productRouter = require("./routes/product");
const stockProductRouter = require("./routes/stockProduct");
const fileRouter = require("./routes/file");
const holidayRouter = require("./routes/fetchHolidays");
const calendarEventRouter = require("./routes/calendarEvent");
const pushRouter = require("./routes/push");
const jobTypeRouter = require("./routes/jobType");
const systemTypeRouter = require("./routes/systemType");
// ✅ เลขที่เอกสารแบบเดินหน้าอย่างเดียว (ใบส่งมอบงาน ฯลฯ) — ดูเหตุผลที่ต้องออกเลขฝั่ง server
// ไม่ใช่ฝั่งเบราว์เซอร์ ที่ models/DocCounter.js
const docNumberRouter = require("./routes/docNumber");
const issuedDocumentRouter = require("./routes/issuedDocument");
const checkInternetConnection = require("./middleware/checkInternetConnection");
const {
  checkAndNotifyOverdueJobs, checkAndNotifyStaleQuotations,
  checkAndNotifyOverdueContracts, checkAndNotifyExpiringContracts,
  checkAndNotifyOverdueInvoices,
} = require("./services/OverdueReminder");
const { scheduleDaily } = require("./services/DailySchedule");





const app = express();
const PORT = process.env.PORT || 5000;

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





app.use("/api/workorder", workOrderRoutes);

app.use(
  "/api/workorder/images/before",
  express.static(path.join(__dirname, "asset/uploads/workorders/before"))
);

app.use(
  "/api/workorder/images/after",
  express.static(path.join(__dirname, "asset/uploads/workorders/after"))
);


app.use("/api/auth", authRouter);
app.use("/api/customer", customerRouter);
app.use("/api/product", productRouter);
app.use("/api/stockproduct", stockProductRouter);
app.use("/api/files", fileRouter);
app.use("/api/events", calendarEventRouter);
app.use("/api/push", pushRouter);
app.use("/api/jobtype", jobTypeRouter);
app.use("/api/systemtype", systemTypeRouter);
app.use("/api/doc-number", docNumberRouter);
app.use("/api/issued-documents", issuedDocumentRouter);
app.use("/api/holidays", checkInternetConnection, holidayRouter); // ✅ ใช้เฉพาะจุด

app.use("/uploads", express.static(path.join(__dirname, "asset/uploads")));
app.use("/api/asset/uploads/files", express.static(path.join(__dirname, "asset/uploads/files")));
app.use("/api/asset/image", express.static(path.join(__dirname, "asset/image")));

app.listen(PORT, () => {
  console.log(`🚀 Server is running on port ${PORT}`);
});

// ── แจ้งเตือนประจำวัน ────────────────────────────────────────────────────────
// ✅ ทุกตัวยิงเวลาเดียวกันคือ 12:00 น. ตามเวลาไทย ทุกวัน ไม่ว่าจะ deploy/รีสตาร์ทกี่ครั้งก็ตาม
//
// 🐛 ปัญหาเดิม (ผู้ใช้แจ้งว่า "แจ้งมั่วสะเปะสะปะ"): ใช้ setTimeout(2 นาที) + setInterval(24 ชม.)
// ซึ่งนับจากเวลาที่โปรเซสเริ่มทำงาน — deploy ตอนไหนก็ได้แจ้งเวลานั้นไปตลอด แล้วพอ deploy ใหม่เวลาก็
// ย้ายอีก ผู้ใช้จึงไม่มีทางรู้เลยว่าจะได้รับแจ้งตอนไหน
//
// ✅ ทำไมเลือก 12:00: เป็นเวลาพักกลางวัน คนเปิดดูมือถืออยู่แล้ว และยังเหลือครึ่งวันให้ตามงานต่อได้ทัน
// ต่างจากตอนเช้าตรู่/ดึกที่แจ้งไปก็ไม่มีใครทำอะไรต่อได้
//
// ⚠️ ถ้าจะเปลี่ยนเวลา แก้ที่ NOTIFY_HOUR ตัวเดียว มีผลกับทุกตัวพร้อมกัน — อย่าไปแก้ทีละตัว เพราะการ
// ให้แต่ละเรื่องแจ้งคนละเวลาจะทำให้ผู้ใช้โดนรบกวนกระจายทั้งวันแทนที่จะจบในครั้งเดียว
const NOTIFY_HOUR = 12;

[
  { name: "งานค้าง", task: checkAndNotifyOverdueJobs },
  { name: "ใบเสนอราคาค้าง", task: checkAndNotifyStaleQuotations },
  { name: "สัญญาเลยกำหนดรอบ", task: checkAndNotifyOverdueContracts },
  { name: "สัญญาใกล้หมดอายุ", task: checkAndNotifyExpiringContracts },
  { name: "ใบวางบิลเลยกำหนด", task: checkAndNotifyOverdueInvoices },
].forEach(({ name, task }) => scheduleDaily({ hour: NOTIFY_HOUR, name, task }));







// require("dotenv").config(); // เรียกใช้ dotenv เพื่อโหลด Environment Variables
// const express = require("express");
// const bodyParser = require("body-parser");
// const morgan = require('morgan');
// const axios = require("axios"); // นำเข้า axios
// const cors = require("cors");

// const authRouter = require("./routes/auth");
// const customerRouter = require("./routes/customer");
// const productRouter = require("./routes/product");
// const stockProductRouter = require("./routes/stockProduct");
// const fileRouter = require("./routes/file");
// const holidayRouter = require("./routes/fetchHolidays");
// const calendarEventRouter = require("./routes/calendarEvent");
// const checkInternetConnection = require('./middleware/checkInternetConnection');

// const app = express();
// const PORT = process.env.PORT || 5000;

// const corsOptions = {
//   origin: [
//     "https://da-app.vercel.app",
//     "http://localhost:3000",
//   ],
//   credentials: true,
// };

// app.use(morgan("dev"));
// app.use(cors(corsOptions)); // ใช้ corsOptions


// app.use(bodyParser.json());
// app.use(bodyParser.urlencoded({ extended: false }));

// app.use("/api/auth", authRouter);
// app.use("/api/customer", customerRouter);
// app.use("/api/product", productRouter);
// app.use("/api/stockproduct", stockProductRouter);
// app.use("/api/files", fileRouter);
// app.use("/api/events", calendarEventRouter);
// app.use("/api/holidays", holidayRouter);

// // ใช้ middleware ตรวจสอบการเชื่อมต่ออินเทอร์เน็ต
// app.use(checkInternetConnection);

// app.use("/uploads", express.static("asset/uploads"));

// // app.use(
// //   "/api/asset/uploads/images",
// //   express.static(__dirname + "/asset/uploads/images")
// // );
// app.use(
//   "/api/asset/uploads/files",
//   express.static(__dirname + "/asset/uploads/files")
// );
// app.use("/api/asset/image", express.static(__dirname + "/asset/image"));

// app.listen(PORT, () => {
//   console.log(`Server is running on port ${PORT}`);
// });
