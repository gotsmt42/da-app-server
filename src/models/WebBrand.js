const mongoose = require("../db");
const { imageSchema, editorSchema, STATUS } = require("./webShared");

/**
 * ยี่ห้อที่แสดงบนเว็บไซต์บริษัท (ส่วน "ยี่ห้อที่เราจัดหาและติดตั้ง" + ตัวเลือกยี่ห้อในฟอร์มสินค้า)
 *
 * ⚠️ ห้ามตั้งชื่อหมวดหรือคำอธิบายว่า "ตัวแทนจำหน่าย/พาร์ตเนอร์" โดยไม่มีหนังสือแต่งตั้งจริง
 *    หน้าเว็บแสดงข้อความกำกับ "มิได้หมายความว่าเป็นตัวแทนจำหน่ายอย่างเป็นทางการ" ไว้เสมอ
 * ✅ logo ไม่บังคับ — อัปจากหลังบ้านแล้วเว็บใช้ตัวนี้ ไม่อัปเว็บใช้โลโก้ตั้งต้นในโค้ด (ตามชื่อยี่ห้อ)
 *    ไม่มีทั้งคู่แสดงเป็นชื่อตัวอักษร (บริษัทส่งโลโก้มาและสั่งให้ใส่ 24 ก.ย. 2569)
 */
const webBrandSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
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

/**
 * ✅ ไม่ซ้ำ = ชื่อ + หมวด — ยี่ห้อเดียวอยู่ได้หลายหมวด (Hikvision มีทั้ง CCTV และ Access Control)
 * ⚠️ เดิมบังคับชื่อไม่ซ้ำอย่างเดียว (ดัชนี name_1) — syncIndexes ด้านล่างลบดัชนีเก่าให้เองตอนเปิด server
 *    ไม่ลบ = เพิ่ม Hikvision หมวดที่สองไม่ได้ ขึ้น "ชื่อนี้มีอยู่แล้ว"
 */
webBrandSchema.index({ name: 1, category: 1 }, { unique: true });

const WebBrand = mongoose.model("WebBrand", webBrandSchema);
const syncIndexes = () => WebBrand.syncIndexes().catch((err) => console.warn("⚠️  WebBrand syncIndexes:", err.message));
if (mongoose.connection.readyState === 1) syncIndexes();
else mongoose.connection.once("open", syncIndexes);

module.exports = WebBrand;
