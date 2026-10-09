/**
 * ✅ (9 ต.ค. 2569 ผู้ใช้เลือก "ลบเลขออกจากงานเก่า") เลข Job มีเฉพาะงานที่รับผ่านเมนู "รับงาน"
 * รอบก่อนเคยออกเลขย้อนหลังให้งานเดิมทุกงาน — ล้างทิ้งครั้งเดียว แล้วเริ่มนับใหม่ JOB-00001/2569
 * ⚠️ ทำครั้งเดียว (จดไว้ใน DocCounter key "migr:jobno-reset-v1") — รอบถัดไปไม่แตะงานใหม่ที่ได้เลขแล้ว
 */
const CalendarEvent = require("../models/Events");
const DocCounter = require("../models/DocCounter");

const FLAG = "migr:jobno-reset-v1";

async function resetLegacyJobNumbers() {
  if (await DocCounter.findOne({ key: FLAG }).lean()) return 0;
  const res = await CalendarEvent.updateMany(
    { jobNo: { $nin: [null, ""] }, intakeAt: null },
    { $unset: { jobNo: "" } },
  );
  const stillNumbered = await CalendarEvent.countDocuments({ jobNo: { $nin: [null, ""] } });
  if (!stillNumbered) await DocCounter.deleteMany({ key: /^job:/ });
  await DocCounter.create({ key: FLAG, seq: 1 });
  const n = res.modifiedCount || 0;
  if (n) console.log(`🔢 ล้างเลข Job ของงานเก่า ${n} รายการ`);
  return n;
}

module.exports = { resetLegacyJobNumbers };
