// สคริปต์บังคับให้ผู้ใช้ทุกคนต้อง login ใหม่ (invalidate token เก่าทั้งหมด)
// ใช้ตอน deploy ขึ้น production จริง หรือเมื่อต้องการเตะทุก session ออกทันที
// วิธีใช้: npm run force-logout-all   (จะเชื่อมต่อ DB ตามค่า APP_DATABASE ใน .env ที่ active อยู่ตอนรัน)
require("dotenv").config();
const mongoose = require("../db/");
const User = require("../models/User");

(async () => {
  try {
    await mongoose.connection.asPromise();
    console.log(`🔎 เชื่อมต่อฐานข้อมูล: ${mongoose.connection.host}/${mongoose.connection.name}`);

    const result = await User.updateMany({}, { $inc: { sessionVersion: 1 } });
    console.log(`✅ บังคับให้ผู้ใช้ ${result.modifiedCount} คน login ใหม่เรียบร้อย (token เก่าทั้งหมดใช้ไม่ได้แล้ว)`);
  } catch (err) {
    console.error("❌ ล้มเหลว:", err.message);
  } finally {
    await mongoose.connection.close();
    process.exit(0);
  }
})();
