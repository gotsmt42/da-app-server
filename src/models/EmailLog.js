const mongoose = require("../db");

/**
 * EmailLog — ประวัติการส่งเอกสารทางอีเมลจากในแอป (routes/mail.js)
 *
 * ✅ ผู้ใช้สั่ง (3 ต.ค. 2569): "เพิ่มระบบส่งอีเมลของเอกสารต่างๆ" — เก็บว่าใครส่งเอกสารไหน ถึงใคร เมื่อไร
 *    สำเร็จไหม ให้หน้ากล่องส่งอีเมลแสดง "ส่งไปแล้ว" ของเอกสารนั้นได้ และไว้ตรวจย้อนเวลาลูกค้าบอกว่าไม่ได้รับ
 * ⚠️ ไม่เก็บไฟล์แนบ — PDF สร้างใหม่จากข้อมูลได้เสมอ เก็บแค่ชื่อไฟล์/ขนาด
 */
const emailLogSchema = new mongoose.Schema(
  {
    sender: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },
    senderName: { type: String, default: "" },
    docType: { type: String, default: "" },
    docNo: { type: String, default: "", index: true },
    refId: { type: String, default: "", index: true },
    to: [{ type: String }],
    cc: [{ type: String }],
    subject: { type: String, default: "" },
    attachment: { name: { type: String, default: "" }, size: { type: Number, default: 0 } },
    status: { type: String, enum: ["sent", "failed"], default: "sent" },
    error: { type: String, default: "" },
  },
  { timestamps: true }
);

// ✅ เก็บ 1 ปีแล้วลบเอง — เป็นประวัติการส่ง ไม่ใช่เอกสารหลัก
emailLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 365 * 24 * 60 * 60 });

module.exports = mongoose.model("EmailLog", emailLogSchema);
