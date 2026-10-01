/**
 * ผู้รับผิดชอบระดับ "งาน" (สัญญา / โปรเจค / งานหลายวัน) — ให้ทุกวัน/ทุกครั้งในกลุ่มเดียวกันมีผู้รับผิดชอบคนเดียวกันเสมอ
 *
 * 🐛 ปัญหาเดิม: หน้า "ภาพรวมงาน" แสดงผู้รับผิดชอบจาก "ครั้งที่ 1" ของกลุ่ม (ดู groupEventsByContract ฝั่งแอป)
 *    แต่หน้าแก้ไขงาน/สิทธิ์/แจ้งเตือนอ่านจาก document ของตัวเองทีละใบ — ครั้งที่เพิ่มทีหลัง (หลังมอบหมายไปแล้ว)
 *    ไม่ได้รับค่านั้นมา บางใบว่าง (หน้างานไปแสดงชื่อทีมแทน) บางใบเป็นชื่อคนที่กดเพิ่ม ผลคือแต่ละครั้งของ
 *    สัญญาเดียวกันขึ้นผู้รับผิดชอบไม่ตรงกับภาพรวมงาน
 * ✅ ภาพรวมงานเป็นตัวตั้ง: ค่าของ "หัวกลุ่ม" (ครั้งที่น้อยสุด แล้ววันที่เร็วสุด) คือค่าของทั้งกลุ่ม
 *
 * กลุ่ม = contractGroupId ถ้ามี ไม่งั้น jobGroupId — ลำดับเดียวกับ key ใน groupEventsByContract
 */
const CalendarEvent = require("../models/Events");

const groupFilterOf = (doc) => {
  if (doc?.contractGroupId) return { contractGroupId: String(doc.contractGroupId) };
  if (doc?.jobGroupId) return { jobGroupId: String(doc.jobGroupId) };
  return null;
};

/** เรียงแบบเดียวกับหน้าภาพรวมงาน — ครั้งที่ (time) ก่อน แล้ววันที่ */
const byRound = (a, b) =>
  (Number(a.time) || 0) - (Number(b.time) || 0) ||
  (new Date(a.start || a.date || 0) - new Date(b.start || b.date || 0)) ||
  String(a._id).localeCompare(String(b._id));

/**
 * ผู้รับผิดชอบของกลุ่ม: ค่าของหัวกลุ่ม — ถ้าหัวกลุ่มยังว่างแต่ใบอื่นมีแล้ว ใช้ใบแรกที่มี
 * (ไม่งั้นภาพรวมงานจะขึ้น "ยังไม่มอบหมาย" ทั้งที่มีคนถูกมอบหมายไว้แล้ว)
 */
const pickResponsible = (docs) => {
  const sorted = docs.slice().sort(byRound);
  const owner = sorted.find((d) => d.responsiblePerson) || null;
  return owner ? { responsiblePerson: owner.responsiblePerson, responsiblePersonId: owner.responsiblePersonId || "" } : null;
};

/**
 * ทำให้ทั้งกลุ่มมีผู้รับผิดชอบเดียวกัน
 * @param filter ตัวกรองกลุ่มจาก groupFilterOf
 * @param forced ถ้าระบุ = ค่าที่เพิ่งถูกมอบหมาย (ชนะค่าเดิมของกลุ่ม)
 * @returns จำนวน document ที่ถูกแก้
 */
async function syncGroupResponsible(filter, forced = null) {
  if (!filter) return 0;
  const docs = await CalendarEvent.find({ ...filter, isHoliday: { $ne: true } })
    .select("_id time start date responsiblePerson responsiblePersonId").lean();
  if (docs.length < 2 && !forced) return 0;
  const target = forced || pickResponsible(docs);
  if (!target) return 0;
  const stale = docs.filter((d) =>
    (d.responsiblePerson || "") !== (target.responsiblePerson || "") ||
    (d.responsiblePersonId || "") !== (target.responsiblePersonId || ""));
  if (!stale.length) return 0;
  await CalendarEvent.updateMany(
    { _id: { $in: stale.map((d) => d._id) } },
    { $set: { responsiblePerson: target.responsiblePerson || "", responsiblePersonId: target.responsiblePersonId || "" } },
  );
  return stale.length;
}

/** sync ทุกกลุ่มที่ document ชุดนี้สังกัด (ซ้ำกันนับครั้งเดียว) — ไม่ throw ให้ route ที่เรียกล้ม */
async function syncGroupsOf(docs) {
  const seen = new Set();
  let changed = 0;
  for (const d of [].concat(docs || [])) {
    const f = groupFilterOf(d);
    if (!f) continue;
    const key = JSON.stringify(f);
    if (seen.has(key)) continue;
    seen.add(key);
    try { changed += await syncGroupResponsible(f); }
    catch (err) { console.error("⚠️ sync ผู้รับผิดชอบของกลุ่มไม่สำเร็จ:", err.message); }
  }
  return changed;
}

/** ซ่อมข้อมูลเก่าทั้งฐานข้อมูล — รันตอนเซิร์ฟเวอร์เริ่ม (รันซ้ำได้ ไม่มีอะไรเปลี่ยนถ้าตรงกันอยู่แล้ว) */
async function repairAllGroupResponsible({ log = true } = {}) {
  const docs = await CalendarEvent.find({
    isHoliday: { $ne: true },
    $or: [{ contractGroupId: { $nin: [null, ""] } }, { jobGroupId: { $nin: [null, ""] } }],
  }).select("_id contractGroupId jobGroupId").lean();
  const changed = await syncGroupsOf(docs);
  if (log && changed) console.log(`✅ ปรับผู้รับผิดชอบให้ตรงกับภาพรวมงาน ${changed} รายการ`);
  return changed;
}

module.exports = { groupFilterOf, pickResponsible, syncGroupResponsible, syncGroupsOf, repairAllGroupResponsible, byRound };
