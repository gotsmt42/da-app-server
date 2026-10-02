const mongoose = require("../db");

/**
 * PurchaseRequest — ใบขอซื้อสินค้า (PR)
 *
 * ✅ ผู้ใช้สั่ง (2 ต.ค. 2569): "เพิ่มระบบออกใบขอซื้อสินค้า PR ให้รายละเอียดครบถ้วน และมืออาชีพ สมบูรณ์"
 *   • อนุมัติ = สายเดียวกับระบบเบิก (ตรวจสอบ → อนุมัติ)
 *   • หลังอนุมัติ ติดตามต่อในระบบ: ฝ่ายจัดซื้อบันทึก "สั่งซื้อแล้ว" (ร้านค้า · เลขที่ PO · ราคาจริง · กำหนดส่ง)
 *     → "รับของ" ได้ทีละส่วน (ครบ/บางส่วน) → ครบทุกรายการ = ปิดใบ
 *   • ผูกงาน/โครงการ — ดูได้ว่าซื้อของให้งานไหน
 *
 * วงจร: pending → reviewed → approved (รอสั่งซื้อ) → ordered (รอรับของ) → partial (รับบางส่วน) → received (รับครบ ปิดใบ)
 *       pending ⇄ rejected · cancelled
 * ⚠️ ยอดเงินคำนวณที่ server เสมอ (จำนวน × ราคาต่อหน่วย) ไม่เชื่อค่าจาก client
 */
const STATUS = ["pending", "reviewed", "rejected", "approved", "ordered", "partial", "received", "cancelled"];
const PRIORITIES = ["normal", "urgent", "critical"];
/** ประเภทการซื้อ — ช่องมาตรฐานของแบบฟอร์ม PR (ฝ่ายบัญชีใช้แยกบันทึกค่าใช้จ่าย/สินทรัพย์) */
const CATEGORIES = ["material", "tool", "consumable", "asset", "service", "other"];
const FILE_KINDS = ["quotation", "spec", "photo", "po", "delivery", "invoice", "other"];

const personSchema = { userId: { type: String, default: "" }, name: { type: String, default: "" } };
/** สำเนาลายเซ็นที่ผนึกในใบ (ดู services/signatureSeal.js) — เหมือนระบบเบิก */
const sealSchema = {
  userId: { type: String, default: "" }, name: { type: String, default: "" }, position: { type: String, default: "" },
  signedAt: { type: Date, default: null }, hash: { type: String, default: "" },
};

const itemSchema = new mongoose.Schema(
  {
    /** รหัสสินค้า / Part No. (ไม่บังคับ) */
    code: { type: String, default: "", trim: true },
    description: { type: String, required: true, trim: true },
    /** ยี่ห้อ / รุ่น / สเปก — ฝ่ายจัดซื้อต้องสั่งได้ถูกตัวโดยไม่ต้องโทรถามกลับ */
    spec: { type: String, default: "", trim: true },
    qty: { type: Number, default: 1, min: 0 },
    unit: { type: String, default: "", trim: true },
    /** ราคาประมาณการตอนขอ */
    estUnitPrice: { type: Number, default: 0, min: 0 },
    estAmount: { type: Number, default: 0, min: 0 },
    /** ราคาจริงตอนสั่งซื้อ (ฝ่ายจัดซื้อกรอก) */
    actualUnitPrice: { type: Number, default: null },
    actualAmount: { type: Number, default: null },
    receivedQty: { type: Number, default: 0, min: 0 },
    note: { type: String, default: "", trim: true },
  },
  { _id: true }
);

const fileSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: FILE_KINDS, default: "other" },
    fileName: String, fileUrl: String, fileType: String, uploadedAt: { type: Date, default: Date.now }, uploadedBy: String,
  },
  { _id: true }
);

