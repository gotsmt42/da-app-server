const mongoose = require("../db");
const { imageSchema, editorSchema, STATUS } = require("./webShared");

/**
 * ยี่ห้อที่แสดงบนเว็บไซต์บริษัท (ส่วน "ยี่ห้อที่เราจัดหาและติดตั้ง" + ตัวเลือกยี่ห้อในฟอร์มสินค้า)
 *
 * ⚠️ ห้ามตั้งชื่อหมวดหรือคำอธิบายว่า "ตัวแทนจำหน่าย/พาร์ตเนอร์" โดยไม่มีหนังสือแต่งตั้งจริง
 *    หน้าเว็บแสดงข้อความกำกับ "มิได้หมายความว่าเป็นตัวแทนจำหน่ายอย่างเป็นทางการ" ไว้เสมอ
 * ⚠️ logo ไม่บังคับ และหน้าเว็บ "ยังไม่แสดงโลโก้" โดยตั้งใจ — การใช้โลโก้ของแบรนด์อื่นบนเว็บ
 *    เชิงพาณิชย์ต้องได้รับอนุญาตจากเจ้าของแบรนด์ก่อน เก็บช่องไว้สำหรับวันที่ได้รับอนุญาตแล้ว
 */
const webBrandSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true, trim: true, maxlength: 80 },
    /** หมวด เช่น "Fire Alarm" "CCTV" — แสดงใต้ชื่อยี่ห้อ */
    category: { type: String, required: true, trim: true, maxlength: 60 },
    logo: { type: imageSchema, default: undefined },
    /** ✅ แบรนด์หลัก — ขึ้นก่อนเสมอ (ตอนนี้คือ Notifier และ Edwards) */
    featured: { type: Boolean, default: false },
    order: { type: Number, default: 0 },
    status: { type: String, enum: STATUS, default: "published" },
    updatedBy: { type: editorSchema, default: () => ({}) },
  },
  { timestamps: true }
);

module.exports = mongoose.model("WebBrand", webBrandSchema);
