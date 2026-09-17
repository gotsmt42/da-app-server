const mongoose = require("../db");

/**
 * BankAccount — บัญชีรับเงินของพนักงาน (ใช้กับใบเคลม: บริษัทโอนเงินจ่ายเพิ่ม/จ่ายคืนค่าสำรองจ่ายให้ผู้เบิก)
 *
 * ✅ ผู้ใช้ขอ: "ใบเคลมให้สามารถเพิ่ม และเลือกบัญชีธนาคารให้กับผู้เบิกได้" — เก็บเป็นทะเบียนต่อคน กรอกครั้งเดียว
 * แล้วเลือกซ้ำได้ทุกใบ (1 คนมีได้หลายบัญชี ตั้งบัญชีหลักได้ 1 บัญชี) แทนการพิมพ์เลขบัญชีใหม่ในหมายเหตุทุกใบ
 * ซึ่งพิมพ์ผิดง่ายและฝ่ายบัญชีต้องไล่หาเอง
 *
 * 🔒 ทำไมแยกคอลเลกชัน ไม่เก็บใน User: GET /api/auth/alluser คืนเอกสาร User ทั้งก้อนให้ทุกคนที่ล็อกอิน
 * ถ้าเก็บเลขบัญชีไว้ใน User เลขบัญชีของทุกคนจะหลุดไปถึงพนักงานทุกคนทันที — ที่นี่เปิดดูได้เฉพาะ
 * เจ้าของบัญชี กับแอดมิน/ผู้จัดการ (viewAllExpenses) ผ่าน routes/expenses.js เท่านั้น
 *
 * ⚠️ ใบเคลมเก็บ "สำเนา" ของบัญชีตอนบันทึกใบ (Expense.payTo) — แก้/ลบบัญชีในทะเบียนทีหลัง
 * เอกสารที่ออกไปแล้วต้องไม่เปลี่ยนตาม (ฝ่ายบัญชีอาจโอนไปตามเลขในใบนั้นแล้ว)
 */
const bankAccountSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true, index: true },
    /** ดู config/banks.js */
    bankCode: { type: String, required: true },
    /** ตัวเลขล้วน ไม่มีขีด */
    accountNo: { type: String, required: true },
    accountName: { type: String, required: true, trim: true },
    isDefault: { type: Boolean, default: false },
    createdBy: {
      userId: { type: String, default: "" },
      name: { type: String, default: "" },
    },
  },
  { timestamps: true }
);

// ⚠️ คนเดียวกันเพิ่มบัญชีเดียวกันซ้ำไม่ได้ — ไม่งั้นรายการเลือกมีบัญชีหน้าตาเหมือนกันหลายอัน เลือกผิดอันแล้วงง
bankAccountSchema.index({ userId: 1, bankCode: 1, accountNo: 1 }, { unique: true });

module.exports = mongoose.model("BankAccount", bankAccountSchema);
