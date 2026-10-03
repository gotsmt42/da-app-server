/**
 * quotationAutoStart — เริ่มนับติดตามใบเสนอราคาอัตโนมัติ
 *
 * ✅ ผู้ใช้สั่ง (3 ต.ค. 2569): "ตัดขั้นตอนการกดส่งลูกค้า ให้เวลาช่างอัปใบเสนอราคาและส่งงานเสร็จแล้ว เริ่มนับเลย"
 *    เดิมต้องมีคนกด "บันทึกว่าส่งลูกค้าแล้ว" ก่อนระบบจะเริ่มนับวันติดตาม — ขั้นตอนนี้ถูกลืมบ่อย ใบค้างที่
 *    "รอส่งลูกค้า" ไปเรื่อยๆ โดยไม่มีใครตาม
 * ✅ เงื่อนไขเริ่มนับ (ทั้งงาน = jobGroupId เดียวกัน): มีไฟล์ใบเสนอราคา + งานส่งแล้ว (ขอปิดงานแล้ว หรือปิดงานแล้ว)
 *    วันเริ่มนับ = วันหลังสุดระหว่าง "อัปไฟล์ใบล่าสุด" กับ "ส่งงาน/ปิดงาน"
 *    → ตั้ง quotationStatus = "sent" ให้เอง (ตรรกะติดตาม/แจ้งเตือน/แดชบอร์ดเดิมใช้ต่อได้ทั้งหมด)
 * ⚠️ ไม่แตะใบที่มีสถานะแล้ว (ส่ง/อนุมัติ/ปฏิเสธ/แก้ไข) — และใบที่ฝ่ายบริหารกด "ย้อนสถานะ" จะถูกเริ่มนับใหม่
 *    อัตโนมัติอีกครั้งถ้ายังเข้าเงื่อนไข (ตั้งใจ: ไม่มีสถานะ "รอส่ง" ค้างอีกต่อไป)
 */
const CalendarEvent = require("../models/Events");

const DONE_STATUS = "ดำเนินการเสร็จสิ้น";

const latestDate = (...ds) => ds.filter((d) => d && !Number.isNaN(new Date(d).getTime()))
  .reduce((a, d) => (!a || new Date(d) > a ? new Date(d) : a), null);

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
    const doneRows = list.filter((r) => r.status === DONE_STATUS || r.closeRequested === true || r.closeApprovedAt);
    if (!doneRows.length) continue;
    const lastUpload = latestDate(...files.map((f) => f.uploadedAt));
    const doneAt = latestDate(...doneRows.map((r) => r.closeApprovedAt || r.closeRequestedAt || r.updatedAt));
    const sentAt = latestDate(lastUpload, doneAt) || new Date();
    const filter2 = list[0].jobGroupId ? { jobGroupId: key } : { _id: list[0]._id };
    const res = await CalendarEvent.updateMany(
      { ...filter2, $or: [{ quotationStatus: null }, { quotationStatus: { $exists: false } }] },
      { $set: { quotationStatus: "sent", quotationSentAt: sentAt, quotationDecisionAt: null, quotationDecisionBy: null, quotationDecisionNote: "", quotationPoNo: "" } },
    );
    if (res.modifiedCount) {
      started += 1;
      await CalendarEvent.updateOne({ _id: list[0]._id }, {
        $push: { activityLog: { action: "quotation_sent", detail: "เริ่มนับติดตามใบเสนอราคาอัตโนมัติ (แนบใบเสนอราคาและส่งงานแล้ว)", userId: "", userName: "ระบบ", timestamp: new Date() } },
      });
    }
  }
  return started;
}

/** ล้มเหลวต้องไม่ทำให้คำขอหลัก (อัปไฟล์/แก้งาน) พัง — คืน 0 แทนการโยน error */
const syncQuotationStartSafe = (scope) =>
  syncQuotationStart(scope).catch((err) => { console.error("❌ เริ่มนับติดตามใบเสนอราคาไม่สำเร็จ:", err.message); return 0; });

module.exports = { syncQuotationStart, syncQuotationStartSafe };