const purchaseRequestSchema = new mongoose.Schema(
  {
    docNo: { type: String, unique: true, sparse: true, index: true },
    status: { type: String, enum: STATUS, default: "pending", index: true },
    docDate: { type: Date, default: Date.now, index: true },
    subject: { type: String, required: true, trim: true },
    /** เหตุผล/วัตถุประสงค์การซื้อ */
    purpose: { type: String, default: "", trim: true },
    priority: { type: String, enum: PRIORITIES, default: "normal" },
    category: { type: String, enum: CATEGORIES, default: "material" },
    /** ต้องการใช้ภายในวันที่ */
    neededBy: { type: Date, default: null },
    /** สถานที่ส่งของ */
    deliverTo: { type: String, default: "", trim: true },
    /** ผู้รับของ ณ จุดส่ง + เบอร์ติดต่อ — ร้านค้า/คนส่งของโทรหาได้ตรง */
    contactName: { type: String, default: "", trim: true },
    contactPhone: { type: String, default: "", trim: true },
    /** ร้านค้าที่แนะนำ (ผู้ขอเสนอ — ฝ่ายจัดซื้อเลือกจริงตอนสั่ง) */
    suggestedSupplier: { type: String, default: "", trim: true },
    note: { type: String, default: "", trim: true },
    requester: {
      userId: { type: String, index: true, default: "" }, name: { type: String, default: "" }, position: { type: String, default: "" },
      /** ฝ่าย/แผนก + เบอร์โทร (snapshot ตอนออกใบ) */
      department: { type: String, default: "" }, phone: { type: String, default: "" },
    },
    createdBy: personSchema,
    /** งาน/โครงการที่ซื้อให้ (snapshot) */
    eventId: { type: String, default: "", index: true },
    job: {
      title: { type: String, default: "" }, system: { type: String, default: "" }, site: { type: String, default: "" },
      company: { type: String, default: "" }, docNo: { type: String, default: "" },
    },
    items: { type: [itemSchema], default: [] },
    /** VAT ของราคาประมาณการ/ราคาจริง (0 หรือ 7) */
    vatRate: { type: Number, default: 0 },
    estSubtotal: { type: Number, default: 0 },
    estTotal: { type: Number, default: 0 },
    actualTotal: { type: Number, default: 0 },
    submittedAt: { type: Date, default: Date.now },
    reviewedBy: personSchema, reviewedAt: { type: Date, default: null },
    approvedBy: personSchema, approvedAt: { type: Date, default: null },
    rejectedBy: personSchema, rejectedAt: { type: Date, default: null }, rejectReason: { type: String, default: "" },
    /** การสั่งซื้อ (ฝ่ายจัดซื้อ) */
    order: {
      supplier: { type: String, default: "" },
      supplierContact: { type: String, default: "" },
      poNo: { type: String, default: "" },
      orderedAt: { type: Date, default: null },
      expectedAt: { type: Date, default: null },
      by: personSchema,
      note: { type: String, default: "" },
    },
    /** ประวัติการรับของ (รับได้หลายครั้ง) */
    receipts: [{
      at: { type: Date, default: Date.now }, by: personSchema, note: { type: String, default: "" },
      lines: [{ _id: false, itemId: String, description: String, qty: Number }],
    }],
    receivedAt: { type: Date, default: null },
    cancelledBy: personSchema, cancelledAt: { type: Date, default: null }, cancelReason: { type: String, default: "" },
    attachments: { type: [fileSchema], default: [] },
    /**
     * ✅ ลายเซ็นอิเล็กทรอนิกส์ 4 ช่องบน PDF (ผู้ใช้ขอให้ใบขอซื้อ "เหมือนใบอื่นๆ")
     * ผนึกตอนผู้นั้นกดเองเท่านั้น และเฉพาะเมื่อติ๊กเลือกใช้ · ตีกลับ = ล้างช่องผู้ตรวจสอบ/ผู้อนุมัติ
     */
    signatures: { requester: sealSchema, reviewer: sealSchema, approver: sealSchema, purchaser: sealSchema },
    activityLog: [{ action: String, detail: String, userId: String, userName: String, timestamp: { type: Date, default: Date.now } }],
  },
  { timestamps: true }
);

const PurchaseRequest = mongoose.model("PurchaseRequest", purchaseRequestSchema);
PurchaseRequest.STATUS = STATUS;
PurchaseRequest.PRIORITIES = PRIORITIES;
PurchaseRequest.CATEGORIES = CATEGORIES;
PurchaseRequest.FILE_KINDS = FILE_KINDS;
module.exports = PurchaseRequest;
