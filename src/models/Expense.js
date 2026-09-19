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
  "pending",   // รอตรวจสอบ (ขั้นที่ 1)
  "reviewed",  // ตรวจสอบแล้ว รออนุมัติขั้นสุดท้าย (ขั้นที่ 2)
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
    /**
     * พนักงานที่รายการนี้เบิกให้ (ไม่บังคับ) — ผู้ใช้ขอ: "รายการที่ขอเบิกให้เพิ่มรายชื่อพนักงานคนอื่นได้
     * บางทีให้แค่หัวหน้างานเบิกให้" เช่น หัวหน้างานเบิกเบี้ยเลี้ยงให้ลูกทีม 3 คนในใบเดียว แยกบรรทัดละคน
     * ✅ ผู้เบิก (requester) ยังเป็นหัวหน้างานคนเดียว — คนรับเงินและต้องเคลียร์ใบ ส่วนฟิลด์นี้บอกแค่ว่า
     * เงินบรรทัดนี้เป็นของใคร ให้ผู้อนุมัติ/บัญชีตรวจได้ว่าจ่ายให้ใครบ้าง
     * ⚠️ userId ว่างได้ (คนนอกระบบ เช่น น.ศ. ฝึกงาน/แรงงานรายวัน) — ถ้ามี userId ชื่อจะถูกดึงจากทะเบียน
     * พนักงานเสมอ ไม่เชื่อชื่อที่ client ส่งมา (ดู withPersons ใน routes/expenses.js)
     */
    person: {
      userId: { type: String, default: "" },
      name: { type: String, default: "", trim: true },
    },
  },
  { _id: true }
);

/**
 * ขั้นตอนที่ไฟล์ถูกแนบเข้ามา
 * ✅ ผู้ใช้ขอให้รู้ว่า "ไฟล์นี้แนบมาจากขั้นตอนไหน" — ชนิดไฟล์ (kind) บอกแค่ว่าเป็นอะไร (ใบเสร็จ/สลิป)
 * แต่ไม่บอกว่ามาจากตอนออกใบ ตอนจ่ายเงิน หรือตอนปิดส่วนต่าง ซึ่งเป็นคนละเรื่องเวลาตรวจสอบย้อนหลัง
 * ⚠️ ไฟล์เก่าที่แนบก่อนมีฟิลด์นี้จะเป็น "" — หน้าจอต้องรองรับ (จัดเข้ากลุ่ม "ไม่ระบุขั้นตอน")
 */
const FILE_STAGES = ["created", "resubmitted", "review", "approve", "pay", "settle", "added"];

const fileSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: FILE_KINDS, default: "other" },
    stage: { type: String, enum: [...FILE_STAGES, ""], default: "" },
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

/**
 * ลายเซ็นอิเล็กทรอนิกส์ที่ถูก "ผนึก" ไว้ในใบตอนคนนั้นกดทำรายการเอง (ออกใบ / อนุมัติ)
 * ⚠️ เก็บแค่ hash ของรูป ไม่ใช่ตัวรูป — ดูเหตุผลที่ models/SignatureImage.js
 * ⚠️ hash ว่าง/ไม่มีฟิลด์นี้ = คนนั้นยังไม่ได้ตั้งลายเซ็นตอนกด → ใบพิมพ์ออกมาเป็นเส้นให้เซ็นมือตามเดิม
 */
