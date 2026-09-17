const mongoose = require("../db");

/**
 * SignatureImage — ตัวรูปลายเซ็น เก็บครั้งเดียวต่อหนึ่งลายเซ็น (dedup ด้วย hash)
 *
 * ✅ เอกสารที่ออกไปแล้วจะอ้างถึงรูปด้วย hash — เจ้าตัวเปลี่ยนลายเซ็นใหม่ทีหลัง ใบเก่าพิมพ์ซ้ำก็ยังได้
 * ลายเซ็นเดิมที่ใช้ตอนนั้นเป๊ะ (เอกสารการเงินต้องพิมพ์ซ้ำได้เหมือนต้นฉบับเสมอ)
 *
 * ⚠️ ห้ามลบแถวในคอลเลกชันนี้ทิ้ง แม้เจ้าตัวจะลบลายเซ็นในหน้าตั้งค่าไปแล้ว — เอกสารเก่าที่เซ็นไว้
 * ยังอ้างถึง hash นี้อยู่ ถ้าลบทิ้งใบเก่าจะพิมพ์ออกมาแบบไม่มีลายเซ็นทั้งที่ตอนนั้นเซ็นแล้ว
 * (การลบในหน้าตั้งค่า = "เลิกใช้กับใบใหม่" ไม่ใช่ลบประวัติ)
 *
 * ⚠️ เก็บเป็น dataURL (base64) ไม่ใช่ URL ของ Cloudinary — ไฟล์บน Cloudinary เปิดได้ด้วยลิงก์
 * โดยไม่ผ่านการตรวจสิทธิ์ ใครได้ลิงก์ไปก็ดาวน์โหลดลายเซ็นไปแปะเอกสารปลอมได้
 */
const signatureImageSchema = new mongoose.Schema(
  {
    /** sha256 ของ dataURL (hex) */
    hash: { type: String, required: true, unique: true, index: true },
    /** เจ้าของลายเซ็นคนแรกที่อัปรูปนี้ — ใช้ตรวจย้อนหลังว่า hash นี้เป็นลายเซ็นของใคร */
    userId: { type: String, required: true, index: true },
    /** dataURL: "data:image/png;base64,...." (PNG พื้นหลังโปร่งใส) */
    image: { type: String, required: true },
    bytes: { type: Number, default: 0 },
    width: { type: Number, default: 0 },
    height: { type: Number, default: 0 },
  },
  { timestamps: true }
);

module.exports = mongoose.model("SignatureImage", signatureImageSchema);
