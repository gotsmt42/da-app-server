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

    // ✅ "ผู้รับผิดชอบ" — คนละแนวคิดกับ team ด้านบน (team คือใครเข้างานจริงในแต่ละครั้ง เปลี่ยนได้ทุกครั้ง
    // ที่มอบหมายคนอื่นไปทำแทน) ตัวนี้คือคนที่รับผิดชอบสัญญา/ลูกค้ารายนี้โดยรวม แก้ไขแยกจาก team ได้อิสระ
    // ผ่านหน้า "ภาพรวมงาน" (ContractOverview.js) — ไม่ได้ตั้งอัตโนมัติตามทีมที่เลือกอีกต่อไปเหมือน
    // resPerson ด้านล่าง ปล่อยว่างได้ (ฝั่งจอ fallback ไปใช้ค่า team เดิมแสดงแทนถ้ายังไม่เคยตั้งค่านี้)
    responsiblePerson: { type: String },
    responsiblePersonId: { type: String },

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

    // ✅ ระบบติดตามการวางบิล/รับเงิน (billing & AR) — "ครึ่งท้าย" ของสายงานที่เดิมขาดไปทั้งท่อน
    // เดิมระบบรู้แค่ "มูลค่าสัญญา" (jobValue) กับ "ยอดที่เสนอราคาไป" (quotationAmount) และรู้แค่ว่า
    // ส่งใบแจ้งหนี้แล้วหรือยัง (documentSentInvoice เป็น boolean เฉยๆ) — ตอบไม่ได้เลยว่าเดือนนี้
    // วางบิลไปเท่าไร เก็บเงินได้เท่าไร ค้างรับเท่าไร ใครค้างนานสุด
    //
    // ⚠️ เก็บที่ระดับ "งานแต่ละครั้ง" (event) ไม่ใช่ระดับสัญญา — ตามที่บริษัทวางบิลจริงคือวางบิลต่อ
    // ครั้งที่เข้างาน (สัญญา 4 ครั้ง = วางบิล 4 ใบ) ถ้าเก็บที่ระดับสัญญาจะบันทึกแยกครั้งไม่ได้เลย
    //
    // ⚠️ ยอดทุกตัวถูก "คำนวณแล้วเก็บค่าไว้" ตอนบันทึก ไม่ได้คำนวณสดตอนอ่าน — เพราะอัตรา VAT/หัก ณ
    // ที่จ่ายเปลี่ยนได้ในอนาคต ถ้าคำนวณสดจากอัตราปัจจุบัน ใบที่วางบิลไปเมื่อ 2 ปีก่อนจะเปลี่ยนยอดตาม
    // ไปด้วยเงียบๆ ทั้งที่ยอดจริงที่ออกให้ลูกค้าไปแล้วเปลี่ยนไม่ได้ (ดู computeBillingAmounts ฝั่ง route)
    billing: {
      invoiceNo: { type: String, default: "" },
      invoicedAt: { type: Date, default: null, index: true },
      // เครดิตเทอม: จำนวนวันที่ให้ลูกค้าชำระนับจากวันวางบิล
      creditTermDays: { type: Number, default: 30 },
      // ⚠️ เก็บ dueAt ไว้เลย ไม่คำนวณสดจาก invoicedAt + creditTermDays ทุกครั้ง — เพื่อให้ query
      // "ใบไหนเลยกำหนดชำระแล้วบ้าง" ทำที่ฐานข้อมูลได้ตรงๆ และมี index ช่วย (ตัวเตือนใช้ทุกวัน)
      dueAt: { type: Date, default: null, index: true },

      // ยอดก่อนภาษี = ฐานคำนวณของทุกตัวด้านล่าง
      amountBeforeVat: { type: Number, default: 0 },
      vatRate: { type: Number, default: 7 },
      vatAmount: { type: Number, default: 0 },
      // ภาษีหัก ณ ที่จ่าย — งานบริการนิติบุคคลโดนหัก 3% คิดจาก "ยอดก่อน VAT" เสมอ
      whtRate: { type: Number, default: 3 },
      whtAmount: { type: Number, default: 0 },
      // ยอดที่ลูกค้าต้องโอนจริง = ก่อน VAT + VAT − หัก ณ ที่จ่าย
      netAmount: { type: Number, default: 0 },

      // ✅ รับเงินแบ่งจ่ายได้ — เก็บเป็นรายการ ไม่ใช่ช่องเดียว เพราะลูกค้าจ่ายมัดจำ/แบ่งงวดได้จริง
      // ยอดที่รับแล้วทั้งหมด = ผลรวมของรายการนี้ (ไม่เก็บยอดรวมซ้ำอีกช่อง กันตัวเลข 2 ที่ไม่ตรงกัน)
      payments: [
        {
          amount: { type: Number, required: true },
          paidAt: { type: Date, required: true },
          method: { type: String, default: "" },
          note: { type: String, default: "" },
          recordedBy: { type: String, default: "" },
          recordedByName: { type: String, default: "" },
          recordedAt: { type: Date, default: Date.now },
        },
      ],
      note: { type: String, default: "" },
    },

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
    // ✅ ระยะห่างระหว่างรอบเข้าบำรุงรักษา (เดือน) — เช่น 3 = เข้าทุก 3 เดือน — เป็นข้อมูลอ้างอิงอิสระจาก
    // visitCount เท่านั้น (ไม่ผูก/คำนวณทับกัน เพราะงานจริงเลื่อน/ชนกันได้เสมอ จำนวนครั้งจริงต้องให้
    // ผู้ใช้กำหนดเอง) ใช้เป็นเกณฑ์เตือน "เลยกำหนดรอบถัดไป" แทนค่าตายตัว 3 เดือนเดิม (ดู
    // nextVisitOverdueInfo/checkAndNotifyOverdueContracts) — สัญญาเก่าที่ไม่มีค่านี้ยังคงใช้ค่า
    // เริ่มต้น 3 เดือนเหมือนเดิมทุกประการ ไม่ต้อง migrate ข้อมูลเก่า
    intervalMonths: Number,
    jobValue: Number,
    // ✅ ค่าคอมมิชชั่นที่จ่ายให้ฝั่งลูกค้า/ผู้แนะนำงาน — เก็บเป็น "จำนวนเงิน" ไม่ใช่เปอร์เซ็นต์
    // ⚠️ เก็บเปอร์เซ็นต์ไม่ได้ เพราะฐานที่ใช้คิดไม่ตายตัว (บางงานคิดจากมูลค่าสัญญา บางงานคิดจากยอด
    // หลังหักต้นทุน) ถ้าเก็บเป็น % แล้ววันหนึ่งมูลค่างานถูกแก้ ค่าคอมที่ตกลงกันไว้แล้วจะเปลี่ยนตาม
    // เองเงียบๆ ทั้งที่ตกลงกับลูกค้าเป็นตัวเงินไปแล้ว — หน้าจอคำนวณ % ให้ดูเป็นข้อมูลประกอบแทน
    // ⚠️ ระดับ "สัญญา" เหมือน jobValue (ไม่ใช่รายครั้ง) — แก้ทีเดียวมีผลทุกครั้งในสัญญานั้น
    commission: Number,

    // ⚠️ เดิมมีแค่ true/false (งานทั่วไป vs ยังไม่จัดกลุ่ม) — เก็บ field นี้ไว้เฉยๆ เพื่ออ่านข้อมูลเก่าที่
    // เคยยืนยันไปแล้วก่อนหน้านี้ได้ (ดู jobClassification ด้านล่างที่ใช้แทนต่อจากนี้ไป — utils/
    // contractOverdue.js ฝั่ง frontend จะ fallback มาอ่านค่านี้ถ้า jobClassification ยังไม่มีค่า)
    isConfirmedGeneral: { type: Boolean, default: false },
    // ✅ งานที่ไม่มี contractGroupId แบ่งเป็น 3 สถานะ: "" (ยังไม่จัดกลุ่ม — ค่าเริ่มต้น ยังไม่มีใครยืนยัน
    // ว่าเป็นงานเดี่ยวจริงๆ หรือควรอยู่ในสัญญาไหน), "general" (งานทั่วไป), "project" (งานโปรเจค) —
    // แอดมิน/manager กดยืนยันเองผ่านหน้า "ภาพรวมงาน" (ContractOverview.js, ดู PUT /events/:id/classify)
    jobClassification: { type: String, enum: ["", "general", "project"], default: "" },

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

    // ✅ งานที่สร้างโดยคนที่ไม่ใช่ admin/manager (ช่าง/เซล) ต้องรอแอดมิน/manager อนุมัติก่อนถึงจะถือว่า
    // "ยืนยันแล้วจริง" — ดีฟอลต์ "approved" เพื่อไม่ต้อง migrate ข้อมูลเก่า (งานเก่าทุกงาน + งานที่
    // admin/manager สร้างเองถือว่า approved อัตโนมัติ) ห้ามอ่านฟิลด์นี้ตรงๆ ที่ไหนนอกจาก
    // utils/approvalStatus.js (ฝั่ง frontend) — ต้องถือว่า "ไม่มีค่า" เทียบเท่า "approved" เสมอ
    // แก้ค่าได้ทางเดียวคือผ่าน PUT /events/:id/approval (admin/manager เท่านั้น) ห้าม client ส่งค่า
    // นี้ตรงๆ ผ่าน POST/PUT อื่นเด็ดขาด (ดูคอมเมนต์ allowedFields ใน routes/calendarEvent.js)
    approvalStatus: { type: String, enum: ["approved", "pending", "rejected"], default: "approved", index: true },
    approvalRequestedAt: Date,
    approvalRequestedBy: String, // ชื่อคนขอ (แสดงผลอย่างเดียว)
    // ✅ userId ของคนที่สร้างงานจริง (เทียบ pattern เดียวกับ closeRequestedByUserId ด้านบน — userId/
    // resPerson ของ event อาจไม่ตรงกับคนสร้างจริงเสมอไป เช่น สร้างแทนทีมอื่น)
    approvalRequestedByUserId: String,
    approvalDecidedAt: Date,
    approvalDecidedBy: String,
    approvalRejectReason: String,

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

// ✅ ตัวเตือน "ใบที่เลยกำหนดชำระ" รันทุกวันและ query ด้วย billing.dueAt เสมอ — sparse เพราะงาน
// ส่วนใหญ่ยังไม่ได้วางบิล (dueAt เป็น null) ไม่ต้องกินพื้นที่ index ไปกับ null เป็นแสนแถว
eventSchema.index({ "billing.dueAt": 1 }, { sparse: true });

const Events = mongoose.model("CalendarEvent", eventSchema);

module.exports = Events;
