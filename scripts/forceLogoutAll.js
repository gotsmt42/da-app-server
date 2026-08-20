// สคริปต์บังคับให้ผู้ใช้ทุกคนต้อง login ใหม่ (invalidate token เก่าทั้งหมด)
// ใช้ตอน deploy ขึ้น production จริง หรือเมื่อต้องการเตะทุก session ออกทันที
//
// วิธีใช้:  npm run force-logout-all -- --yes
//          (จะเชื่อมต่อ DB ตามค่า APP_DATABASE ใน .env ที่ active อยู่ตอนรัน)
//
// 🐛 ที่แก้: เดิมโค้ดส่วนที่ทำงานจริงถูกคอมเมนต์ทิ้งไว้ทั้งหมด — สั่งรันแล้วมันแค่ต่อ DB, พิมพ์ชื่อฐาน
// ข้อมูล แล้ว "ค้างไปเฉยๆ" (ไม่ปิด connection ไม่ exit) ทั้งที่ชื่อคำสั่งบอกว่าเตะทุกคนออก — ใครที่
// เชื่อชื่อคำสั่งแล้วรันไป จะเข้าใจผิดว่าเตะ session ออกหมดแล้วทั้งที่ยังไม่มีอะไรเกิดขึ้นเลย
//
// ⚠️ ต้องใส่ --yes ถึงจะทำงานจริง — ตั้งใจให้เผลอรันแล้วไม่มีอะไรเกิดขึ้น (เท่ากับพฤติกรรมเดิม)
// เพราะนี่คือคำสั่งที่เตะผู้ใช้ทุกคนออกจากระบบพร้อมกัน ย้อนกลับไม่ได้
require("dotenv").config();
const mongoose = require("../src/db");
const User = require("../src/models/User");

const CONFIRMED = process.argv.includes("--yes");

(async () => {
  let exitCode = 0;
  try {
    await mongoose.connection.asPromise();
    console.log(`🔎 เชื่อมต่อฐานข้อมูล: ${mongoose.connection.host}/${mongoose.connection.name}`);

    if (!CONFIRMED) {
      const count = await User.countDocuments();
      console.log(`⚠️  ยังไม่ได้ทำอะไร — คำสั่งนี้จะบังคับให้ผู้ใช้ ${count} คนต้อง login ใหม่ทั้งหมด`);
      console.log('   ถ้าแน่ใจแล้วให้รัน:  npm run force-logout-all -- --yes');
      return;
    }

    const result = await User.updateMany({}, { $inc: { sessionVersion: 1 } });
    console.log(`✅ บังคับให้ผู้ใช้ ${result.modifiedCount} คน login ใหม่เรียบร้อย (token เก่าทั้งหมดใช้ไม่ได้แล้ว)`);
  } catch (err) {
    console.error("❌ ล้มเหลว:", err.message);
    exitCode = 1;
  } finally {
    // ⚠️ ต้องปิด connection เอง ไม่งั้น process ค้างไม่จบ (ปัญหาเดิมของสคริปต์นี้)
    await mongoose.connection.close().catch(() => {});
    process.exit(exitCode);
  }
})();
