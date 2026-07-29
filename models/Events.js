// models/User.js
const mongoose = require("../db/");
const moment = require("moment");

const eventSchema = new mongoose.Schema(
  {
    docNo: { type: String },
    company: { type: String },
    site: { type: String, required: true },
    title: { type: String, required: true },
    system: { type: String },
    time: { type: String },
    team: { type: String },

    // ✅ วันที่บังคับกรอกเฉพาะงานที่ลงตารางแล้วเท่านั้น — งาน "วางแผนล่วงหน้า" (unscheduled)
    // ยังไม่รู้วันที่แน่นอน จึงต้องปล่อยว่างได้จนกว่าจะถูกลาก/กดลงตารางจริง
    date: { type: Date, required: function () { return !this.unscheduled; } },
    backgroundColor: { type: String, required: true },
    textColor: { type: String, required: true },
    fontSize: { type: Number, required: true },
    start: { type: Date }, // เปลี่ยนเป็นรูปแบบ datetime
    end: { type: Date }, // เปลี่ยนเป็นรูปแบบ datetime
    allDay: { type: Boolean, default: true },
    status: { type: String, required: true, default: "กำลังรอยืนยัน" },
    status_two: { type: String },
    status_three: { type: String },
    isAutoUpdated: { type: Boolean },
    // ผู้ใช้ตั้งสถานะเองผ่านหน้าแก้ไข event ไว้หรือไม่ — ใช้กันไม่ให้ auto-transition
    // (ปรับสถานะเป็น "กำลังดำเนินการ" อัตโนมัติเมื่อถึงวันงาน) ไปทับค่าที่ตั้งเองไว้
    manualStatus: { type: Boolean, default: false },

    subject: { type: String },
    description: { type: String },

    startTime: { type: String },
    endTime: { type: String },

    documentSentQuotation: { type: Boolean, default: false },
    documentSentReport: { type: Boolean, default: false },
    documentSentInvoice: { type: Boolean, default: false },
    documentSentCompletion: { type: Boolean, default: false },

    // เอกสาร 3 ชนิดนี้ไม่ได้ต้องมีทุกงาน — ช่างต้องระบุก่อนว่า "มี" (ต้องแนบไฟล์)
    // หรือ "ไม่มี" (ข้ามได้) — null = ยังไม่ได้ระบุ
    quotationApplicable: { type: Boolean, default: null },
    invoiceApplicable: { type: Boolean, default: null },
    completionApplicable: { type: Boolean, default: null },

    // ✅ ระบบติดตามใบเสนอราคา (quotation tracking) — แยกจาก quotationApplicable/quotationFiles
    // ด้านบนซึ่งบอกแค่ว่า "มีไฟล์ไหม" เท่านั้น ฟิลด์ชุดนี้ติดตามว่าเกิดอะไรขึ้นหลังจากอัพโหลดแล้ว
    // (ส่งลูกค้าหรือยัง / ลูกค้าอนุมัติ-ปฏิเสธ-ขอแก้ไข / ใครเป็นคนบันทึกผล / มูลค่างาน)
    quotationStatus: { type: String, enum: ["sent", "approved", "rejected", "revising"] },
    quotationSentAt: Date,
    quotationDecisionAt: Date,
    quotationDecisionBy: { type: String },
    quotationAmount: { type: Number },
    quotationFollowUpNote: { type: String },

    // ✅ ประวัติการติดตามลูกค้าเรื่องใบเสนอราคาแบบเป็นครั้งๆ (ครั้งที่ 1, 2, 3...) — ช่างหรือแอดมิน/
    // manager คนไหนก็บันทึกได้ (คนที่โทร/คุยกับลูกค้าจริงมักเป็นช่าง) แนบหลักฐานได้ถ้ามี (ไม่บังคับ)
    // attemptNumber คำนวณฝั่ง backend เสมอ (ห้ามรับจาก client) กันเลขซ้ำ/สลับกันตอนมีคนกดพร้อมกัน
    quotationFollowUps: [
      {
        attemptNumber: Number,
        note: String,
        contactedAt: { type: Date, default: Date.now },
        userId: String,
        userName: String,
        evidenceFileName: String,
        evidenceFileUrl: String,
        evidenceFileType: String,
      },
    ],

    // ✅ เอกสารแต่ละชนิดแนบได้หลายไฟล์ (array) — แต่ละไฟล์มี _id ของตัวเองในตัว
    // ไว้ใช้อ้างอิงตอนลบไฟล์เดียวออกจากชุด โดยไม่กระทบไฟล์อื่นในชนิดเดียวกัน
    quotationFiles: [
      {
        fileName: String,
        fileUrl: String,
        fileType: String,
        uploadedAt: { type: Date, default: Date.now },
      },
    ],
    reportFiles: [
      {
        fileName: String,
        fileUrl: String,
        fileType: String,
        uploadedAt: { type: Date, default: Date.now },
      },
    ],
    invoiceFiles: [
      {
        fileName: String,
        fileUrl: String,
        fileType: String,
        uploadedAt: { type: Date, default: Date.now },
      },
    ],
    completionFiles: [
      {
        fileName: String,
        fileUrl: String,
        fileType: String,
        uploadedAt: { type: Date, default: Date.now },
      },
    ],

    statusFileName: { type: String },
    statusFileUrl: { type: String },
    statusFileType: { type: String },

    trackStatus1: { type: Boolean, default: false },
    trackStatus1FileName: String,
    trackStatus1FileUrl: String,
    trackStatus1FileType: String,

    trackStatus2: { type: Boolean, default: false },
    trackStatus2FileName: String,
    trackStatus2FileUrl: String,
    trackStatus2FileType: String,

    trackStatus3: { type: Boolean, default: false },
    trackStatus3FileName: String,
    trackStatus3FileUrl: String,
    trackStatus3FileType: String,

    trackStatus4: { type: Boolean, default: false },
    trackStatus4FileName: String,
    trackStatus4FileUrl: String,
    trackStatus4FileType: String,

    trackStatusConfirm: { type: Boolean, default: false },
    trackStatusConfirmFileName: String,
    trackStatusConfirmFileUrl: String,
    trackStatusConfirmFileType: String,

    documentFile: { type: String }, // ✅ สำหรับชื่อไฟล์หลักฐาน

    resPerson: { type: String }, // ✅ สำหรับชื่อไฟล์หลักฐาน

    // ✅ ลูกทีมเพิ่มเติม (คนที่ 2, 3, ...) — แสดงผลอย่างเดียวว่าใครช่วยทำงานนี้บ้าง ไม่มีผลต่อ
    // สิทธิ์แก้ไข/การแจ้งเตือน/การนับงานค้าง ฯลฯ ซึ่งยังผูกกับ team/resPerson (ช่างหลัก) เหมือนเดิม
    teamMembers: [
      {
        userId: String,
        name: String,
      },
    ],

    // ✅ ผูกงานที่เข้าหลายวันแบบไม่ติดกัน (เช่น PM ครั้งที่ 1 ต้องแบ่งเข้า 3 วัน) ให้รู้ว่า
    // เป็น "งานเดียวกัน" — สร้างตอน POST /events ครั้งแรก ทุก record ในชุดเดียวกันจะได้ค่านี้ตรงกัน
    jobGroupId: { type: String, index: true },

    // ✅ ผูก "ครั้งที่ 1-N" ของสัญญาเดียวกันเข้าด้วยกัน (คนละแนวคิดกับ jobGroupId ด้านบนซึ่งผูก
    // วันที่ไม่ติดกันของ "1 ครั้ง" เดียว) — ทุก event ที่เป็นคนละครั้งแต่สัญญาเดียวกันจะได้ค่านี้ตรงกัน
    // พร้อมข้อมูลสัญญาที่ copy ไว้ซ้ำกันทุก record (เหมือน company/system ที่ทำอยู่แล้ว) ใช้แสดงผล
    // แบบตาราง 1 แถวต่อสัญญาในหน้า "ภาพรวมสัญญา" — แก้ไขข้อมูลสัญญาต้องผ่าน PUT /events/contract/:id
    // เพื่อให้อัปเดตพร้อมกันทุก record กันข้อมูลสัญญาเพี้ยนไม่ตรงกันระหว่างครั้ง
    contractGroupId: { type: String, index: true },
    contractNo: { type: String },
    quotationNo: { type: String },
    contractStart: Date,
    contractEnd: Date,
    visitCount: Number,
    jobValue: Number,

    // ✅ งาน "วางแผนล่วงหน้า" — บันทึกไว้ก่อนว่ามีงานนี้แน่ๆ แต่ยังไม่ได้กำหนดวันที่ลงตาราง
    // จัดกลุ่มแสดงผลตามเดือนที่ตั้งใจ (plannedMonth) แล้วค่อยลาก/กดลงตารางจริงทีหลัง
    // (ดู POST /events/draft, GET /events/drafts, PUT /events/:id/schedule)
    unscheduled: { type: Boolean, default: false, index: true },
    plannedMonth: { type: String }, // รูปแบบ "YYYY-MM"

    checkInTime: Date,
    checkOutTime: Date,
    checkedInAt: Date,
    checkedOutAt: Date,
    workNote: String,

    closeRequested: { type: Boolean, default: false },
    closeRequestedAt: Date,
    closeRequestedBy: String,
    // ✅ userId ของช่างที่กดขอปิดงานจริงๆ (closeRequestedBy เป็นแค่ชื่อ ใช้แจ้งเตือน push แบบเจาะจงตัวคนไม่ได้
    // เพราะ resPerson/userId ของ event อาจไม่ตรงกับคนที่กดขอปิดงานจริง เช่น มอบหมายผ่านชื่อทีมแบบเก่า)
    closeRequestedByUserId: String,
    closeApprovedAt: Date,
    closeApprovedBy: String,
    closeRejectedAt: Date,
    closeRejectedBy: String,
    closeRejectReason: String,
    activityLog: [
      {
        userId: String,
        userName: String,
        action: String, // "check_in" | "check_out" | "note_updated" | "file_uploaded"
        timestamp: Date,
        detail: String,
      },
    ],

    // ✅ ช่องทางคุยโต้ตอบกันระหว่างช่างกับแอดมิน/manager แยกจาก activityLog
    // (activityLog เป็น log อัตโนมัติของระบบ ส่วนนี้คือข้อความที่คนพิมพ์เอง เช่น "ขอใบเสนอราคางานนี้")
    comments: [
      {
        userId: String,
        userName: String,
        role: String,
        message: String,
        timestamp: { type: Date, default: Date.now },
      },
    ],

    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    lastModifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true },
);

// ใช้ pre middleware ในการแปลง string เป็น datetime ก่อนเก็บลงฐานข้อมูล
eventSchema.pre("save", function (next) {
  if (this.start && typeof this.start === "string") {
    this.start = moment(this.start).toDate();
  }
  if (this.end && typeof this.end === "string") {
    this.end = moment(this.end).toDate();
  }
  next();
});

// ✅ เช็คช่างชนกัน (double-booking) ต้อง query ตาม resPerson + ช่วงวันที่ทุกครั้งที่สร้าง/แก้ไขงาน
// เดิมไม่มี index รองรับเลย (มีแค่ jobGroupId/unscheduled แยกฟิลด์เดี่ยวๆ) query จะช้าเมื่อข้อมูลเยอะขึ้น
eventSchema.index({ resPerson: 1, start: 1, end: 1 });

const Events = mongoose.model("CalendarEvent", eventSchema);

module.exports = Events;
