const mongoose = require("../db");

const customerSchema = new mongoose.Schema(
  {
    cCompany: { type: String },
    cSite: { type: String, required: true },
    cEmail: { type: String},
    cName: { type: String},
    address: { type: String },
    /**
     * ลิงก์ตำแหน่งจริงบน Google Maps ของโครงการนี้
     * ✅ เก็บไว้ที่ทะเบียนลูกค้า (ไม่ใช่แค่ในใบแจ้งงานใบเดียว) — โครงการเดิมอยู่ที่เดิมเสมอ
     * ครั้งหน้าที่แจ้งงานให้โครงการนี้จึงเติมให้อัตโนมัติ ไม่ต้องไปหาลิงก์ใหม่ทุกครั้ง
     * ⚠️ เก็บเป็น URL ที่ผู้ใช้แปะมาตรงๆ ไม่แกะเป็น lat/lng — ลิงก์ที่แชร์จาก Google Maps มีหลาย
     * รูปแบบมาก (maps.app.goo.gl ย่อ, /place/, ?q=, พิกัดใน URL) การพยายามแกะเองจะพังเงียบๆ
     * กับรูปแบบที่ไม่ได้เผื่อไว้ ส่วนการเปิดลิงก์ตรงๆ ใช้ได้กับทุกรูปแบบเสมอ
     */
    mapUrl: { type: String, default: "" },
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
