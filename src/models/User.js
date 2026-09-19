const mongoose = require("../db");
const bcrypt = require("bcryptjs");

const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  fname: { type: String },
  lname: { type: String },
  tel: String,
  imageUrl: { type: String, default: "asset/image/userDefault-2.jpg" },
  /**
   * ── สองคำที่แยกกันขาด (✅ ผู้ใช้สั่ง: "Role คือตำแหน่งในระบบ Rank คือในองค์กร") ──
   *
   *   rank = Rank — ตำแหน่ง "ในองค์กร": director / manager / admin / techlead / technician / sale / user
   *          เป็นตัวกำหนดว่าทำงานอะไรได้ (ตารางสิทธิ์) · ชื่อที่แสดงเปลี่ยนเองได้จากหน้าตั้งค่า
   *   role = Role — ตำแหน่ง "ในระบบ": superadmin / admin / member
   *          ให้สิทธิ์ดูแลระบบ (จัดการผู้ใช้ / ตั้งค่าองค์กร / ตารางสิทธิ์) เท่านั้น
   *
   * ⚠️ ข้อมูลเก่าเก็บสลับกัน (role = ตำแหน่งในองค์กร, systemRole = ตำแหน่งในระบบ)
   * โค้ดยังอ่านของเก่าได้ทั้งหมด และ services/migrateUserFields.js ย้ายให้อัตโนมัติตอนเซิร์ฟเวอร์เริ่มทำงาน
   */
  rank: { type: String, default: "" },
  role: { type: String, default: "" },
  /** ตำแหน่งเฉพาะบุคคล — ข้อความอิสระที่พิมพ์ใต้ชื่อในเอกสาร เว้นว่าง = ใช้ชื่อ Rank */
  jobTitle: { type: String, default: "" },
  /** ⚠️ ฟิลด์เก่าของ Role — คงไว้ให้อ่านข้อมูลที่ยังไม่ได้ย้ายเท่านั้น ห้ามเขียนใหม่ */
  systemRole: { type: String, enum: ["superadmin", "admin", "member", ""], default: "" },
  sessionVersion: { type: Number, default: 0 },
}, { timestamps: true });

// ✅ เข้ารหัสรหัสผ่านก่อนบันทึก
// 🔒 ที่แก้: เดิม console.log รหัสผ่าน **ก่อนเข้ารหัส** ออกมาตรงนี้ = รหัสผ่านจริงของผู้ใช้ทุกคน
// ถูกเขียนลง log ของเซิร์ฟเวอร์เป็นข้อความล้วน (บน Render log ถูกเก็บไว้และเปิดดูย้อนหลังได้)
// ⚠️ ห้าม log ค่าของ this.password ไม่ว่ากรณีใด — ทั้งก่อนและหลังเข้ารหัส
userSchema.pre("save", async function (next) {
  if (!this.isModified("password")) return next();
  this.password = await bcrypt.hash(this.password, 10);
  next();
});

// ✅ เปรียบเทียบรหัสผ่าน
// 🔒 ที่แก้: เดิม log ทั้งรหัสผ่านที่ผู้ใช้ป้อน (ข้อความล้วน) และ hash ในฐานข้อมูล —
// ตัวแรกคือรหัสผ่านจริง ส่วนตัวหลังเป็น hash ที่เอาไปทดลองถอดแบบออฟไลน์ได้ ห้าม log ทั้งคู่
userSchema.methods.comparePassword = async function (candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};


const User = mongoose.model("User", userSchema);
module.exports = User;
