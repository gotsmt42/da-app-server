// models/User.js
const mongoose = require("../db/");
const moment = require("moment");

const eventSchema = new mongoose.Schema(
  {
    title: { type: String, required: true },
    date: { type: Date, required: true },
    backgroundColor: { type: String, required: true },
    textColor: { type: String, required: true },
    fontSize: { type: Number, required: true },
    start: { type: Date,  }, // เปลี่ยนเป็นรูปแบบ datetime
    end: { type: Date, },   // เปลี่ยนเป็นรูปแบบ datetime
    allDay: { type: Boolean, default: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" }
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
