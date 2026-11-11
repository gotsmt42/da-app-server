/**
 * crewAttendance.js — ทุกคนที่มีชื่อในทีมของงาน (หัวหน้าทีม + ลูกทีม) ต้องบันทึกเข้างานด้วยตัวเอง
 *
 * ✅ (11 พ.ย. 2569 ผู้ใช้: "บังคับช่างที่มีชื่ออยู่ในรายการงาน ต้องบันทึกลงงานของทุกคนเองด้วย ไม่ใช่แค่หัวหน้าทีม ทำให้สมบูรณ์")
 *    • ขอปิดงาน: ทุกคนในทีมต้องมีบันทึกเข้างานของตัวเองอย่างน้อย 1 ครั้ง (ทั้งงาน — ทุกช่วงวันของ jobGroupId)
 *      ใครไม่ได้ไปจริง ให้ผู้รับผิดชอบเอาชื่อออกจากทีมก่อน
 *    • คนแรกที่บันทึกเข้างานของวัน → แจ้งคนอื่นในทีมที่ยังไม่บันทึกให้กดของตัวเอง
 *    ⚠️ ไม่บังคับ: นัดฝ่ายขาย · งานไม่ต้องเข้าหน้างาน (noVisit) · งานเก่าก่อนเริ่มใช้การบันทึกรายคน (4 พ.ย. 2569)
 */
const Attendance = require("../models/Attendance");

const PER_PERSON_SINCE = new Date("2026-11-04T00:00:00+07:00");

/** รายชื่อทีม: หัวหน้าทีม (resPerson = userId · team = ชื่อ) + ลูกทีม (ไม่ซ้ำ) */
function crewOf(ev) {
  const out = [];
  const seen = new Set();
  const add = (userId, name) => {
    const n = String(name || "").trim();
    const k = userId ? `u:${userId}` : `n:${n}`;
    if (!n && !userId) return;
    if (seen.has(k) || (n && seen.has(`n:${n}`))) return;
    seen.add(k); if (n) seen.add(`n:${n}`);
    out.push({ userId: userId ? String(userId) : "", name: n });
  };
  if (ev.team || ev.resPerson) add(ev.resPerson, ev.team);
  (ev.teamMembers || []).forEach((m) => add(m?.userId, m?.name));
  return out;
}

const matches = (person, row) => (person.userId && String(row.userId) === person.userId)
  || (person.name && String(row.userName || "").startsWith(person.name));

/** งานนี้ต้องให้ทุกคนบันทึกเข้างานเองหรือไม่ */
const enforced = (ev) => ev && ev.department !== "sales" && !ev.noVisit && !ev.unscheduled
  && !(ev.createdAt && new Date(ev.createdAt) < PER_PERSON_SINCE);

/**
 * คนในทีมที่ยังไม่มีบันทึกเข้างาน
 * @param {object} ev  งาน (ต้องมี team/resPerson/teamMembers/jobGroupId)
 * @param {object} [opts.range] { from: Date, to: Date } — จำกัดเฉพาะช่วงเวลา (เช่น วันนี้) · ไม่ส่ง = ทั้งงาน
 * @returns {Promise<{crew: Array, done: Array, missing: Array}>}
 */
async function crewStatus(ev, { range } = {}) {
  const crew = crewOf(ev);
  if (!crew.length) return { crew, done: [], missing: [] };
  const q = ev.jobGroupId ? { jobGroupId: ev.jobGroupId } : { eventId: ev._id };
  if (range) q["checkIn.at"] = { $gte: range.from, $lt: range.to };
  const rows = await Attendance.find(q).select("userId userName").lean();
  const done = crew.filter((p) => rows.some((r) => matches(p, r)));
  const missing = crew.filter((p) => !rows.some((r) => matches(p, r)));
  return { crew, done, missing };
}

module.exports = { crewOf, crewStatus, enforced, PER_PERSON_SINCE };
