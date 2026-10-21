/**
 * dispatchJobSync — ให้ใบแจ้งงาน (Dispatch) ตรงกับงานในตารางจริงเสมอ
 *
 * 🐛 (21 ต.ค. 2569 ผู้ใช้: "ตรวจสอบงานที่โดนลบหรือผิดเพี้ยน ให้ตรงตามจริง แบบนี้สับสน")
 *    เดิมลบงานในตารางแล้วใบแจ้งงานยังค้างสถานะ "ลงแผนงานแล้ว" ทั้งที่ไม่มีงานจริง
 *    (หน้าคำขอลงงานขึ้น "ยังไม่ลงวัน · ยังไม่มอบหมาย" อยู่ในแท็บลงแผนงานแล้ว)
 * ✅ ลบงาน → ถ้างานหลายช่วงวันยังมีช่วงอื่นเหลือ ย้ายไปผูกช่วงแรกที่เหลือ · ไม่เหลือ = ใบกลับมารอลงแผนงาน
 * ✅ ข้อมูลเก่าที่ค้างอยู่แล้ว — ซ่อมตอนอ่านรายการ (repairOrphans)
 */
const Dispatch = require("../models/Dispatch");
const CalendarEvent = require("../models/Events");

const log = (action, detail, user) => ({
  action, detail,
  userId: user?._id ? String(user._id) : user?.userId ? String(user.userId) : "",
  userName: user?.fname || user?.username || "ระบบ",
  timestamp: new Date(),
});

/** หลังลบงาน (ส่ง event ที่ถูกลบมา) */
async function releaseDispatchOfEvent(ev, user) {
  if (!ev?._id) return;
  const docs = await Dispatch.find({ eventId: ev._id });
  if (!docs.length) return;
  const sibling = ev.jobGroupId
    ? await CalendarEvent.findOne({ jobGroupId: ev.jobGroupId, _id: { $ne: ev._id } }).sort({ start: 1, date: 1 }).select("_id").lean()
    : null;
  for (const d of docs) {
    if (sibling) {
      d.eventId = sibling._id;
      d.activityLog.push(log("job_relinked", "ช่วงวันที่ผูกไว้ถูกลบ — ผูกกับช่วงวันที่เหลือของงานเดียวกัน", user));
    } else {
      d.eventId = undefined;
      d.activityLog.push(log("job_deleted", "งานในตารางถูกลบ — ใบนี้กลับมารอลงแผนงาน", user));
    }
    d.recomputeStatus();
    await d.save();
  }
}

const releaseDispatchOfEventSafe = (ev, user) =>
  releaseDispatchOfEvent(ev, user).catch((err) => console.error("⚠️ ปลดใบแจ้งงานจากงานที่ถูกลบไม่สำเร็จ:", err?.message));

/**
 * ใบที่ผูกงานซึ่งไม่มีอยู่จริงแล้ว (ลบไปก่อนมีระบบนี้) — ปลดให้กลับมารอลงแผนงาน
 * @param docs   ใบ (lean) ที่แนบ job แล้ว
 * @param existingIds Set ของ eventId ที่ยังมีอยู่
 */
async function repairOrphans(docs, existingIds) {
  const orphans = docs.filter((d) => d?.eventId && !existingIds.has(String(d.eventId)) && d.status === "assigned");
  if (!orphans.length) return;
  for (const d of orphans) {
    d.eventId = null;
    d.status = "requested";
    d.job = null;
  }
  await Dispatch.updateMany(
    { _id: { $in: orphans.map((d) => d._id) } },
    { $unset: { eventId: 1 }, $set: { status: "requested" }, $push: { activityLog: log("job_deleted", "งานในตารางไม่มีอยู่แล้ว (ถูกลบ) — ใบนี้กลับมารอลงแผนงาน") } },
  ).catch((err) => console.error("⚠️ ซ่อมใบแจ้งงานที่งานถูกลบไม่สำเร็จ:", err?.message));
}