const sealSchema = {
  userId: { type: String, default: "" },
  name: { type: String, default: "" },
  position: { type: String, default: "" },
  signedAt: { type: Date, default: null },
  hash: { type: String, default: "" },
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
      /** ระบบงาน เช่น "Fire Alarm" — ชื่องานเต็มคือ "PM Fire Alarm" */
      system: { type: String, default: "" },
      company: { type: String, default: "" },
      site: { type: String, default: "" },
      docNo: { type: String, default: "" },
      start: { type: Date, default: null },
      /** วันสิ้นสุดของ "ช่วงงาน" ที่ผูกไว้ — งานช่วงเดียววันเดียวจะเท่ากับ start */
      end: { type: Date, default: null },
      /** ครั้งที่ (ฟิลด์ time ของงาน) + จำนวนครั้งทั้งสัญญา — แสดงเป็น "ครั้งที่ 3/8" */
      round: { type: String, default: "" },
      visitCount: { type: Number, default: 0 },
      /**
       * ✅ ผู้ใช้สั่ง: "งานที่เข้าไม่ต่อเนื่อง แต่งานเดียวกัน ให้แยกเบิกเป็นช่วงงานได้"
       * งานหนึ่งงานเข้าได้หลายช่วงวันที่ (ช่วงที่ 1: 4 ส.ค. · ช่วงที่ 2: 7–12 ก.ย. ...)
       * สองช่องนี้เก็บไว้ว่าใบนี้เบิกของ "ช่วงที่เท่าไร จากทั้งหมดกี่ช่วง" เพื่อให้อ่านใบแล้วรู้ทันที
       * ว่าเป็นค่าใช้จ่ายของการเข้างานรอบไหน (0 = งานช่วงเดียว ไม่ต้องแสดง)
       */
      part: { type: Number, default: 0 },
      partCount: { type: Number, default: 0 },
    },

    /**
     * กุญแจ "1 ช่วงงาน" = eventId ของช่วงที่ผูกไว้
     *
     * 🐛 ที่แก้ (ผู้ใช้แจ้ง: "งานที่เข้าไม่ต่อเนื่อง แต่งานเดียวกัน ให้แยกเบิกเป็นช่วงงานได้"):
     * เดิมใช้ jobGroupId = ทั้งงาน ทำให้งานที่เข้า 4 ช่วง (เช่น 4 ส.ค. · 7–12 ก.ย. · 13–15 ก.ย. · 15 ก.ย.)
     * ออกใบ Advance ได้ใบเดียวทั้งงาน — แต่ค่าใช้จ่ายจริงเกิดแยกกันทุกครั้งที่เข้าหน้างาน
     * ✅ ตอนนี้ 1 ช่วง = 1 ใบ (ช่วงอื่นของงานเดียวกันยังเบิกแยกได้) ส่วน jobGroupId เก็บไว้ที่ jobGroupKey
     * ⚠️ ใบเก่าที่ออกก่อนการแก้นี้มี jobKey = jobGroupId — การกันซ้ำจึงเทียบ eventId ควบคู่เสมอ
     * (เซ็ตจาก resolveJob ใน routes/expenses.js ทุกครั้งที่ผูกงาน — ห้ามรับค่าจาก client)
     */
    jobKey: { type: String, default: "", index: true },
    /** กุญแจ "ทั้งงาน" (jobGroupId) — ใช้ดูภาพรวมว่างานนี้เบิกไปแล้วกี่ช่วง ไม่ได้ใช้กันซ้ำ */
    jobGroupKey: { type: String, default: "", index: true },
    /**
     * 🔒 ล็อก "1 ช่วงงาน ออกใบ Advance ได้ใบเดียว" ระดับฐานข้อมูล (ผู้ใช้สั่ง: "งานไหนมีการออกใบ Advance
     * แล้วจะไม่สามารถออกซ้ำได้" + ภายหลังขอให้แยกเป็นรายช่วง)
     * ✅ มีค่า (= jobKey) เฉพาะใบ Advance ที่ผูกงานและ "ยังมีผล" — ยกเลิกใบเมื่อไรต้องลบค่าทิ้ง (unset) เพื่อ
     * ปลดล็อกให้งานนั้นออกใบใหม่ได้ · index unique + sparse: ใบที่ไม่มีค่านี้ไม่ถูกนับ
     * ⚠️ ทำไมต้องมีทั้งที่ route ตรวจซ้ำก่อนบันทึกอยู่แล้ว: การตรวจก่อนบันทึกกัน "กดพร้อมกัน" ไม่ได้
     * (มือถือเน็ตช้าแล้วกดส่งซ้ำ / 2 คนกดเบิกงานเดียวกันพร้อมกัน) — ทั้งคู่ผ่านการตรวจเพราะยังไม่มีใบไหน
     * ถูกบันทึก แล้วได้ใบซ้ำ 2 ใบ ด่านสุดท้ายต้องเป็นฐานข้อมูลที่ปฏิเสธตัวที่สองเอง
     */
    activeAdvanceJob: { type: String },

    items: { type: [itemSchema], default: [] },
    total: { type: Number, default: 0, min: 0 },

    // ── เฉพาะ Claim ──────────────────────────────────────────────────────
    /**
     * บัญชีรับเงินของผู้เบิก — ใบ Advance ใช้เป็นบัญชีที่บริษัทโอนเงินล่วงหน้าให้
     * ส่วนใบเคลมใช้เป็นบัญชีรับส่วนต่างที่ต้องจ่ายเพิ่ม/เงินคืนค่าสำรองจ่าย
     * ✅ เป็น "สำเนา" ของบัญชีในทะเบียน (models/BankAccount.js) ตอนบันทึกใบ — แก้/ลบบัญชีในทะเบียนทีหลัง
     * ใบที่ออกไปแล้วต้องไม่เปลี่ยนตาม ⚠️ ค่าทุกช่องมาจากฐานข้อมูลผ่าน resolvePayTo เท่านั้น ไม่เชื่อค่าจาก client
     * ⚠️ ว่างได้ (accountId = "") = ไม่ระบุ/รับเป็นเงินสด
     */
    payTo: {
      accountId: { type: String, default: "" },
      bankCode: { type: String, default: "" },
      bankName: { type: String, default: "" },
      accountNo: { type: String, default: "" },
      accountName: { type: String, default: "" },
    },
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
    /**
     * ✅ ลายเซ็นอิเล็กทรอนิกส์ในใบนี้ (ผู้ใช้ขอ: ตั้งค่าลายเซ็นไว้ที่ user แล้วใช้กับ PDF ทุกใบ)
     * ⚠️ requester ผนึกให้เฉพาะตอน "ผู้เบิกเป็นคนออกใบเอง" — ถ้าแอดมินออกใบแทน ช่องผู้เบิกต้อง
     * ว่างไว้ให้เซ็นมือ เพราะเจ้าตัวยังไม่ได้แสดงเจตนาลงนามในใบนั้น
     * ⚠️ approver ผนึกตอนกดอนุมัติเท่านั้น (ดู routes/expenses.js)
     */
    signatures: {
      requester: sealSchema,
      /** ผู้ตรวจสอบ (ขั้นที่ 1 — ปกติคือแอดมิน) */
      reviewer: sealSchema,
      /** ผู้อนุมัติ (ขั้นที่ 3 — ผู้จัดการแผนกช่าง) */
      approver: sealSchema,
      /**
       * ผู้อนุมัติเบิกจ่าย (ขั้นที่ 4 — ผู้จัดการแผนกช่าง / กรรมการผู้จัดการ)
       * ✅ ผู้ใช้ขอเพิ่มช่องลงนามนี้ · ผนึกตอนกด "อนุมัติเบิกจ่าย" (/pay ของ Advance, /settle ของใบเคลม)
       */
      disburser: sealSchema,
    },
    submittedAt: { type: Date, default: Date.now },
    /**
     * ✅ ขั้นตรวจสอบ (ผู้ใช้สั่ง: แอดมินตรวจสอบก่อน แล้วผู้จัดการอนุมัติอีกที)
     * ⚠️ ใบเก่าก่อนมีขั้นนี้จะไม่มีค่า — หน้าจอ/PDF ต้องรองรับใบที่ไม่มีผู้ตรวจสอบเสมอ
     */
    reviewedBy: personSchema,
    reviewedAt: { type: Date, default: null },
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
expenseSchema.index({ activeAdvanceJob: 1 }, { unique: true, sparse: true });

const Expense = mongoose.model("Expense", expenseSchema);

Expense.KINDS = KINDS;
Expense.CLAIM_TYPES = CLAIM_TYPES;
Expense.STATUS = STATUS;
Expense.CATEGORIES = CATEGORIES;
Expense.FILE_KINDS = FILE_KINDS;
Expense.FILE_STAGES = FILE_STAGES;
Expense.PAYMENT_METHODS = PAYMENT_METHODS;

module.exports = Expense;
