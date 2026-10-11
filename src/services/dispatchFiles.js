/**
 * ไฟล์แนบจาก "คำขอลงงาน" → "ไฟล์แนบ" ของงาน (10 ต.ค. 2569)
 *
 * ✅ ผู้ใช้: "ไฟล์แนบให้ดึงจากคำขอลงงานมาด้วย ให้เชื่อมโยงให้สมบูรณ์"
 *    เดิมรูป/ใบเสนอราคา/PO/แบบแปลนที่เซลแนบมากับคำขอ อยู่แค่ในใบคำขอ — ช่างที่เปิดงานในตาราง/การดำเนินงาน
 *    ไม่เห็นเลย ต้องไปหาเปิดใบคำขอเอง
 * ✅ ตอนนี้ไฟล์ของคำขอถูกผูกเข้า Events.sitePhotoFiles ของงานที่ลงตารางจากคำขอนั้น (ใช้ URL เดิม ไม่อัปโหลดซ้ำ)
 *    ติดป้าย source:"dispatch" + ชนิดเอกสาร — หน้าจอแสดงป้าย "จากคำขอลงงาน" และไม่ให้ลบจากฝั่งงาน
 *    (ไฟล์ต้นฉบับยังเป็นของใบคำขอ)
 * จุดที่เรียก: อนุมัติลงงาน · สร้างคำขอที่ผูกงานอยู่แล้ว · แนบไฟล์เพิ่มในคำขอหลังลงงาน · เติมย้อนหลังครั้งเดียวตอนเริ่มระบบ
 */
const CalendarEvent = require("../models/Events");
const Dispatch = require("../models/Dispatch");
const DocCounter = require("../models/DocCounter");

const DOC_LABEL = { quotation: "ใบเสนอราคา", po: "ใบสั่งซื้อ (PO)", site_photo: "รูปหน้างาน", drawing: "แบบแปลน", other: "เอกสาร" };

/** ผูกไฟล์ของคำขอเข้างาน (ไม่ซ้ำ — เทียบจาก URL) · คืนจำนวนไฟล์ที่เพิ่ม */
async function linkDispatchFiles(dispatch, eventId = dispatch?.eventId) {
  if (!dispatch || !eventId || !(dispatch.attachments || []).length) return 0;
  const ev = await CalendarEvent.findById(eventId).select("sitePhotoFiles");
  if (!ev) return 0;
  const have = new Set((ev.sitePhotoFiles || []).map((f) => f.fileUrl));
  const add = (dispatch.attachments || [])
    .filter((a) => a?.fileUrl && !have.has(a.fileUrl))
    .map((a) => ({
      fileName: a.fileName,
      fileUrl: a.fileUrl,
      fileType: a.fileType,
      uploadedAt: a.uploadedAt || new Date(),
      uploadedBy: a.uploadedBy || "",
      source: "dispatch",
      sourceLabel: `คำขอลงงาน · ${DOC_LABEL[a.docType] || "เอกสาร"}`,
      dispatchId: String(dispatch._id),
    }));
  if (!add.length) return 0;
  await CalendarEvent.updateOne({ _id: ev._id }, { $push: { sitePhotoFiles: { $each: add } } });
  return add.length;
}

/** เรียกแบบไม่ให้ทำ route หลักล้ม */
const linkDispatchFilesSafe = (dispatch, eventId) =>
  linkDispatchFiles(dispatch, eventId).catch((err) => console.error("⚠️ ผูกไฟล์คำขอลงงานเข้างานไม่สำเร็จ:", err.message));

const FLAG = "migr:dispatch-files-v1";
/** เติมย้อนหลังครั้งเดียว — คำขอที่ลงงานไปแล้วก่อนมีระบบนี้ */
async function backfillDispatchFiles() {
  if (await DocCounter.findOne({ key: FLAG }).lean()) return 0;
  const rows = await Dispatch.find({ eventId: { $ne: null }, "attachments.0": { $exists: true } }).select("eventId attachments").lean();
  let n = 0;
  for (const d of rows) n += await linkDispatchFiles(d);
  await DocCounter.create({ key: FLAG, seq: 1 });
  if (n) console.log(`📎 ผูกไฟล์จากคำขอลงงานเข้างานเดิม ${n} ไฟล์`);
  return n;
}

module.exports = { linkDispatchFiles, linkDispatchFilesSafe, backfillDispatchFiles };
