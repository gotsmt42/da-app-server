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
   * ⚠️ ฟิลด์เก่า — ข้อความตำแหน่งที่พิมพ์ใต้ชื่อในเอกสาร ย้ายไปอยู่ที่ jobTitle แล้ว
   * (หลังแยก Role/Rank คำว่า "rank" ถูกจองไว้ให้หมายถึง "ตำแหน่งในองค์กร" เท่านั้น)
   * เก็บไว้เพื่ออ่านข้อมูลเก่าได้ — โค้ดใหม่ให้เขียนที่ jobTitle เท่านั้น (อ่านผ่าน titleOf() ใน config/roles.js)
   */
  rank: { type: String},
  /** ตำแหน่งเฉพาะบุคคล — พิมพ์ใต้ชื่อในเอกสาร เว้นว่าง = ใช้ชื่อ Rank ของตำแหน่ง */
  jobTitle: { type: String, default: "" },
  /** Rank — ตำแหน่งในองค์กร (แอดมินช่าง/ผู้จัดการแผนกช่าง/ช่างเทคนิค ...) — คีย์คงเดิม ชื่อที่แสดงเปลี่ยนได้จากหน้าตั้งค่า */
  role: { type: String},
  /**
   * ชั้นสิทธิ์ "ในระบบ" — แยกจากตำแหน่งในองค์กรโดยสิ้นเชิง (ผู้ใช้สั่งให้แยกกัน)
   *   superadmin = ผู้ดูแลระบบสูงสุด · admin = ผู้ดูแลระบบ · member = ผู้ใช้งาน
   * ⚠️ ว่าง = ยังไม่เคยตั้ง → ระบบเดาจากตำแหน่งในองค์กรให้ (DEFAULT_SYSTEM_ROLE ใน config/roles.js)
   * ผู้ใช้เดิมทุกคนจึงทำงานต่อได้ทันทีโดยไม่ต้องย้ายข้อมูล
   */
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
