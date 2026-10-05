/**
 * LoginSession — "อุปกรณ์ที่เข้าสู่ระบบ" ของแต่ละบัญชี
 *
 * ✅ ผู้ใช้ขอ (5 ต.ค. 2569): "อยากเห็นว่าบัญชีเข้าไว้ที่อุปกรณ์อะไรบ้าง ชื่ออะไร ที่ไหน อย่างละเอียด"
 *    1 แถว = 1 token ที่ออกไป (1 การเข้าสู่ระบบ) · อัปเดตเวลาใช้งานล่าสุด/IP ทุกไม่กี่นาทีจาก middleware/auth.js
 *    ออกจากระบบอุปกรณ์อื่น = ตั้ง revokedAt → token นั้นใช้ไม่ได้ทันทีในคำขอถัดไป
 *
 * ⚠️ sid ของ token รุ่นเก่า (ออกก่อนมีระบบนี้ ไม่มี sid ใน payload) = "t_" + hash ของ token เอง
 *    จึงเห็นและสั่งออกจากระบบได้ครบทุกเครื่อง โดยไม่ต้องบังคับทุกคนล็อกอินใหม่
 */
const mongoose = require("mongoose");

const loginSessionSchema = new mongoose.Schema(
  {
    sid: { type: String, required: true, unique: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    legacy: { type: Boolean, default: false }, // token รุ่นเก่าที่ไม่ได้ผ่านหน้าเข้าสู่ระบบรุ่นนี้

    userAgent: { type: String, default: "" },
    browser: { type: String, default: "" },
    browserVersion: { type: String, default: "" },
    os: { type: String, default: "" },
    osVersion: { type: String, default: "" },
    deviceType: { type: String, enum: ["desktop", "mobile", "tablet", "unknown"], default: "unknown" },
    deviceVendor: { type: String, default: "" },
    deviceModel: { type: String, default: "" },
    standalone: { type: Boolean, default: false }, // เปิดจากไอคอนแอปบนหน้าจอโฮม (PWA)

    ip: { type: String, default: "" },
    location: {
      city: { type: String, default: "" },
      region: { type: String, default: "" },
      country: { type: String, default: "" },
      countryCode: { type: String, default: "" },
      isp: { type: String, default: "" },
      ip: { type: String, default: "" }, // IP ที่ใช้หาตำแหน่งล่าสุด (เปลี่ยน IP = หาใหม่)
    },

    lastSeenAt: { type: Date, default: Date.now },
    revokedAt: { type: Date, default: null },
    revokedBy: { type: String, default: "" },
  },
  { timestamps: true },
);

// token มีอายุ 30 วัน — เก็บไว้อีกนิดแล้วให้ฐานข้อมูลลบเอง
loginSessionSchema.index({ lastSeenAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 40 });

module.exports = mongoose.model("LoginSession", loginSessionSchema);
