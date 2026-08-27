const mongoose = require("../db");
const { DEPARTMENT } = require("../config/roles");

/**
 * Dispatch — "ใบมอบหมายงาน" ที่แผนกหนึ่งส่งให้อีกแผนกหนึ่ง
 *
 * ── ทำไมเป็นคอลเลกชันใหม่ ไม่ฟื้น WorkOrder เดิม ──────────────────────────
 * models/WorkOrder.js มีอยู่ในระบบแต่ไม่เคยถูกใช้จริงเลย (0 document) และหน้า "งานของฉัน" ก็เคย
 * ย้ายออกจากมันไปแล้วเพราะเหตุผลเดียวกัน — ที่สำคัญคือโครงเดิมขัดกับข้อกำหนดรอบนี้ทุกข้อ:
 *   • `eventId: required`  → ใบมอบหมายต้องสร้างได้โดยยังไม่มีงานในปฏิทิน (ผู้ใช้ระบุ "อิสระ ผูกงานได้")
 *   • `assignedTo` คนเดียว → ต้อง "แยกเป็นแต่ละคน" หลายคนต่อหนึ่งใบ พร้อมสถานะ/บันทึก/รูปของตัวเอง
 *   • ไม่มีแนวคิดเรื่องแผนก → ข้อกำหนดบอกชัดว่าต้องต่อยอดไปแผนกอื่นในอนาคตได้
 *   • `progress` เป็นก้อนเดียว → ยุบความคืบหน้าของทุกคนรวมกัน แยกไม่ออกว่าใครทำถึงไหน
 * เหลือใช้ได้แค่ชื่อ จึงสร้างใหม่แล้วลบของเดิมทิ้ง ไม่ปล่อยให้มี 2 ระบบที่หน้าตาคล้ายกัน
 */

/** สถานะรายคน — คนละชุดกับสถานะของทั้งใบ (ดู DISPATCH_STATUS) */
const ASSIGNEE_STATUS = ["assigned", "acknowledged", "in_progress", "done", "declined"];

/**
 * สถานะของทั้งใบ
 * ⚠️ คำนวณจากสถานะรายคนเสมอ (ดู recomputeStatus ด้านล่าง) ห้ามให้ client ส่งมาตั้งเอง —
 * ไม่งั้นจะเกิดกรณี "ใบขึ้นว่าเสร็จแล้ว แต่ยังมีช่างค้างอยู่ 2 คน" ซึ่งไล่หาสาเหตุยากมาก
 */
// ⚠️ rejected อยู่ระหว่าง requested กับ assigned โดยตั้งใจ — เป็น "ตีกลับให้แก้" ไม่ใช่จุดจบของใบ
// ผู้ขอแก้แล้วกดส่งใหม่ได้ (POST /:id/resubmit) ใบเดิมจึงกลับไปเป็น requested ไม่ต้องสร้างใบใหม่
// ให้เลขที่ใบวิ่งเกินจริง และประวัติการตีกลับยังอยู่ครบใน activityLog
// 🧹 in_progress/done ถูกตัดออก — ความคืบหน้าหลังลงตารางอ่านจากสถานะงานจริงของช่างแทน
// (ดู attachJob ใน routes/dispatch.js) การมีสถานะซ้อนกัน 2 ชุดคือต้นเหตุที่ใบค้างไม่ตรงกับงานจริง
const DISPATCH_STATUS = ["requested", "rejected", "assigned", "cancelled"];

/**
 * ชนิดเอกสารที่แนบมากับใบแจ้งงาน
 * ⚠️ "quotation"/"po" คือเอกสารการค้าที่ยืนยันว่างานนี้ปิดการขายแล้วจริง — หน้าจอแยกโชว์ให้เด่น
 * ต่างจากรูปหน้างาน เพราะเป็นสิ่งที่ผู้จัดการต้องเห็นก่อนกดอนุมัติลงแผนงาน
 */
const DOC_TYPES = ["quotation", "po", "site_photo", "drawing", "other"];

const fileSchema = {
  docType: { type: String, enum: DOC_TYPES, default: "other" },
  fileName: String,
  fileUrl: String,
  fileType: String,
  uploadedAt: { type: Date, default: Date.now },
  uploadedBy: String,
};

