// ✅ Backfill ครั้งเดียว: เติมค่า responsiblePerson/responsiblePersonId ให้งานเก่าทุกงานที่ยังไม่เคย
// ตั้งค่านี้เลย (สร้างก่อนฟีเจอร์ "ผู้รับผิดชอบ" แยกจาก team) โดยใช้ค่า team/resPerson เดิมของ
// แต่ละงานเป็นค่าเริ่มต้น — เดิมฝั่งจอมี fallback (head.responsiblePerson || head.team) อยู่แล้วตอนแสดงผล
// แต่ยังไม่เคยเขียนค่าจริงลง DB เลย พอผู้ใช้ต้องการให้ "ผู้รับผิดชอบ" กลายเป็นค่าจริงในฐานข้อมูลตั้งแต่
// ต้น (ไม่ใช่แค่ fallback ตอนแสดงผล) จึงต้องรันสคริปต์นี้เติมให้ครบสักครั้ง — งานที่สร้างใหม่หลังจากนี้
// ไม่ต้องรันซ้ำ เพราะ backend ตั้งค่า responsiblePerson ให้จริงตั้งแต่ต้นอยู่แล้ว (ดู POST /events,
// POST /events/draft)
// วิธีใช้: npm run backfill-responsible-person   (จะเชื่อมต่อ DB ตามค่า APP_DATABASE ใน .env ที่ active อยู่ตอนรัน)
require("dotenv").config();
const mongoose = require("../src/db");
const CalendarEvent = require("../src/models/Events");

(async () => {
  try {
    await mongoose.connection.asPromise();
    console.log(`🔎 เชื่อมต่อฐานข้อมูล: ${mongoose.connection.host}/${mongoose.connection.name}`);

    const filter = {
      team: { $exists: true, $ne: "" },
      $or: [{ responsiblePerson: { $exists: false } }, { responsiblePerson: "" }],
    };

    const toUpdate = await CalendarEvent.countDocuments(filter);
    console.log(`📋 พบงานที่ต้อง backfill: ${toUpdate} รายการ`);

    if (toUpdate === 0) {
      console.log("✅ ไม่มีงานที่ต้อง backfill");
      return;
    }

    // ✅ ใช้ aggregation-pipeline update (updateMany รับ array ได้ตั้งแต่ MongoDB 4.2+) เพื่อ set ค่า
    // จากฟิลด์อื่นในเอกสารเดียวกัน (team → responsiblePerson, resPerson → responsiblePersonId)
    // โดยไม่ต้องวน bulkWrite ทีละ document
    const result = await CalendarEvent.updateMany(filter, [
      {
        $set: {
          responsiblePerson: "$team",
          responsiblePersonId: { $ifNull: ["$resPerson", ""] },
        },
      },
    ]);
    console.log(`✅ Backfill สำเร็จ: อัปเดต ${result.modifiedCount} รายการ`);
  } catch (err) {
    console.error("❌ ล้มเหลว:", err.message);
  } finally {
    await mongoose.connection.close();
    process.exit(0);
  }
})();