/**
 * 🔁 (21 ต.ค. 2569 ผู้ใช้: "รายละเอียดไม่ตรง และไม่ครบถ้วน") งานที่ลงจากใบแจ้งงาน — เติมข้อมูลจากใบให้ครบในหน้ารับงาน
 *    วันรับงาน (วันที่แจ้ง) · รับงานจาก (แผนกของผู้แจ้ง) · ผู้แจ้ง · เลขที่ใบแจ้งงาน · เอกสารอ้างอิง (QT/PO ที่แนบมา)
 *    ผู้ติดต่อ · รายละเอียด · เลข JOB (งานเก่าที่ยังไม่มี) — เติมเฉพาะช่องที่ยังว่าง ไม่ทับของที่แก้ไว้แล้ว
 */
async function enrichFromDispatch(d) {
  if (!d?.eventId) return 0;
  const { departmentOf } = require("../config/roles");
  const { assignJobNo } = require("../utils/jobNumber");
  const ev = await CalendarEvent.findById(d.eventId).select("_id jobGroupId").lean();
  if (!ev) return 0;
  const filter = ev.jobGroupId ? { jobGroupId: ev.jobGroupId } : { _id: ev._id };
  const list = await CalendarEvent.find(filter);
  const dept = departmentOf(d.requestedBy?.role);
  const atts = d.attachments || [];
  const docType = atts.some((a) => a.docType === "po") ? "po" : atts.some((a) => a.docType === "quotation") ? "quotation" : "";
  const c = d.customer || {};
  let jobNo = list.find((e) => e.jobNo)?.jobNo || "";
  let n = 0;
  for (const e of list) {
    if (!e.intakeAt) e.intakeAt = d.requestedAt || d.createdAt || new Date();
    if (!e.intakeSource || e.intakeSource === "dispatch") e.intakeSource = dept || "dispatch";
    if (d.requestedBy?.name) e.intakeBy = d.requestedBy.name;
    if (!e.dispatchNo && d.dispatchNo) e.dispatchNo = d.dispatchNo;
    if (!e.intakeDocType && docType) e.intakeDocType = docType;
    if (!e.contactName && c.contactName) e.contactName = c.contactName;
    if (!e.contactTel && c.contactTel) e.contactTel = c.contactTel;
    if (!e.description && (d.detail || d.note)) e.description = d.detail || d.note;
    if (!e.jobNo) { if (!jobNo) jobNo = await assignJobNo(e); else e.jobNo = jobNo; }
    if (e.isModified()) { await e.save(); n += 1; }
  }
  return n;
}
const enrichFromDispatchSafe = (d) => enrichFromDispatch(d).catch((err) => console.error("⚠️ เติมข้อมูลงานจากใบแจ้งงานไม่สำเร็จ:", err?.message));

/**
 * งานที่ลงจากใบแจ้งงานแต่ยังไม่ได้เติมข้อมูล (ไม่มี intakeAt หรือ dispatchNo) → เติมให้ครบ
 * เรียกตอนเปิดเซิร์ฟเวอร์ · ตอนดึงรายการใบแจ้งงาน · ตอนดึงรายการงานใหม่
 */
let backfilling = null;
function backfillDispatchIntake() {
  if (backfilling) return backfilling;
  backfilling = (async () => {
    const ds = await Dispatch.find({ eventId: { $ne: null }, status: { $ne: "cancelled" } }).lean();
    if (!ds.length) return 0;
    const need = await CalendarEvent.find({ _id: { $in: ds.map((d) => d.eventId) }, $or: [{ intakeAt: null }, { dispatchNo: { $in: [null, ""] } }] }).select("_id").lean();
    const ids = new Set(need.map((e) => String(e._id)));
    let n = 0;
    for (const d of ds) if (ids.has(String(d.eventId))) n += await enrichFromDispatch(d);
    if (n) {
      console.log(`✅ เติมข้อมูลงานจากใบแจ้งงานเข้าหน้ารับงาน ${n} รายการ`);
      try { require("./realtime").publish({ topic: "events", action: "put" }); } catch { /* ไม่ขวาง */ }
    }
    return n;
  })().catch((err) => { console.error("⚠️ เติมงานจากใบแจ้งงานเข้าหน้ารับงานไม่สำเร็จ:", err?.message); return 0; })
    .finally(() => { backfilling = null; });
  return backfilling;
}

module.exports = { releaseDispatchOfEvent, releaseDispatchOfEventSafe, repairOrphans, backfillDispatchIntake, enrichFromDispatch, enrichFromDispatchSafe };
