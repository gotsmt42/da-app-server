const mongoose = require("../db/");

const backlogEventSchema = new mongoose.Schema(
  {
    targetMonth: { type: String, required: true }, // รูปแบบ "YYYY-MM" เช่น "2026-04"
    company: { type: String },
    site: { type: String, required: true },
    title: { type: String, required: true },
    system: { type: String },
    time: { type: String }, // ครั้งที่ เช่น ครั้งที่ 1, ครั้งที่ 2
    team: { type: String },
    subject: { type: String },
    description: { type: String },
    startTime: { type: String }, // เวลาเริ่มต้นคร่าวๆ เช่น "09:00"
    endTime: { type: String },   // เวลาสิ้นสุดคร่าวๆ เช่น "12:00"
    
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true }
);

const BacklogEvents = mongoose.model("BacklogEvent", backlogEventSchema);
module.exports = BacklogEvents;