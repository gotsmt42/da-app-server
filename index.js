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
const { checkAndNotifyOverdueJobs, checkAndNotifyStaleQuotations, checkAndNotifyOverdueContracts } = require("./services/OverdueReminder");





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

// ✅ เช็คงานค้างเกิน 1 สัปดาห์ แล้วส่ง push แจ้งเตือนช่างที่รับผิดชอบผ่านหน้าจอจริง (ไม่ใช่แค่ badge
// ในแอป) เป็นระยะๆ — รันครั้งแรกหลังเซิร์ฟเวอร์พร้อม 2 นาที (รอ DB connect) แล้วเช็คซ้ำทุก 24 ชม.
// ⚠️ setTimeout/setInterval นับจาก "เวลาที่โปรเซสเริ่มทำงาน" — ทุกครั้งที่ deploy/รีสตาร์ท นาฬิกาจะ
// เริ่มนับใหม่แล้วยิงรอบใหม่ใน 2 นาทีเสมอ วันที่แก้โค้ดหลายรอบผู้ใช้จึงเคยโดนแจ้งเรื่องเดิมซ้ำทั้งวัน
// ✅ ตอนนี้กันซ้ำที่ "ชั้นส่ง" ด้วย NotifyLog.claimOncePerDay (1 เรื่อง : 1 ผู้รับ : 1 วัน) ซึ่งเก็บไว้ที่
// ฐานข้อมูล จึงอยู่รอดข้ามการรีสตาร์ท — การรันตอนเริ่มโปรเซสเลยกลายเป็น "ข้อดี" (ถ้าเซิร์ฟเวอร์ดับคร่อม
// รอบประจำวัน พอกลับมาก็ยังได้แจ้งของวันนั้น) แทนที่จะเป็นต้นเหตุของการแจ้งซ้ำแบบเดิม
setTimeout(checkAndNotifyOverdueJobs, 2 * 60 * 1000);
setInterval(checkAndNotifyOverdueJobs, 24 * 60 * 60 * 1000);

// ✅ เช็คใบเสนอราคาที่ส่งลูกค้าไปแล้วเกิน 3 วันยังไม่ได้บันทึกผล แจ้งเตือนแอดมิน/manager เป็นระยะๆ
// (ระบบติดตามใบเสนอราคา หน้า /quotations) — เทียบ pattern เดียวกับตัวเช็คงานค้างด้านบน
setTimeout(checkAndNotifyStaleQuotations, 2 * 60 * 1000);
setInterval(checkAndNotifyStaleQuotations, 24 * 60 * 60 * 1000);

// ✅ เช็คสัญญาที่เลยกำหนดรอบถัดไปแล้วแต่ยังไม่ได้ลงแผนงาน แจ้งเตือนแอดมิน/manager เป็นระยะๆ (หน้า
// "ภาพรวมงาน" /contracts) — เทียบ pattern เดียวกับ 2 ตัวด้านบน
setTimeout(checkAndNotifyOverdueContracts, 2 * 60 * 1000);
setInterval(checkAndNotifyOverdueContracts, 24 * 60 * 60 * 1000);







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
