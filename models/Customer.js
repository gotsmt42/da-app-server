const mongoose = require("../db/");
const bcrypt = require("bcryptjs");

const customerSchema = new mongoose.Schema(
  {
    cCompany: { type: String },
    cSite: { type: String, required: true },
    cEmail: { type: String},
    cName: { type: String},
    address: { type: String },
    tel: String,
    tax: String,
    imageUrl: { type: String, default: "asset/image/userDefault-1.jpg" },

    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" }, // เพิ่มฟิลด์ userId และระบุ ref เป็น "User"
  },
  { timestamps: true }
);

// ✅ เดิมไม่มี constraint กันโครงการซ้ำเลย — ฝั่งหน้าเว็บเช็คซ้ำจาก snapshot ที่ดึงมาตอนเปิด
// ฟอร์มเพิ่มแผนงาน (ไม่ใช่ query สดตอนบันทึกจริง) ถ้า handler ยิงซ้ำด้วยเหตุผลใดก็ตาม (เช่น
// dateClick ของ FullCalendar ยิงซ้ำบนอุปกรณ์ทัชสกรีนบางรุ่น) จะเพิ่มโครงการเดิมซ้ำเป็น 2 แถว
// ทันที ไม่มีอะไรกันไว้เลยที่ระดับฐานข้อมูล — ล็อกด้วย unique index ที่นี่แทน เป็นด่านสุดท้าย
// ที่การันตีได้แน่นอนไม่ว่า client จะยิงซ้ำกี่ครั้งก็ตาม
customerSchema.index({ cCompany: 1, cSite: 1 }, { unique: true });

const Customer = mongoose.model("Customer", customerSchema);
module.exports = Customer;
