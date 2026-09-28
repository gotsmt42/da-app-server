const mongoose = require("../db");

/**
 * OtWage — ค่าจ้างต่อชั่วโมงของพนักงานสำหรับคำนวณ OT
 *
 * 🔒 แยกคอลเลกชันจาก User โดยตั้งใจ (เหตุผลเดียวกับ BankAccount) — GET /api/auth/alluser คืน User ทั้งก้อน
 * ให้ทุกคนที่ล็อกอิน ถ้าเก็บค่าจ้างใน User ค่าจ้างทุกคนจะหลุดถึงพนักงานทุกคน
 * ที่นี่แก้/ดูทั้งตารางได้เฉพาะผู้มีสิทธิ์ viewAllExpenses ผ่าน routes/ot.js · เจ้าตัวเห็นแค่ยอดของตัวเองในใบ
 *
 * วิธีคิด: กรอกได้ทั้ง "เงินเดือน" (ค่าจ้างต่อชั่วโมง = เงินเดือน ÷ 30 ÷ ชั่วโมงทำงานต่อวัน)
 * หรือ "ค่าจ้างรายวัน" (÷ ชั่วโมงทำงานต่อวัน) หรือ "ต่อชั่วโมง" ตรงๆ — hourlyRate คือค่าที่ใช้คำนวณจริง
 */
const otWageSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true, unique: true, index: true },
    basis: { type: String, enum: ["monthly", "daily", "hourly"], default: "monthly" },
    /** ตัวเลขที่กรอก (เงินเดือน / ค่าจ้างรายวัน / ต่อชั่วโมง ตาม basis) */
    baseAmount: { type: Number, default: 0, min: 0 },
    hourlyRate: { type: Number, default: 0, min: 0 },
    updatedBy: { userId: { type: String, default: "" }, name: { type: String, default: "" } },
  },
  { timestamps: true }
);

module.exports = mongoose.model("OtWage", otWageSchema);
