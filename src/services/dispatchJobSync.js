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
 * 🔁 (21 ต.ค. 2569 ผู้ใช้: "หน้าคำขอลงงานให้รวมกับหน้ารับงาน" · "deploy แล้วไม่ขึ้น")
 *    งานที่ลงแผนจากใบแจ้งงานก่อนมี intakeAt ไม่โผล่ในหน้ารับงาน (หน้ารับงานกรองด้วย intakeAt)
 *    → เติม intakeAt (= วันที่แจ้ง) + intakeSource "dispatch" ให้ทั้งกลุ่มงาน · ครั้งเดียวต่องาน
 * เรียกตอนเปิดเซิร์ฟเวอร์ · ตอนดึงรายการใบแจ้งงาน · ตอนดึงรายการงานใหม่
 */
let backfilling = null;
function backfillDispatchIntake() {
  if (backfilling) return backfilling;
  backfilling = (async () => {
    const ds = await Dispatch.find({ eventId: { $ne: null }, status: { $ne: "cancelled" } }).select("eventId requestedAt createdAt").lean();
    if (!ds.length) return 0;
    const missing = await CalendarEvent.find({ _id: { $in: ds.map((d) => d.eventId) }, intakeAt: null }).select("_id jobGroupId").lean();
    for (const ev of missing) {
      const d = ds.find((x) => String(x.eventId) === String(ev._id));
      const at = d?.requestedAt || d?.createdAt || new Date();
      const filter = ev.jobGroupId ? { jobGroupId: ev.jobGroupId, intakeAt: null } : { _id: ev._id };
      await CalendarEvent.updateMany(filter, { $set: { intakeAt: at, intakeSource: "dispatch" } });
    }
    if (missing.length) {
      console.log(`✅ เติมงานจากใบแจ้งงานเข้าหน้ารับงาน ${missing.length} งาน`);
      // หน้าที่เปิดอยู่โหลดใหม่เอง (ไม่ต้องกดรีเฟรช)
      try { require("./realtime").publish({ topic: "events", action: "put" }); } catch { /* ไม่ขวาง */ }
    }
    return missing.length;
  })().catch((err) => { console.error("⚠️ เติมงานจากใบแจ้งงานเข้าหน้ารับงานไม่สำเร็จ:", err?.message); return 0; })
    .finally(() => { backfilling = null; });
  return backfilling;
}

module.exports = { releaseDispatchOfEvent, releaseDispatchOfEventSafe, repairOrphans, backfillDispatchIntake };