const dispatchSchema = new mongoose.Schema(
  {
    dispatchNo: { type: String, unique: true, sparse: true, index: true },

    /**
     * แผนกที่รับงานใบนี้ — ตัวที่ทำให้ระบบนี้ต่อยอดไปแผนกอื่นได้
     * เพิ่มแผนกใหม่ = เพิ่มค่าใน src/config/roles.js แล้วผูก role ใหม่เข้ากับแผนกนั้น ไม่ต้องแก้ schema
     */
    department: {
      type: String,
      default: DEPARTMENT.SERVICE,
      index: true,
    },

    status: { type: String, enum: DISPATCH_STATUS, default: "requested", index: true },

    // ── ผู้ขอ ─────────────────────────────────────────────────────────
    // ⚠️ เซลเห็นเฉพาะใบที่ requestedBy.userId เป็นตัวเอง (ตามที่ผู้ใช้เลือก: "เห็นเฉพาะงานที่ตัวเองส่งให้")
    requestedBy: {
      userId: { type: String, index: true },
      name: { type: String, default: "" },
      role: { type: String, default: "" },
    },
    requestedAt: { type: Date, default: Date.now, index: true },

    // ── การตรวจสอบของผู้จัดการ/แอดมิน ────────────────────────────────
    // ⚠️ ใบจากต่างแผนกต้องผ่านคนกลางก่อนเสมอ — เซลไม่รู้ว่าคิวช่างว่างไหม/งานซ้ำกับที่รับไปแล้วหรือเปล่า
    // ถ้าปล่อยให้เข้าตารางงานตรงๆ จะกลายเป็นใครก็ยัดงานให้ช่างได้โดยไม่มีใครดูภาพรวม
    reviewedBy: {
      userId: { type: String, default: "" },
      name: { type: String, default: "" },
    },
    reviewedAt: Date,
    // เหตุผลที่ไม่อนุมัติ — บังคับกรอกที่ route ไม่งั้นผู้ขอไม่มีทางรู้ว่าต้องแก้อะไร
    rejectedReason: { type: String, default: "" },
    // ส่งใหม่มากี่รอบแล้ว — ใบที่วนหลายรอบคือสัญญาณว่าฟอร์มยังขาดข้อมูลอะไรบางอย่างเป็นระบบ
    resubmitCount: { type: Number, default: 0 },

    // ── ที่มา (ผูกได้ ไม่บังคับ) ────────────────────────────────────────
    // ⚠️ eventId ถูกเติมทีหลัง ตอนที่แอดมิน/ช่างเอาคำขอใบนี้ไปลงแผนงานจริง —
    // เป็นเส้นเชื่อมเดียวระหว่าง "ใบแจ้งงานจากเซล" กับ "แผนงานของช่าง"
    eventId: { type: mongoose.Schema.Types.ObjectId, ref: "CalendarEvent", index: true },

    // ── ลูกค้า / หน้างาน ──────────────────────────────────────────────
    customer: {
      company: { type: String, default: "" },
      site: { type: String, default: "" },
      address: { type: String, default: "" },
      /**
       * ลิงก์ตำแหน่งจริงบน Google Maps
       * ✅ ที่อยู่ที่พิมพ์เป็นตัวหนังสือพาช่างไปผิดที่ได้บ่อยมาก (ชื่อโครงการซ้ำกัน ซอยแยกย่อย
       * ตึกไม่มีเลขที่ชัดเจน) — พิกัดจริงคือสิ่งเดียวที่ไม่กำกวม
       * ⚠️ เก็บเป็น URL ที่ผู้ใช้แปะมาตรงๆ ไม่แกะเป็น lat/lng — ลิงก์ที่แชร์จาก Google Maps มี
       * หลายรูปแบบมาก (maps.app.goo.gl ย่อ, /place/, ?q=, พิกัดใน URL) การพยายามแกะเองจะพัง
       * เงียบๆ กับรูปแบบที่ไม่ได้เผื่อไว้ ส่วนการเปิดลิงก์ตรงๆ ใช้ได้กับทุกรูปแบบเสมอ
       */
      mapUrl: { type: String, default: "" },
      contactName: { type: String, default: "" },
      contactTel: { type: String, default: "" },
    },

    // ── เนื้องานที่แจ้ง ───────────────────────────────────────────────
    title: { type: String, required: true },
    detail: { type: String, default: "" },
    /**
     * หมายเหตุเพิ่มเติมจากผู้แจ้ง
     * 🧹 มาแทน checklist/parts เดิมตามที่ผู้ใช้สั่ง — ของจริงคนแจ้งไม่ได้แจกแจงเป็นข้อๆ ให้ช่าง
     * (คนแจ้งเป็นเซล ไม่ได้รู้ขั้นตอนหน้างานดีกว่าช่างอยู่แล้ว) เขียนเป็นข้อความสั้นๆ ตรงกว่า
     * ⚠️ ฟิลด์ checklist/parts ยังอยู่ใน schema เพราะใบเก่าที่กรอกไว้แล้วต้องแสดงผลได้ต่อ
     */
    note: { type: String, default: "" },
    system: { type: String, default: "" },
    priority: { type: String, enum: ["normal", "urgent"], default: "normal", index: true },
    dueAt: { type: Date, index: true },

    /** รูป/เอกสารประกอบที่ผู้ขอแนบมา (รูปหน้างาน แบบแปลน ใบเสนอราคา ฯลฯ) */
    attachments: [fileSchema],

    /** สิ่งที่ต้องทำ — ติ๊กได้รายข้อ พร้อมบันทึกว่าใครติ๊กเมื่อไหร่ */
    checklist: [
      {
        item: { type: String, required: true },
        done: { type: Boolean, default: false },
        doneByUserId: String,
        doneByName: String,
        doneAt: Date,
      },
    ],

    /** อะไหล่/อุปกรณ์ที่ต้องเตรียมไปหน้างาน */
    parts: [
      {
        name: { type: String, required: true },
        qty: { type: Number, default: 1 },
        unit: { type: String, default: "" },
        note: { type: String, default: "" },
      },
    ],

    /**
     * ── ผู้รับงาน แยกเป็นรายคน ──────────────────────────────────────
     * ⚠️ นี่คือข้อกำหนด "แยกเป็นแต่ละคน" — แต่ละคนมีสถานะ เวลา บันทึก และไฟล์ของตัวเอง
     * ห้ามยุบเป็นสถานะเดียวของทั้งใบเด็ดขาด ไม่งั้นจะตอบไม่ได้ว่าใครรับทราบแล้ว ใครยังไม่เริ่ม
     */
    assignees: [
      {
        userId: { type: String, required: true },
        name: { type: String, default: "" },
        role: { type: String, default: "" },
        assignedAt: { type: Date, default: Date.now },
        assignedByUserId: String,
        assignedByName: String,

        status: { type: String, enum: ASSIGNEE_STATUS, default: "assigned" },
        ackAt: Date,          // กดรับทราบ
        startedAt: Date,
        finishedAt: Date,
        declineReason: String,

        note: { type: String, default: "" },   // บันทึกของคนนี้คนเดียว
        attachments: [fileSchema],             // รูปที่คนนี้ส่งกลับ (เช่น รูปหลังทำงาน)
      },
    ],

    cancelReason: { type: String, default: "" },

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

/**
 * ✅ คำนวณสถานะของทั้งใบจากสถานะรายคน — จุดเดียวในระบบที่กำหนดสถานะใบ
 * ⚠️ ต้องเรียกทุกครั้งหลังแก้ assignees ไม่งั้นสถานะใบกับความจริงจะเพี้ยนแยกกันเงียบๆ
 * กฎ: ยังไม่มอบหมาย = requested · ทุกคนจบ = done · มีคนเริ่ม/รับทราบแล้ว = in_progress · ที่เหลือ = assigned
 * (คนที่ปฏิเสธงานไม่ถูกนับ — ถ้าปฏิเสธกันหมดถือว่ากลับไปเป็น requested รอจ่ายใหม่)
 */
dispatchSchema.methods.recomputeStatus = function recomputeStatus() {
  if (this.status === "cancelled") return this.status;
  // ⚠️ ใบที่ถูกตีกลับต้องค้างสถานะไว้จนกว่าผู้ขอจะกดส่งใหม่ — ถ้าปล่อยให้คำนวณต่อ จะเด้งกลับเป็น
  // "requested" ทันที (เพราะยังไม่มีผู้รับงาน) แล้วใบจะหายไปจากรายการ "ถูกตีกลับ" ของเซลเงียบๆ
  if (this.status === "rejected") return this.status;

  // ⚠️ "มอบหมายแล้ว" ต้องแปลว่า *ลงตารางงานแล้วจริง* เท่านั้น
  //
  // 🐛 ที่แก้ (ผู้ใช้แจ้งว่าสับสน): เดิมพอมี assignees ก็ตั้งเป็น "assigned" ทันที ทำให้ใบขึ้นป้าย
  // "มอบหมายแล้ว" ทั้งที่ยังไม่มีวันเข้างาน — แล้วในกล่องเดียวกันมีแถบเตือนว่า "ยังไม่ได้ลงแผนงาน"
  // สองอย่างนี้ขัดกันเองบนหน้าจอเดียว คนอ่านไม่รู้ว่าตกลงงานนี้จ่ายไปแล้วหรือยัง
  //
  // ✅ ไม่มี eventId = ยังอยู่ในคิวรอตัดสินใจเสมอ ไม่ว่าจะเลือกช่างไว้แล้วหรือไม่
  if (!this.eventId) {
    this.status = "requested";
    return this.status;
  }

  const active = (this.assignees || []).filter((a) => a.status !== "declined");
  this.status = active.length === 0 ? "requested" : "assigned";
  return this.status;
};

dispatchSchema.index({ "assignees.userId": 1, status: 1 });
dispatchSchema.index({ department: 1, status: 1, requestedAt: -1 });

const Dispatch = mongoose.model("Dispatch", dispatchSchema);
Dispatch.DOC_TYPES = DOC_TYPES;
Dispatch.DISPATCH_STATUS = DISPATCH_STATUS;
Dispatch.ASSIGNEE_STATUS = ASSIGNEE_STATUS;

module.exports = Dispatch;
