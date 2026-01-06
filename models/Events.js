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

    date: { type: Date, required: true },
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

    subject: { type: String },
    description: { type: String },

    startTime: { type: String },
    endTime: { type: String },

    documentSentQuotation: { type: Boolean, default: false },
    documentSentReport: { type: Boolean, default: false },

    quotationFileName: { type: String },
    quotationFileUrl: { type: String },
    quotationFileType: { type: String },

    reportFileName: { type: String },
    reportFileUrl: { type: String },
    reportFileType: { type: String },

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

    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    lastModifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
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

const Events = mongoose.model("CalendarEvent", eventSchema);

module.exports = Events;
