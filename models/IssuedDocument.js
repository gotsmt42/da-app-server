const mongoose = require("../db/");

/**
 * IssuedDocument — ทะเบียนเอกสารที่ "ออกจริง" ไปแล้ว (ใบแจ้งเข้างาน / ใบส่งมอบงาน)
 *
 * ✅ ทำไมต้องมีตารางนี้:
 * เดิมพอกดออกเอกสาร ไฟล์ PDF จะถูกสร้างแล้วส่งให้ผู้ใช้ไปเลย — ระบบไม่เคยรู้เลยว่าเคยออกใบอะไรไปบ้าง
 * ใครออก ออกให้โครงการไหน เมื่อไหร่ ทั้งที่เลขที่เอกสารถูกกินไปจริงจาก DocCounter แล้ว ผลคือ
 *   • ตามหาใบเก่าไม่ได้เลย ต้องไปไล่ถามคนที่ออกว่าเก็บไฟล์ไว้ไหม
 *   • เลขที่เอกสารในทะเบียน (DocCounter) เดินไปเรื่อยๆ แต่ไม่มีอะไรบอกว่าเลขไหนเป็นของใบไหน
 *   • ไม่รู้ว่าใบที่ออกไปแล้วส่งถึงลูกค้าหรือยัง ลูกค้าเซ็นรับหรือยัง
 * ✅ ตารางนี้บันทึก "หนึ่งแถวต่อหนึ่งใบที่ออกจริง" ตอนกดยืนยันในกล่องออกเอกสาร แล้วเปลี่ยนสถานะติดตาม
 * ต่อได้ (ส่งแล้ว / ลูกค้ารับแล้ว / ยกเลิก)
 *
 * ⚠️ ไม่เก็บไฟล์ PDF ไว้ในฐานข้อมูล — ไฟล์ถูกสร้างสดจากข้อมูลในฟอร์มทุกครั้ง (ดู workNoticePdf.js /
 * deliveryNotePdf.js) การเก็บไบนารีลง Mongo จะทำให้ฐานข้อมูลบวมเร็วมากโดยไม่จำเป็น — เก็บ "ข้อมูลที่ใช้
 * สร้างเอกสาร" (snapshot) แทน ซึ่งเล็กกว่าหลายร้อยเท่าและยังใช้ออกไฟล์ใบเดิมซ้ำได้เหมือนกันทุกประการ
 */

// ✅ สถานะติดตามเอกสารหลังออกไปแล้ว — ไล่ตามลำดับการใช้งานจริง
// ⚠️ "cancelled" ไม่ได้ลบแถวทิ้ง — เอกสารที่ออกไปแล้วกินเลขที่ไปแล้ว ต้องคงอยู่ในทะเบียนเสมอเพื่อให้
// อธิบายได้ว่าเลขนั้นหายไปไหน (ถ้าลบทิ้งจะกลายเป็นเลขขาดช่วงที่ไม่มีใครรู้สาเหตุ)
const DOC_STATUSES = ["issued", "sent", "acknowledged", "cancelled"];

const issuedDocumentSchema = new mongoose.Schema(
  {
    // "notice" = ใบแจ้งเข้างาน, "delivery" = ใบส่งมอบงาน — ตรงกับ docType ของ DocCounter
    docType: { type: String, required: true, index: true },
    // เลขที่เอกสารที่กินไปจริง เช่น "000016/2569"
    docNumber: { type: String, required: true, index: true },
    issuedAt: { type: Date, required: true, default: Date.now },

    // ── ข้อมูลสำหรับค้นหา/แสดงในตาราง (แยกฟิลด์ออกมาเพื่อให้ query/sort ได้จริง) ──
    subject: { type: String, default: "" },
    site: { type: String, default: "", index: true },
    customerCompany: { type: String, default: "" },
    workLabel: { type: String, default: "" },
    roundLabel: { type: String, default: "" },
    signerName: { type: String, default: "" },

    // งานที่เอกสารใบนี้ผูกอยู่ — ใช้กดข้ามไปดูงานต้นทางได้จากหน้าทะเบียน
    eventId: { type: mongoose.Schema.Types.ObjectId, ref: "Events", default: null },
    contractNo: { type: String, default: "" },

    status: { type: String, enum: DOC_STATUSES, default: "issued", index: true },
    // บันทึกเพิ่มเติมของแต่ละใบ (เช่น "ส่งทางอีเมลแล้ว 12/8", "ลูกค้าขอแก้วันที่")
    note: { type: String, default: "" },

    // ✅ snapshot ของฟอร์มทั้งก้อน — เอาไว้ออกไฟล์ใบเดิมซ้ำได้ตรงกับที่ส่งลูกค้าไปเป๊ะๆ
    // ⚠️ Mixed เพราะโครงสร้างฟอร์มของเอกสาร 2 ชนิดไม่เหมือนกัน (ใบแจ้งมี dayRows / ใบส่งมอบมี attachments)
    // และจะเพิ่มชนิดเอกสารใหม่ได้โดยไม่ต้องแก้ schema นี้อีก
    formSnapshot: { type: mongoose.Schema.Types.Mixed, default: {} },

    issuedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    issuedByName: { type: String, default: "" },
  },
  { timestamps: true }
);

// ✅ ดัชนีคู่ — หน้าทะเบียนเรียงตาม "ออกล่าสุดขึ้นก่อน" เสมอ และมักกรองด้วยชนิดเอกสารควบคู่กันไป
issuedDocumentSchema.index({ docType: 1, issuedAt: -1 });

const IssuedDocument = mongoose.model("IssuedDocument", issuedDocumentSchema);
module.exports = IssuedDocument;
module.exports.DOC_STATUSES = DOC_STATUSES;
