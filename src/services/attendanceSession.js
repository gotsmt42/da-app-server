/**
 * attendanceSession.js — บันทึกเข้างานต้องอยู่ "ช่วงวันที่" ที่ครอบคลุมวันนั้นจริง (งานเดียวแบ่งหลายช่วง = jobGroupId)
 *
 * 🐛 (11 พ.ย. 2569 ผู้ใช้: "การบันทึกเข้างานยังผิดพลาด ทำไมบันทึกงานของอีกวันช่วงนี้ ไปขึ้นอีกช่วง")
 *    สาเหตุ: เช็คอินบันทึกลงงาน (eventId) ของการ์ดที่กดเสมอ — เปิดการ์ดช่วง 3–6 พ.ย. แล้วกดเข้างานวันที่ 10 พ.ย.
 *    ระบบรับไว้เป็น "นอกแผน" ของช่วงนั้น ทั้งที่วันที่ 10 อยู่ในช่วง 9–13 พ.ย. ของงานเดียวกัน (รูปตอนเข้างานติดไปด้วย)
 *    ✅ 1) เช็คอินใหม่: วันนี้ไม่อยู่ในช่วงของการ์ดที่กด แต่มีช่วงอื่นของงานเดียวกันครอบคลุม → บันทึกลงช่วงนั้น (ย้ายรูปตามไป)
 *    ✅ 2) ข้อมูลเดิม: บันทึกที่ติดป้ายนอกแผน และมี "ช่วงเดียว" ของงานเดียวกันครอบคลุมวันนั้น → ย้ายไปช่วงนั้น
 *          (ย้ายรูปตอนเข้างาน · บันทึกประวัติทั้งสองช่วง) — ทำตอนเปิดดูบันทึกเข้างาน ไม่ต้องสั่งเอง
 *    ⚠️ ไม่ย้ายถ้าช่วงปลายทางมีบันทึกของคนเดียวกันวันเดียวกันอยู่แล้ว (กันซ้ำ) หรือครอบคลุมได้มากกว่า 1 ช่วง (กำกวม)
 */
const Attendance = require("../models/Attendance");
const CalendarEvent = require("../models/Events");

const bkkDay = (d) => new Date(new Date(d).getTime() + 7 * 3600 * 1000).toISOString().slice(0, 10);
const addDays = (day, n) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** ช่วงวันนัดของงาน (วันไทย) — สูตรเดียวกับการนับ "นอกวันนัด" ใน routes/attendance.js */
function dayRange(ev) {
  const first = bkkDay(ev.start || ev.date);
  const lastRaw = ev.end ? addDays(bkkDay(ev.end), ev.allDay ? -1 : 0) : first;
  return { first, last: lastRaw < first ? first : lastRaw };
}
const covers = (ev, day) => {
  const r = dayRange(ev);
  return day >= r.first && day <= r.last;
};
const rangeLabel = (ev) => {
  const r = dayRange(ev);
  const f = (d) => new Date(`${d}T00:00:00+07:00`).toLocaleDateString("th-TH", { timeZone: "Asia/Bangkok", day: "numeric", month: "short" });
  return r.first === r.last ? f(r.first) : `${f(r.first)} – ${f(r.last)}`;
};

const SIBLING_SELECT = "_id jobGroupId start end allDay date unscheduled cancelledAt status team resPerson responsiblePersonId responsiblePerson teamMembers";

/** ช่วงอื่นของงานเดียวกันที่ครอบคลุมวันนั้น — คืนเฉพาะเมื่อมี "ช่วงเดียว" (มากกว่านั้นถือว่ากำกวม ไม่เดา) */
async function coveringSibling(ev, day) {
  if (!ev?.jobGroupId) return null;
  const sibs = await CalendarEvent.find({ jobGroupId: ev.jobGroupId, _id: { $ne: ev._id }, unscheduled: { $ne: true }, cancelledAt: null })
    .select(SIBLING_SELECT).lean();
  const hit = sibs.filter((s) => covers(s, day));
  return hit.length === 1 ? hit[0] : null;
}

