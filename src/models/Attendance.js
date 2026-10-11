/**
 * Attendance — บันทึกเช็คอิน/เช็คเอาต์ของช่าง (10 ต.ค. 2569)
 *
 * 1 เอกสาร = ช่าง 1 คน เข้างาน 1 ครั้ง (เช็คอิน → เช็คเอาต์) ของงาน 1 วัน (eventId)
 *   งานหลายวัน (jobGroupId เดียวกัน) แต่ละวันมีบันทึกของตัวเอง · ลูกทีมหลายคนเช็คอินแยกกันได้
 *
 * 🔒 เวลาทุกจุดมาจาก server (new Date() ตอนรับคำขอ) — ไม่รับเวลาจากเครื่องช่างเลย
 *    แก้เวลาได้ทางเดียว: ยื่นคำขอ (corrections) → แอดมินอนุมัติ — เก็บประวัติทุกครั้ง ไม่ลบ
 * ✅ createdAt (timestamps) = เวลาที่ระบบสร้างรายการ · checkIn.at = เวลาเช็คอิน (แก้ได้ผ่านคำขอเท่านั้น)
 */
const mongoose = require("../db");

const photoSchema = new mongoose.Schema(
  { fileId: String, fileUrl: String, fileName: String, fileType: String },
  { _id: false }
);

/** จุดเวลา + ตำแหน่ง (ใช้ทั้งเช็คอินและเช็คเอาต์) */
const stampFields = {
  at: Date,
  // gps: "ok" ได้พิกัด · "denied" ผู้ใช้ไม่อนุญาต · "unavailable" เครื่องหาตำแหน่งไม่ได้/หมดเวลา
  gps: { type: String, enum: ["ok", "denied", "unavailable"], default: "unavailable" },
  lat: Number,
  lng: Number,
  accuracy: Number, // เมตร (ค่าความคลาดเคลื่อนจากเครื่อง)
  distanceM: Number, // ระยะห่างจากพิกัดหน้างาน (มีเมื่อรู้พิกัดทั้งสองฝั่ง)
  photos: [photoSchema],
};

const correctionSchema = new mongoose.Schema({
  field: { type: String, enum: ["checkIn", "checkOut"], required: true },
  fromAt: Date,
  toAt: { type: Date, required: true },
  reason: { type: String, default: "" },
  requestedBy: String,
  requestedByUserId: String,
  requestedAt: { type: Date, default: Date.now },
  status: { type: String, enum: ["pending", "approved", "rejected", "superseded"], default: "pending" },
  decidedBy: String,
  decidedAt: Date,
  decisionNote: { type: String, default: "" },
});

const attendanceSchema = new mongoose.Schema(
  {
    eventId: { type: mongoose.Schema.Types.ObjectId, ref: "CalendarEvent", required: true, index: true },
    jobGroupId: { type: String, index: true },
    // ภาพจำของงานตอนเช็คอิน — รายงานย้อนหลังยังอ่านออกแม้งานถูกแก้ชื่อ/ลบไปแล้ว
    jobLabel: { type: String, default: "" },
    jobNo: { type: String, default: "" },

    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    userName: { type: String, default: "" },
    // ✅ (10 ต.ค. 2569) เช็คอินเป็นของ "ทีม" — หัวหน้าทีมเข้างานกด · เก็บรายชื่อลูกทีม ณ ตอนเช็คอินไว้ด้วย
    team: { head: { type: String, default: "" }, members: [String] },

    status: { type: String, enum: ["checked_in", "checked_out"], default: "checked_in", index: true },

    // พิกัดหน้างาน (ได้จากลิงก์ Google Maps ในทะเบียนลูกค้า) — ใช้คำนวณระยะห่าง
    site: { lat: Number, lng: Number },
    // เช็คอินนอกวันที่นัดไว้ในตาราง (ไม่บล็อก แค่ติดป้ายให้แอดมินเห็น)
    offSchedule: { type: Boolean, default: false },

    checkIn: {
      ...stampFields,
      note: { type: String, default: "" },
    },
    checkOut: {
      ...stampFields,
      summary: { type: String, default: "" },
      issues: { type: String, default: "" },
      partsNeeded: { type: String, default: "" },
      // done = ทำงานเสร็จแล้ว · continue = รอดำเนินการต่อ · waiting_parts = รออะไหล่
      result: { type: String, enum: ["", "done", "continue", "waiting_parts"], default: "" },
      // ✅ Service Report ที่แนบตอนเช็คเอาต์ — เก็บเข้า "เอกสารประจำงาน" (Events.reportFiles) ใช้ขอปิดงานได้ทันที
      reports: [photoSchema],
    },

    durationMin: { type: Number, default: 0 },

    corrections: [correctionSchema],
    hasPendingCorrection: { type: Boolean, default: false, index: true },
  },
  { timestamps: true }
);

attendanceSchema.index({ userId: 1, status: 1 });
attendanceSchema.index({ "checkIn.at": -1 });

const Attendance = mongoose.model("Attendance", attendanceSchema);
module.exports = Attendance;
