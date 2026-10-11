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

/**
 * ✅ (11 ต.ค. 2569 ผู้ใช้: "งานเก่าๆ อยากให้มีเลข Job เหมือนงานที่ลงใหม่ ... ให้เรียงลำดับด้วย")
 * ออกเลข Job ใหม่ทั้งระบบครั้งเดียว — ทุกงานที่ไม่ใช่นัดฝ่ายขาย เรียงตามเวลาที่สร้างงาน (createdAt)
 * รันเลขใหม่ทุกปี พ.ศ. ของวันที่สร้าง · งานหลายวันกลุ่มเดียวกันได้เลขเดียวกัน · ตั้งตัวนับต่อจากเลขสุดท้าย
 * ⚠️ งานที่เคยมีเลขจากเมนูรับงานจะได้เลขใหม่ตามลำดับจริง (ให้ทั้งระบบเรียงต่อเนื่องกัน)
 */
const FLAG_ALL = "migr:jobno-all-v1";
async function numberAllJobs() {
  if (await DocCounter.findOne({ key: FLAG_ALL }).lean()) return 0;
  const rows = await CalendarEvent.find({ department: { $ne: "sales" } })
    .select("_id jobGroupId createdAt").sort({ createdAt: 1, _id: 1 }).lean();
  const groupNo = new Map();
  const seqByYear = new Map();
  const ops = [];
  for (const r of rows) {
    const key = r.jobGroupId || String(r._id);
    if (!groupNo.has(key)) {
      const year = new Date(r.createdAt || Date.now()).getFullYear() + 543;
      const seq = (seqByYear.get(year) || 0) + 1;
      seqByYear.set(year, seq);
      groupNo.set(key, `JOB-${String(seq).padStart(5, "0")}/${year}`);
    }
    ops.push({ updateOne: { filter: { _id: r._id }, update: { $set: { jobNo: groupNo.get(key) } } } });
  }
  for (let i = 0; i < ops.length; i += 500) await CalendarEvent.bulkWrite(ops.slice(i, i + 500), { ordered: false });
  for (const [year, seq] of seqByYear) {
    await DocCounter.updateOne({ key: `job:${year}` }, { $set: { seq } }, { upsert: true });
  }
  await DocCounter.create({ key: FLAG_ALL, seq: 1 });
  console.log(`🔢 ออกเลข Job ให้งานทั้งหมด ${groupNo.size} งาน (${rows.length} รายการ)`);
  return groupNo.size;
}

module.exports = { resetLegacyJobNumbers, numberAllJobs };
