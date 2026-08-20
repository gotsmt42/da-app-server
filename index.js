/**
 * จุดเริ่มของเซิร์ฟเวอร์
 *
 * ⚠️ ไฟล์นี้ต้องอยู่ที่ราก project และต้องชื่อ index.js — เป็นปลายทางของ "main" ใน package.json
 * และของ Start Command บน Render (`npm start` → `node index.js`) ย้าย/เปลี่ยนชื่อแล้ว deploy พัง
 *
 * ⚠️ ต้องเรียก dotenv.config() ที่นี่ "ก่อน" require อย่างอื่นทุกตัว เพราะ src/config/cloudinary.js
 * อ่าน process.env ตอนโหลดโมดูลทันที ถ้าสลับลำดับจะได้ค่าว่างโดยไม่มี error ให้เห็น
 * (บน Render ตัวแปรมาจาก Environment ในหน้าเว็บ ไม่ได้มาจากไฟล์ .env — .env ไม่ได้อยู่ใน git แล้ว)
 *
 * ตัวไฟล์ตั้งใจให้บางที่สุด: ซอร์สจริงทั้งหมดอยู่ใน src/
 *   src/app.js        ประกอบ Express app (middleware + routes + ไฟล์นิ่ง) แล้ว export ออกมา
 *   src/scheduler.js  ตั้งเวลางานแจ้งเตือนประจำวัน
 * แยกกันเพื่อให้ "แอปประกอบด้วยอะไร" กับ "แอปถูกรันยังไง" ไม่ปนกัน และเอา app ไปเทสต์ได้
 * โดยไม่ต้องเปิดพอร์ตจริง
 */
require("dotenv").config();

// ✅ ตรวจ env ให้ครบ "ก่อน" require อะไรก็ตามที่อ่าน process.env ตอนโหลดโมดูล
// (services/PushNotify.js เรียก webpush.setVapidDetails() ทันทีที่ถูก require — ถ้าค่าไม่มา
// มันจะโยน "No subject set in vapidDetails.subject" ซึ่งอ่านแล้วไม่รู้เลยว่าต้องไปตั้งอะไรที่ไหน)
require("./src/config/env").assertRequiredEnv();

const app = require("./src/app");
const { startSchedulers } = require("./src/scheduler");

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`🚀 Server is running on port ${PORT}`);
});

startSchedulers();
