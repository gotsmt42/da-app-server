// models/User.js
const mongoose = require("../db/");
const moment = require("moment");

const eventReceiveSchema = new mongoose.Schema(
  {
    title: { type: String, required: true },
    start: { type: Date,  }, // เปลี่ยนเป็นรูปแบบ datetime
    end: { type: Date, },   // เปลี่ยนเป็นรูปแบบ datetime
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" }
  },
  { timestamps: true }
);

// ใช้ pre middleware ในการแปลง string เป็น datetime ก่อนเก็บลงฐานข้อมูล
eventReceiveSchema.pre("save", function (next) {
  if (this.start && typeof this.start === "string") {
    this.start = moment(this.start).toDate();
  }
  if (this.end && typeof this.end === "string") {
    this.end = moment(this.end).toDate(); 
  }
  next();
});

const Events = mongoose.model("EventReceive", eventReceiveSchema);

module.exports = Events;