/** ย้ายไฟล์ในช่อง "ไฟล์แนบ/รูปหน้างาน" (sitePhotoFiles) ตาม _id จากงานหนึ่งไปอีกงาน — คืนจำนวนที่ย้าย */
async function moveSitePhotos(fromId, toId, fileIds) {
  const ids = new Set((fileIds || []).map(String));
  if (!ids.size || String(fromId) === String(toId)) return 0;
  const from = await CalendarEvent.findById(fromId).select("sitePhotoFiles").lean();
  const files = (from?.sitePhotoFiles || []).filter((f) => ids.has(String(f._id)));
  if (!files.length) return 0;
  await CalendarEvent.updateOne({ _id: toId }, { $push: { sitePhotoFiles: { $each: files } } });
  await CalendarEvent.updateOne({ _id: fromId }, { $pull: { sitePhotoFiles: { _id: { $in: files.map((f) => f._id) } } } });
  return files.length;
}

/** ให้ checkedInAt ของงานตรงกับบันทึกจริง (เช็คอินแรกสุด) หลังย้ายบันทึก */
async function syncCheckedIn(eventId) {
  const rows = await Attendance.find({ eventId }).select("checkIn.at").lean();
  const ins = rows.map((r) => r.checkIn?.at).filter(Boolean).map((d) => new Date(d).getTime());
  await CalendarEvent.updateOne({ _id: eventId }, { $set: { checkedInAt: ins.length ? new Date(Math.min(...ins)) : null } });
}

/**
 * ซ่อมบันทึกที่อยู่ผิดช่วง — ส่งแถวที่ "นอกแผน" มา (เร็ว: ปกติมีน้อยมาก)
 * @returns {Promise<number>} จำนวนบันทึกที่ย้าย
 */
async function healOffSchedule(rows) {
  const cand = (rows || []).filter((r) => r?.offSchedule && r.jobGroupId && r.checkIn?.at);
  if (!cand.length) return 0;
  const groups = [...new Set(cand.map((r) => r.jobGroupId))];
  const sibs = await CalendarEvent.find({ jobGroupId: { $in: groups }, unscheduled: { $ne: true }, cancelledAt: null }).select(SIBLING_SELECT).lean();
  const byGroup = new Map();
  sibs.forEach((s) => { if (!byGroup.has(s.jobGroupId)) byGroup.set(s.jobGroupId, []); byGroup.get(s.jobGroupId).push(s); });
  const touched = new Set();
  let moved = 0;
  for (const r of cand) {
    const day = bkkDay(r.checkIn.at);
    const list = byGroup.get(r.jobGroupId) || [];
    const own = list.find((s) => String(s._id) === String(r.eventId));
    if (own && covers(own, day)) continue;
    const hit = list.filter((s) => String(s._id) !== String(r.eventId) && covers(s, day));
    if (hit.length !== 1) continue;
    const target = hit[0];
    const clash = await Attendance.exists({ _id: { $ne: r._id }, eventId: target._id, userId: r.userId, $or: [{ workDay: day }, { "checkIn.at": { $gte: new Date(`${day}T00:00:00+07:00`), $lt: new Date(`${addDays(day, 1)}T00:00:00+07:00`) } }] });
    if (clash) continue;
    const res = await Attendance.updateOne({ _id: r._id, eventId: r.eventId }, { $set: { eventId: target._id, offSchedule: false, workDay: day } });
    if (!res.modifiedCount) continue;
    await moveSitePhotos(r.eventId, target._id, (r.checkIn.photos || []).map((p) => p.fileId));
    const note = `ย้ายบันทึกเข้างานของ ${r.userName || "-"} วันที่ ${day} ไปช่วง ${rangeLabel(target)} (ช่วงที่ครอบคลุมวันนั้น)`;
    const log = { userId: "system", userName: "ระบบ", action: "check_in_moved", timestamp: new Date(), detail: note };
    await CalendarEvent.updateMany({ _id: { $in: [r.eventId, target._id] } }, { $push: { activityLog: log } });
    touched.add(String(r.eventId)); touched.add(String(target._id));
    moved += 1;
  }
  await Promise.all([...touched].map(syncCheckedIn));
  return moved;
}

module.exports = { bkkDay, dayRange, covers, rangeLabel, coveringSibling, moveSitePhotos, healOffSchedule };
