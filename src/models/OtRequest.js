const mongoose = require("../db");

/**
 * OtRequest — ใบขออนุมัติทำงานล่วงเวลา (OT)
 *
 * ✅ ผู้ใช้สั่ง (28 ก.ย. 2569): "ทำระบบเบิกโอทีด้วย ให้มืออาชีพ และสมบูรณ์"
 *   • ตัวคูณตั้งค่าได้ (ตั้งค่าองค์กร › otMultipliers) — ค่าเริ่มต้นตามกฎหมายแรงงาน: OT วันทำงาน ×1.5 ·
 *     ทำงานวันหยุด ×1 · OT วันหยุด ×3
 *   • พนักงานยื่นของตัวเอง หรือหัวหน้างานยื่นให้ทั้งทีมในใบเดียว (1 บรรทัด = 1 คน 1 ช่วงเวลา)
 *   • ทุกบรรทัดผูกงาน + เวลาเริ่ม-เลิก — ระบบคำนวณชั่วโมงเอง
 *   • อนุมัติแล้ว "รวมจ่ายกับเงินเดือน" — ไม่มีขั้นโอนเงินรายใบ ฝ่ายบัญชีปิดรอบจ่ายรายเดือน (payroll)
 *
 * วงจร: pending (รอตรวจสอบ) → reviewed (รออนุมัติ) → approved (รอรวมจ่ายเงินเดือน) → paid (จ่ายในรอบเงินเดือนแล้ว)
 *       pending ⇄ rejected (ตีกลับให้แก้) · cancelled
 *
 * ⚠️ ชั่วโมง/ค่าจ้างต่อชั่วโมง/ยอดเงิน คำนวณที่ server เสมอ — ค่าจ้างต่อชั่วโมงมาจาก OtWage (ข้อมูลลับ)
 * ⚠️ เป็นคนละคอลเลกชันกับ Expense โดยตั้งใจ — OT ไม่ใช่เงินที่จ่ายรายใบ ไม่มีบัญชีรับเงิน/ส่วนต่าง/ใบเสร็จ
 */

const OT_TYPES = ["workdayOT", "holidayWork", "holidayOT"];
const STATUS = ["pending", "reviewed", "rejected", "approved", "paid", "cancelled"];

const personSchema = { userId: { type: String, default: "" }, name: { type: String, default: "" } };

const lineSchema = new mongoose.Schema(
  {
    /** พนักงานที่ทำ OT บรรทัดนี้ — ต้องเป็นคนในระบบ (มีค่าจ้างต่อชั่วโมงในทะเบียน) */
    person: { userId: { type: String, required: true }, name: { type: String, default: "" } },
    /** วันที่ทำ (12:00 UTC ของวันนั้น เหมือนระบบเบิก) */
    date: { type: Date, required: true },
    type: { type: String, enum: OT_TYPES, default: "workdayOT" },
    /** "HH:mm" — เลิกน้อยกว่าเริ่ม = ข้ามเที่ยงคืน */
    start: { type: String, required: true },
    end: { type: String, required: true },
    /** พักระหว่าง OT (นาที) หักออกจากชั่วโมง */
    breakMin: { type: Number, default: 0, min: 0 },
    hours: { type: Number, default: 0, min: 0 },
    /** snapshot ตัวคูณ/ค่าจ้างต่อชั่วโมง ณ ตอนบันทึก — แก้ตั้งค่าทีหลังใบเก่าไม่เปลี่ยน */
    multiplier: { type: Number, default: 1.5 },
    hourlyRate: { type: Number, default: 0 },
    amount: { type: Number, default: 0 },
    /** งานที่ทำ OT (ไม่บังคับ) + snapshot ชื่องาน */
    eventId: { type: String, default: "" },
    jobTitle: { type: String, default: "" },
    task: { type: String, default: "", trim: true },
  },
  { _id: true }
);

const otRequestSchema = new mongoose.Schema(
  {
    docNo: { type: String, unique: true, sparse: true, index: true },
    status: { type: String, enum: STATUS, default: "pending", index: true },
    docDate: { type: Date, default: Date.now, index: true },
    subject: { type: String, default: "", trim: true },
    note: { type: String, default: "", trim: true },
    /** ผู้ยื่น (ตัวเอง หรือหัวหน้างานยื่นให้ทีม) */
    requester: { userId: { type: String, index: true, default: "" }, name: { type: String, default: "" }, position: { type: String, default: "" } },
    createdBy: personSchema,
    lines: { type: [lineSchema], default: [] },
    /** userId ทุกคนในบรรทัด — ใช้หาใบที่ "ฉันมีชื่ออยู่" (ขอบเขตการมองเห็นของพนักงาน) */
    memberIds: { type: [String], default: [], index: true },
    totalHours: { type: Number, default: 0 },
    totalAmount: { type: Number, default: 0 },
    /** รอบเงินเดือน "YYYY-MM" = เดือนของวันทำ OT วันสุดท้ายในใบ — ใช้ปิดรอบจ่าย */
    period: { type: String, default: "", index: true },
    submittedAt: { type: Date, default: Date.now },
    reviewedBy: personSchema,
    reviewedAt: { type: Date, default: null },
    approvedBy: personSchema,
    approvedAt: { type: Date, default: null },
    rejectedBy: personSchema,
    rejectedAt: { type: Date, default: null },
    rejectReason: { type: String, default: "" },
    /** ปิดรอบจ่ายพร้อมเงินเดือน */
    payroll: {
      period: { type: String, default: "" },
      at: { type: Date, default: null },
      by: personSchema,
      note: { type: String, default: "" },
    },
    cancelledBy: personSchema,
    cancelledAt: { type: Date, default: null },
    cancelReason: { type: String, default: "" },
    activityLog: [{ action: String, detail: String, userId: String, userName: String, timestamp: { type: Date, default: Date.now } }],
  },
  { timestamps: true }
);

otRequestSchema.index({ status: 1, period: 1 });

const OtRequest = mongoose.model("OtRequest", otRequestSchema);
OtRequest.OT_TYPES = OT_TYPES;
OtRequest.STATUS = STATUS;
module.exports = OtRequest;
