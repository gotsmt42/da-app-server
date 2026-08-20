const mongoose = require("mongoose");

/**
 * การเชื่อมต่อ MongoDB
 *
 * 🐛 ปัญหาที่แก้ (อาการ: หน้าเว็บเปิดได้ ล็อกอินค้างอยู่ แต่ "ทุก API ตอบ 500" หาสาเหตุไม่เจอ):
 * เดิมเขียนว่า `.catch(err => console.error('Connection error', err))` เฉยๆ — ต่อ DB ไม่ได้แล้ว
 * แอปก็ยังบูตขึ้นปกติเหมือนไม่มีอะไรผิด เซิร์ฟเวอร์ตอบ 200 ให้ทุก endpoint ที่ไม่แตะ DB
 * ส่วน endpoint ที่แตะ DB จะไปค้างที่ mongoose buffer 10 วินาที แล้วโยน error ออกมาเป็น 500 เปล่าๆ
 * ทำให้เข้าใจผิดว่า "โค้ดพัง" ทั้งที่จริงคือ "ต่อฐานข้อมูลไม่ได้"
 *
 * ตอนนี้:
 *   • log บอกชัดว่าต่อไม่ได้เพราะอะไร พร้อมรายการสาเหตุที่เจอบ่อย
 *   • คอยรายงานทุกครั้งที่หลุด/กลับมาต่อได้ (ไม่ใช่รู้แค่ตอนบูต)
 *   • มี isDbConnected() ให้ /api/health เรียกดูสถานะจริงได้
 */
const uri = process.env.APP_DATABASE;

mongoose
  .connect(uri, {
    // ⚠️ ไม่ต้องรอ 30 วิ (ค่าเริ่มต้น) กว่าจะยอมแพ้ — รู้เร็วดีกว่าค้างนาน
    serverSelectionTimeoutMS: 10000,
  })
  .then(() => {
    const { host, name } = mongoose.connection;
    console.log(`✅ Connected to MongoDB — ${host}/${name}`);
  })
  .catch((err) => {
    console.error("");
    console.error("❌ ต่อ MongoDB ไม่ได้ — แอปจะบูตขึ้นแต่ทุก API ที่อ่าน/เขียนข้อมูลจะตอบ 500");
    console.error(`   สาเหตุ: ${err.message}`);
    console.error("");
    console.error("   ที่เจอบ่อย:");
    console.error("     1. MongoDB Atlas → Network Access ไม่ได้อนุญาต IP ของเซิร์ฟเวอร์");
    console.error("        (Render ไม่มี IP ตายตัวในแผนฟรี → ต้องใส่ 0.0.0.0/0)");
    console.error("        ⚠️ รายการ IP แบบชั่วคราวใน Atlas จะหมดอายุเองใน 6 ชั่วโมง");
    console.error("     2. APP_DATABASE ผิด — รหัสผ่านเปลี่ยน / ไม่ได้ใส่ชื่อ database ต่อท้าย");
    console.error("     3. ผู้ใช้ในฐานข้อมูลถูกลบหรือเปลี่ยนสิทธิ์");
    console.error("");
  });

// รายงานเมื่อการเชื่อมต่อหลุด/กลับมา — เดิมรู้แค่ตอนบูตครั้งเดียว
mongoose.connection.on("disconnected", () => console.warn("⚠️  MongoDB หลุดการเชื่อมต่อ"));
mongoose.connection.on("reconnected", () => console.log("✅ MongoDB กลับมาเชื่อมต่อแล้ว"));

/** true เมื่อพร้อมใช้งานจริง (readyState 1 = connected) */
const isDbConnected = () => mongoose.connection.readyState === 1;

module.exports = mongoose;
module.exports.isDbConnected = isDbConnected;
