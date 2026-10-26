/**
 * quotationAutoStart — เริ่มนับติดตามใบเสนอราคาอัตโนมัติ
 *
 * ✅ ผู้ใช้สั่ง (3 ต.ค. 2569): "ตัดขั้นตอนการกดส่งลูกค้า ให้เวลาช่างอัปใบเสนอราคาและส่งงานเสร็จแล้ว เริ่มนับเลย"
 *    เดิมต้องมีคนกด "บันทึกว่าส่งลูกค้าแล้ว" ก่อนระบบจะเริ่มนับวันติดตาม — ขั้นตอนนี้ถูกลืมบ่อย ใบค้างที่
 *    "รอส่งลูกค้า" ไปเรื่อยๆ โดยไม่มีใครตาม
 * ✅ เงื่อนไขเริ่มนับ (ทั้งงาน = jobGroupId เดียวกัน): มีไฟล์ใบเสนอราคา + งานส่งแล้ว (ขอปิดงานแล้ว หรือปิดงานแล้ว)
 *    วันเริ่มนับ = วันหลังสุดระหว่าง "อัปไฟล์ใบล่าสุด" กับ "ส่งงาน/ปิดงาน"
 *    → ตั้ง quotationStatus = "sent" ให้เอง (ตรรกะติดตาม/แจ้งเตือน/แดชบอร์ดเดิมใช้ต่อได้ทั้งหมด)
 * 🔁 (19 ต.ค. 2569 ผู้ใช้: "ขั้นตอนการนับให้เริ่มตั้งแต่ที่ช่างอัปไฟล์ลงในงาน · ไม่ต้องมากดเอง")
 *    เงื่อนไขใหม่: มีไฟล์ใบเสนอราคาในงาน = เริ่มนับทันที ไม่ต้องรอส่งงาน/ปิดงาน · วันเริ่มนับ = วันที่อัปไฟล์ใบแรก
 * ⚠️ ไม่แตะใบที่มีสถานะแล้ว (ส่ง/อนุมัติ/ปฏิเสธ/แก้ไข) — และใบที่ฝ่ายบริหารกด "ย้อนสถานะ" จะถูกเริ่มนับใหม่
 *    อัตโนมัติอีกครั้งถ้ายังเข้าเงื่อนไข (ตั้งใจ: ไม่มีสถานะ "รอส่ง" ค้างอีกต่อไป)
 */
const CalendarEvent = require("../models/Events");

const earliestDate = (...ds) => ds.filter((d) => d && !Number.isNaN(new Date(d).getTime()))
  .reduce((a, d) => (!a || new Date(d) < a ? new Date(d) : a), null);

/**
 * @param {object} [scope] — { ids: [eventId] } เฉพาะงานที่เกี่ยวข้อง (หลังอัปไฟล์/แก้งาน) · ไม่ส่ง = กวาดทั้งระบบ
 * @returns {Promise<number>} จำนวนงาน (กลุ่ม) ที่เริ่มนับให้
 */
