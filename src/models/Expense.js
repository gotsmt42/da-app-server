const mongoose = require("../db");

/**
 * Expense — ใบเบิกเงินล่วงหน้า (Advance) และใบเคลียร์ค่าใช้จ่าย (Claim) ของพนักงาน
 *
 * ── ทำไมเก็บ 2 ชนิดไว้คอลเลกชันเดียว ─────────────────────────────────────────
 * ทั้งสองใบมีโครงเหมือนกันเกือบทั้งหมดตามแบบฟอร์มกระดาษของบริษัท (วันที่ / ถึง / ผู้เบิก / ตำแหน่ง /
 * เรื่อง / ตารางรายการ / รวม / ลายเซ็น 3 ช่อง) ต่างกันแค่ "ใบเคลมต้องอ้างใบ Advance" กับ "ส่วนต่างที่ต้อง
 * คืน/จ่ายเพิ่ม" — แยกคอลเลกชันจะต้องเขียนขอบเขตสิทธิ์/ตัวกรอง/รายงานซ้ำสองชุดที่ต้องตรงกันตลอดไป
 * รายงานงบประมาณก็ต้องอ่านทั้งคู่พร้อมกันอยู่แล้ว
 *
 * ── วงจรชีวิต ─────────────────────────────────────────────────────────────
 * Advance:        pending → approved → paid → clearing → cleared
 * Claim (clear):  pending → approved → settled        (เคลียร์ใบ Advance)
 * Claim (reimburse): pending → approved → settled     (สำรองจ่ายเอง ไม่มี Advance — บริษัทจ่ายคืน)
 * ทั้งคู่:   pending ⇄ rejected (ตีกลับให้แก้ แล้วส่งใหม่ในใบเดิม) · cancelled (จบ ไม่นับในยอด)
 *
 * ⚠️ สถานะ clearing/cleared ของ Advance ถูกตั้งจากฝั่งใบเคลมเท่านั้น (ดู routes/expenses.js)
 * ห้ามให้ client ส่งมาตั้งเอง — ไม่งั้นจะเกิด "Advance ขึ้นว่าเคลียร์แล้วแต่ไม่มีใบเคลมสักใบ"
 * ซึ่งทำให้ยอดค้างเคลียร์ในรายงานหายไปเงียบๆ
 */

const KINDS = ["advance", "claim"];

/**
 * ชนิดย่อยของใบเคลม (ใช้เฉพาะ kind = "claim")
 *   clear     — เคลมเพื่อเคลียร์ใบ Advance ที่รับเงินไปแล้ว (ต้องมี advanceId)
 *   reimburse — ผู้เบิก "สำรองจ่ายเอง" ไปก่อน ไม่มี Advance (ผู้ใช้แจ้ง: "บางทีช่างออกค่าใช้จ่ายไปก่อน
 *               ไม่ advance") บริษัทจ่ายคืนเต็มยอดที่อนุมัติ
 * ⚠️ ใบ reimburse ไม่มี advanceId/advance.total เสมอ → difference = ยอดรวม = เงินที่บริษัทต้องจ่ายคืน
 * (สูตรส่วนต่างเดิม total − advance.total ให้ผลถูกต้องอยู่แล้วเมื่อยอด Advance เป็น 0 จึงไม่ต้องแยกสูตร)

 * ⚠️ เลขที่เอกสารคนละชุดกัน: CLM-xxxxx/ปี (clear) · RMB-xxxxx/ปี (reimburse) — ฝ่ายบัญชีต้องแยก
 * "เคลียร์เงินที่จ่ายล่วงหน้าไปแล้ว" ออกจาก "จ่ายคืนเงินที่พนักงานออกไปก่อน" ได้ตั้งแต่เลขที่ใบ
 */
const CLAIM_TYPES = ["clear", "reimburse"];

const STATUS = [
  "pending",   // รออนุมัติ
  "rejected",  // ตีกลับให้แก้
  "approved",  // อนุมัติแล้ว (Advance = รอจ่ายเงิน · Claim = รอชำระส่วนต่าง)
  "paid",      // Advance: จ่ายเงินแล้ว รอเคลียร์
  "clearing",  // Advance: ส่งใบเคลมแล้ว รอตรวจ
  "cleared",   // Advance: เคลียร์เรียบร้อย
  "settled",   // Claim: ชำระส่วนต่างเรียบร้อย (หรือไม่มีส่วนต่าง)
  "cancelled", // ยกเลิก
];

