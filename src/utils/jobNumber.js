/**
 * เลข Job อัตโนมัติ — "JOB-00001/2569" รันใหม่ทุกปี พ.ศ. (รูปแบบเดียวกับใบแจ้งงาน WO-00001/2569)
 * ✅ ผู้ใช้เลือก 9 ต.ค. 2569 · ใช้ DocCounter (เพิ่มค่าแบบ atomic) กันเลขซ้ำตอนสร้างพร้อมกัน
 * ⚠️ งานหลายวัน (jobGroupId เดียวกัน) = งานเดียว ใช้เลขเดียวกันเสมอ
 */
const DocCounter = require("../models/DocCounter");

const buddhistYear = (d = new Date()) => new Date(d).getFullYear() + 543;

async function nextJobNo(at = new Date()) {
  const year = buddhistYear(at);
  const c = await DocCounter.findOneAndUpdate(
    { key: `job:${year}` },
    { $inc: { seq: 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
  return `JOB-${String(c.seq).padStart(5, "0")}/${year}`;
}

/** เลขของกลุ่มงานเดิม (ถ้ามี) — ใช้ตอนเพิ่มวันเข้างานหลายวันที่มีอยู่แล้ว */
async function groupJobNo(jobGroupId, excludeId) {
  if (!jobGroupId) return "";
  const CalendarEvent = require("../models/Events");
  const q = { jobGroupId, jobNo: { $nin: [null, ""] } };
  if (excludeId) q._id = { $ne: excludeId };
  const sib = await CalendarEvent.findOne(q).select("jobNo").lean();
  return sib?.jobNo || "";
}

async function assignJobNo(doc) {
  doc.jobNo = (await groupJobNo(doc.jobGroupId, doc._id)) || (await nextJobNo());
  return doc.jobNo;
}

module.exports = { nextJobNo, groupJobNo, assignJobNo, buddhistYear };
