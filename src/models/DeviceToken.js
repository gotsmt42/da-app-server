const mongoose = require("../db");

/**
 * DeviceToken — เครื่องมือถือที่ติดตั้ง "แอป TidTam" (Android / iPhone) ไว้รับแจ้งเตือนแบบแอปจริง
 *
 * ✅ (18 ต.ค. 2569 ผู้ใช้: "แปลงเป็นแอพมือถือ ทั้ง Android และ iPhone") — แอปจริงรับ Web Push ไม่ได้
 *    (WebView ของแอปไม่มี PushManager) จึงต้องส่งผ่าน Firebase Cloud Messaging แทน
 *    token มาจาก @capacitor-firebase/messaging — เป็น FCM token ทั้งสองระบบ (iPhone ผ่าน APNs ใน Firebase)
 * ⚠️ token เป็นของ "เครื่อง" — ล็อกอินคนอื่นบนเครื่องเดิม = ย้ายเจ้าของ (upsert ตาม token) ไม่สร้างซ้ำ
 *    กันแจ้งเตือนของคนเก่าไปเด้งบนเครื่องที่คนใหม่ถืออยู่
 */
const deviceTokenSchema = new mongoose.Schema({
  userId: { type: String, required: true, index: true },
  token: { type: String, required: true, unique: true },
  platform: { type: String, enum: ["android", "ios"], required: true },
  appVersion: { type: String, default: "" },
  lastSeenAt: { type: Date, default: Date.now },
}, { timestamps: true });

module.exports = mongoose.model("DeviceToken", deviceTokenSchema);