/**
 * หมวดค่าใช้จ่าย — ใช้แยกยอดในรายงานงบประมาณ
 * ⚠️ ต้องตรงกับ EXPENSE_CATEGORIES ใน da-app/src/features/expenses/expenseMeta.js
 * ค่าที่ไม่รู้จักตกเป็น "other" ที่ฝั่ง route (ไม่โยน error ทิ้งทั้งใบ)
 */
const CATEGORIES = [
  "allowance", // เบี้ยเลี้ยง
  "travel",    // ค่าเดินทาง
  "fuel",      // ค่าน้ำมัน
  "toll",      // ทางด่วน / ที่จอดรถ
  "lodging",   // ที่พัก
  "material",  // วัสดุ / อุปกรณ์
  "tool",      // เครื่องมือ
  "shipping",  // ค่าขนส่ง
  "other",     // อื่นๆ
];

const FILE_KINDS = ["receipt", "invoice", "transfer_slip", "photo", "other"];

const PAYMENT_METHODS = ["transfer", "cash", "cheque", "other"];

const itemSchema = new mongoose.Schema(
  {
    category: { type: String, enum: CATEGORIES, default: "other" },
    description: { type: String, required: true, trim: true },
    /** ช่วงวัน/รายละเอียดเสริม เช่น "อังคาร–ศุกร์ 8–11 ก.ย. 69" */
    detail: { type: String, default: "", trim: true },
    qty: { type: Number, default: 1, min: 0 },
    unit: { type: String, default: "", trim: true },
    unitPrice: { type: Number, default: 0, min: 0 },
    /** ⚠️ คำนวณที่ server เสมอ (qty × unitPrice) — ไม่เชื่อค่าที่ client ส่งมา */
    amount: { type: Number, default: 0, min: 0 },
    /** Claim: อ้างถึงรายการในใบ Advance (index) — เพื่อเทียบ "ตั้งเบิก" กับ "จ่ายจริง" รายบรรทัด */
    advanceItemIndex: { type: Number, default: null },
    /** Claim: เลขที่ใบเสร็จ/บิล */
    receiptNo: { type: String, default: "", trim: true },
  },
  { _id: true }
);

const fileSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: FILE_KINDS, default: "other" },
    fileName: String,
    fileUrl: String,
    fileType: String,
    uploadedAt: { type: Date, default: Date.now },
    uploadedBy: String,
  },
  { _id: true }
);

const personSchema = {
  userId: { type: String, default: "" },
  name: { type: String, default: "" },
};

const expenseSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: KINDS, required: true, index: true },
    docNo: { type: String, unique: true, sparse: true, index: true },
    status: { type: String, enum: STATUS, default: "pending", index: true },

    /** วันที่ในหัวเอกสาร (ผู้เบิกเลือกได้ ไม่จำเป็นต้องเป็นวันที่สร้าง) */
    docDate: { type: Date, default: Date.now, index: true },
    /** "ถึง" — ผู้มีอำนาจอนุมัติตามแบบฟอร์มกระดาษ เช่น "K.ธนสิทธิ์" */
    to: { type: String, default: "", trim: true },
    /** "เรื่อง" */
    subject: { type: String, required: true, trim: true },
    note: { type: String, default: "", trim: true },

    /**
     * ผู้เบิก = คนที่รับเงินและต้องเป็นคนเคลียร์ใบนี้
     * ⚠️ คนละคนกับ createdBy ได้ — แอดมิน/ผู้จัดการเบิกแทนช่างได้ (ตามที่ผู้ใช้เลือก)
     * ขอบเขตการมองเห็นของช่างอิงทั้งสองฟิลด์ (ดู scopeFor ใน routes/expenses.js)
     */
    requester: {
      userId: { type: String, index: true, default: "" },
      name: { type: String, default: "" },
      position: { type: String, default: "" },
    },
    createdBy: {
      userId: { type: String, index: true, default: "" },
      name: { type: String, default: "" },
      role: { type: String, default: "" },
    },

    /** ผูกกับงานในปฏิทินได้ แต่ไม่บังคับ — เก็บ snapshot ไว้ด้วยเพื่อให้เอกสาร/รายงานยังอ่านได้แม้งานถูกลบ */
    eventId: { type: String, default: "", index: true },
    job: {
      title: { type: String, default: "" },
      company: { type: String, default: "" },
      site: { type: String, default: "" },
      docNo: { type: String, default: "" },
      start: { type: Date, default: null },
    },

    items: { type: [itemSchema], default: [] },
    total: { type: Number, default: 0, min: 0 },

    // ── เฉพาะ Claim ──────────────────────────────────────────────────────
    /** ⚠️ ใบ advance ไม่ใช้ฟิลด์นี้ (ค่าจะเป็น "clear" ตาม default เฉยๆ) — อ่านค่าเมื่อ kind = "claim" เท่านั้น */
    claimType: { type: String, enum: CLAIM_TYPES, default: "clear", index: true },
    advanceId: { type: String, default: "", index: true },
    /** snapshot ของใบ Advance ตอนเคลม — ยอดตั้งเบิกต้องไม่ขยับตามใบต้นทางที่อาจถูกแก้ภายหลัง */
    advance: {
      docNo: { type: String, default: "" },
      subject: { type: String, default: "" },
      total: { type: Number, default: 0 },
      paidAt: { type: Date, default: null },
    },
    /**
     * ส่วนต่าง = ใช้จริง − ยอด Advance
     *   > 0  บริษัทจ่ายเพิ่มให้ผู้เบิก
     *   < 0  ผู้เบิกคืนเงินให้บริษัท
     *   = 0  พอดี (อนุมัติแล้วจบทันที ไม่ต้องมีขั้นชำระ)
     */
    difference: { type: Number, default: 0 },

    // ── เฉพาะ Advance ────────────────────────────────────────────────────
    /** กำหนดเคลียร์ — ใช้ยิงแจ้งเตือนรายวันเมื่อเลยกำหนดแล้วยังไม่ส่งใบเคลม */
    dueClearAt: { type: Date, default: null, index: true },
    /** ใบเคลมที่เคลียร์ใบนี้ (ใบที่ยังไม่ถูกยกเลิก/ตีกลับ) */
    claimId: { type: String, default: "" },
    claimDocNo: { type: String, default: "" },

    // ── ร่องรอยการอนุมัติ/จ่ายเงิน ─────────────────────────────────────
    submittedAt: { type: Date, default: Date.now },
    approvedBy: personSchema,
    approvedAt: { type: Date, default: null },
    rejectedBy: personSchema,
    rejectedAt: { type: Date, default: null },
    rejectReason: { type: String, default: "" },
    /** Advance = จ่ายเงินล่วงหน้า · Claim = ชำระส่วนต่าง (คืนเงิน/จ่ายเพิ่ม) */
    payment: {
      method: { type: String, enum: PAYMENT_METHODS, default: "transfer" },
      ref: { type: String, default: "" },
      note: { type: String, default: "" },
      at: { type: Date, default: null },
      by: personSchema,
    },
    cancelledBy: personSchema,
    cancelledAt: { type: Date, default: null },
    cancelReason: { type: String, default: "" },

    attachments: { type: [fileSchema], default: [] },

    activityLog: [
      {
        action: String,
        detail: String,
        userId: String,
        userName: String,
        timestamp: { type: Date, default: Date.now },
      },
    ],
  },
  { timestamps: true }
);

expenseSchema.index({ kind: 1, status: 1, docDate: -1 });

const Expense = mongoose.model("Expense", expenseSchema);

Expense.KINDS = KINDS;
Expense.CLAIM_TYPES = CLAIM_TYPES;
Expense.STATUS = STATUS;
Expense.CATEGORIES = CATEGORIES;
Expense.FILE_KINDS = FILE_KINDS;
Expense.PAYMENT_METHODS = PAYMENT_METHODS;

module.exports = Expense;
