/**
 * ✅ (9 ต.ค. 2569) ออกเลข Job ให้งานเดิมที่ยังไม่มีเลข — เรียงตามวันที่สร้าง · ปีของเลข = ปีที่สร้างงาน
 * งานหลายวัน (jobGroupId เดียวกัน) ได้เลขเดียวกัน · นัดฝ่ายขายไม่มีเลข Job
 * ⚠️ รันซ้ำได้ (ข้ามงานที่มีเลขแล้ว) — เรียกตอนเซิร์ฟเวอร์เริ่มทำงาน ไม่ต้อง await
 */
const CalendarEvent = require("../models/Events");
const { nextJobNo } = require("../utils/jobNumber");

async function migrateJobNumbers() {
  const rows = await CalendarEvent.find({ jobNo: { $in: [null, ""] }, department: { $ne: "sales" } })
    .select("_id jobGroupId createdAt").sort({ createdAt: 1, _id: 1 }).lean();
  if (!rows.length) return 0;
  const byGroup = new Map();
  let n = 0;
  for (const r of rows) {
    let no = r.jobGroupId ? byGroup.get(r.jobGroupId) : "";
    if (!no && r.jobGroupId) {
      const sib = await CalendarEvent.findOne({ jobGroupId: r.jobGroupId, jobNo: { $nin: [null, ""] } }).select("jobNo").lean();
      no = sib?.jobNo || "";
    }
    if (!no) no = await nextJobNo(r.createdAt || new Date());
    if (r.jobGroupId) byGroup.set(r.jobGroupId, no);
    await CalendarEvent.updateOne({ _id: r._id }, { $set: { jobNo: no } });
    n += 1;
  }
  console.log(`🔢 ออกเลข Job ให้งานเดิม ${n} รายการ`);
  return n;
}

module.exports = { migrateJobNumbers };
