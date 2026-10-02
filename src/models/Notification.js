const mongoose = require("../db");

/**
 * Notification — กล่องแจ้งเตือนของผู้ใช้ (ประวัติทุกข้อความที่ระบบเด้งไปที่มือถือ)
 *
 * ✅ ผู้ใช้สั่ง (2 ต.ค. 2569): "ทำระบบ push แจ้งเตือนต่อให้เสร็จ ... เด้งแจ้งเตือนแบบ Line ที่หน้าจอโทรศัพท์"
 *   แบบ LINE = เด้งบนจอ + มีตัวเลขค้างบนไอคอนแอป + เปิดแอปมาแล้วย้อนดูได้ว่ามีอะไรเข้ามาบ้าง
 *   เดิมกระดิ่งในแอปสร้างรายการเองจากการเทียบข้อมูลงานฝั่งหน้าจอ — เห็นแค่เรื่องงาน
 *   (ใบเบิก / OT / ใบขอซื้อ / คำขอจากเว็บ ไม่มีในกระดิ่งเลย) และหายเมื่อเปลี่ยนเครื่อง
 *   ตอนนี้ทุกข้อความที่ส่ง push ถูกเก็บที่นี่ด้วย (services/PushNotify.js) → กระดิ่งอ่านจาก server ที่เดียว
 *
 * ⚠️ tag เดียวกันที่ยังไม่อ่าน = เรื่องเดียวกัน → แทนที่ของเดิม (เหมือนแจ้งเตือนบนมือถือ) ไม่กองซ้ำ
 */
const notificationSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true, index: true },
    title: { type: String, default: "" },
    body: { type: String, default: "" },
    url: { type: String, default: "/" },
    tag: { type: String, default: "" },
    kind: { type: String, default: "" },
    readAt: { type: Date, default: null },
  },
  { timestamps: true }
);

notificationSchema.index({ userId: 1, createdAt: -1 });
notificationSchema.index({ userId: 1, readAt: 1 });
// ✅ ลบเองหลัง 90 วัน — เป็นกล่องแจ้งเตือน ไม่ใช่ประวัติเอกสาร (ประวัติจริงอยู่ใน activityLog ของแต่ละใบ)
notificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

const Notification = mongoose.model("Notification", notificationSchema);
module.exports = Notification;
