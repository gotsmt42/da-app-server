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
  rank: { type: String},
  role: { type: String},
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