async function syncQuotationStart(scope = {}) {
  const base = {
    $or: [{ quotationStatus: null }, { quotationStatus: { $exists: false } }],
    isHoliday: { $ne: true },
  };
  let filter = { ...base, "quotationFiles.0": { $exists: true } };
  if (scope.ids?.length) {
    const seeds = await CalendarEvent.find({ _id: { $in: scope.ids } }).select("jobGroupId").lean();
    const groups = seeds.map((s) => s.jobGroupId).filter(Boolean);
    filter = { ...base, $and: [{ $or: [{ _id: { $in: scope.ids } }, ...(groups.length ? [{ jobGroupId: { $in: groups } }] : [])] }] };
  }
  const rows = await CalendarEvent.find(filter)
    .select("_id jobGroupId status closeRequested closeRequestedAt closeApprovedAt updatedAt quotationFiles")
    .lean();
  if (!rows.length) return 0;

  // ⚠️ ไฟล์/สถานะงานอาจอยู่คนละแถวของงานเดียวกัน (งานหลายวัน) — ดูทั้งกลุ่มเสมอ
  const groupIds = [...new Set(rows.map((r) => r.jobGroupId).filter(Boolean))];
  const all = await CalendarEvent.find({
    $or: [
      { jobGroupId: { $in: groupIds } },
      { _id: { $in: rows.filter((r) => !r.jobGroupId).map((r) => r._id) } },
    ],
  }).select("_id jobGroupId status closeRequested closeRequestedAt closeApprovedAt updatedAt quotationFiles quotationStatus").lean();

  const byKey = new Map();
  all.forEach((r) => {
    const k = r.jobGroupId || String(r._id);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(r);
  });

  let started = 0;
  for (const [key, list] of byKey) {
    if (list.some((r) => r.quotationStatus)) continue;
    const files = list.flatMap((r) => r.quotationFiles || []);
    if (!files.length) continue;
    const sentAt = earliestDate(...files.map((f) => f.uploadedAt)) || new Date();
    const filter2 = list[0].jobGroupId ? { jobGroupId: key } : { _id: list[0]._id };
    const res = await CalendarEvent.updateMany(
      { ...filter2, $or: [{ quotationStatus: null }, { quotationStatus: { $exists: false } }] },
      { $set: { quotationStatus: "sent", quotationSentAt: sentAt, quotationDecisionAt: null, quotationDecisionBy: null, quotationDecisionNote: "", quotationPoNo: "" } },
    );
    if (res.modifiedCount) {
      started += 1;
      await CalendarEvent.updateOne({ _id: list[0]._id }, {
        $push: { activityLog: { action: "quotation_sent", detail: "เริ่มนับติดตามใบเสนอราคาอัตโนมัติ (แนบไฟล์ใบเสนอราคาแล้ว)", userId: "", userName: "ระบบ", timestamp: new Date() } },
      });
    }
  }
  return started;
}

/**
 * ✅ (26 ต.ค. 2569) ใบที่กำลังออกฉบับแก้ไข (revising) + แนบไฟล์ฉบับใหม่แล้ว → เริ่มนับติดตามใหม่ทันที (ไม่ต้องกดเอง)
 * @param {string} eventId วันใดก็ได้ของงาน
 */
async function restartRevisedQuotation(eventId) {
  const ev = await CalendarEvent.findById(eventId).select("_id jobGroupId quotationStatus quotationRevision").lean();
  if (!ev || ev.quotationStatus !== "revising") return false;
  const filter = ev.jobGroupId ? { jobGroupId: ev.jobGroupId } : { _id: ev._id };
  const rows = await CalendarEvent.find(filter).select("quotationFiles").lean();
  const fresh = rows.flatMap((r) => r.quotationFiles || []).filter((f) => !f.supersededAt);
  if (!fresh.length) return false;
  const sentAt = earliestDate(...fresh.map((f) => f.uploadedAt)) || new Date();
  const res = await CalendarEvent.updateMany({ ...filter, quotationStatus: "revising" }, { $set: { quotationStatus: "sent", quotationSentAt: sentAt } });
  if (res.modifiedCount) {
    await CalendarEvent.updateOne({ _id: ev._id }, {
      $push: { activityLog: { action: "quotation_sent", detail: `แนบใบเสนอราคาฉบับแก้ไข Rev.${ev.quotationRevision || 0} แล้ว — เริ่มนับติดตามใหม่`, userId: "", userName: "ระบบ", timestamp: new Date() } },
    });
  }
  return res.modifiedCount > 0;
}
const restartRevisedQuotationSafe = (id) =>
  restartRevisedQuotation(id).catch((err) => { console.error("❌ เริ่มนับฉบับแก้ไขไม่สำเร็จ:", err.message); return false; });

/** ล้มเหลวต้องไม่ทำให้คำขอหลัก (อัปไฟล์/แก้งาน) พัง — คืน 0 แทนการโยน error */
const syncQuotationStartSafe = (scope) =>
  syncQuotationStart(scope).catch((err) => { console.error("❌ เริ่มนับติดตามใบเสนอราคาไม่สำเร็จ:", err.message); return 0; });

module.exports = { syncQuotationStart, syncQuotationStartSafe, restartRevisedQuotation, restartRevisedQuotationSafe };
