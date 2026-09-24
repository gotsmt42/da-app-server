const mongoose = require("../db");

/**
 * คำขอจากเว็บไซต์บริษัท (ฟอร์ม "ติดต่อเรา" และ "ขอใบเสนอราคา")
 *
 * ⚠️ นี่คือข้อมูลส่วนบุคคลของลูกค้า (พ.ร.บ.คุ้มครองข้อมูลส่วนบุคคล) — อ่านได้เฉพาะสิทธิ์ viewLeads
 *    ห้ามส่งออกไปในเส้นทางสาธารณะใดๆ และห้ามใส่ลงในการแจ้งเตือนแบบ push เกินจำเป็น
 *    (push แสดงบนหน้าจอล็อกของมือถือ ใครหยิบเครื่องก็อ่านได้ — ใส่แค่ชื่อกับประเภทงาน ไม่ใส่เบอร์)
 * ⚠️ ไฟล์แนบเก็บบน Cloudinary แบบ "authenticated" — เปิดด้วยลิงก์ตรงไม่ได้ ต้องขอลิงก์ที่ลงนาม
 *    ผ่าน API (อายุสั้น) ทุกครั้ง แบบแปลนของลูกค้าจึงไม่หลุดออกไปด้วยการเดา URL
 */
const STATUSES = ["new", "contacted", "quoted", "won", "lost", "spam"];

const leadFileSchema = new mongoose.Schema(
  {
    publicId: { type: String, required: true },
    resourceType: { type: String, enum: ["image", "raw"], required: true },
    format: { type: String, default: "" },
    name: { type: String, default: "", maxlength: 200 },
    bytes: { type: Number, default: 0 },
  },
  { _id: false }
);

const noteSchema = new mongoose.Schema(
  {
    at: { type: Date, default: Date.now },
    by: { type: String, default: "" },
    text: { type: String, required: true, maxlength: 2000 },
  },
  { _id: false }
);

const leadSchema = new mongoose.Schema(
  {
    /** เลขอ้างอิงที่ลูกค้าเห็นบนหน้าจอหลังส่ง เช่น WEB-2569-00012 */
    ref: { type: String, required: true, unique: true },
    kind: { type: String, enum: ["contact", "quotation"], required: true, index: true },
    name: { type: String, required: true, maxlength: 100 },
    company: { type: String, default: "", maxlength: 150 },
    phone: { type: String, required: true, maxlength: 20 },
    email: { type: String, default: "", maxlength: 120 },
    subject: { type: String, default: "", maxlength: 150 },
    serviceType: { type: String, default: "", maxlength: 60 },
    siteLocation: { type: String, default: "", maxlength: 200 },
    budget: { type: String, default: "", maxlength: 40 },
    preferredDate: { type: String, default: "", maxlength: 10 },
    details: { type: String, required: true, maxlength: 4000 },
    files: { type: [leadFileSchema], default: [] },
    /** ✅ หลักฐานความยินยอมตาม PDPA — ต้องเก็บไว้ว่ายินยอมเมื่อไร */
    consentAt: { type: Date, required: true },

    status: { type: String, enum: STATUSES, default: "new", index: true },
    assignee: { type: String, default: "", maxlength: 100 },
    notes: { type: [noteSchema], default: [] },
    /** ข้อมูลตอนส่ง — ใช้ตรวจสแปม/ตามปัญหา ไม่แสดงบนหน้าจอทั่วไป */
    meta: {
      ip: { type: String, default: "" },
      userAgent: { type: String, default: "", maxlength: 400 },
      page: { type: String, default: "", maxlength: 400 },
    },
    /** ส่งอีเมลแจ้งทีมสำเร็จไหม — ถ้า false ทีมต้องรู้จากหน้าจอ/แจ้งเตือนแทน */
    emailed: { type: Boolean, default: false },
  },
  { timestamps: true }
);

leadSchema.index({ status: 1, createdAt: -1 });
leadSchema.statics.STATUSES = STATUSES;

module.exports = mongoose.model("Lead", leadSchema);
