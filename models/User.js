const mongoose = require("../db/");
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
userSchema.pre("save", async function (next) {
  if (!this.isModified("password")) return next();
  console.log("🟢 กำลังเข้ารหัสรหัสผ่านก่อนบันทึก:", this.password);
  this.password = await bcrypt.hash(this.password, 10);
  next();
});

// ✅ เปรียบเทียบรหัสผ่าน
userSchema.methods.comparePassword = async function (candidatePassword) {
  console.log("🟢 รหัสผ่านที่ผู้ใช้ป้อน:", candidatePassword);
  console.log("🟢 รหัสผ่านที่เข้ารหัสในฐานข้อมูล:", this.password);

  const isMatch = await bcrypt.compare(candidatePassword, this.password);

  console.log("🟢 ผลลัพธ์จาก bcrypt.compare():", isMatch);
  return isMatch;
};


const User = mongoose.model("User", userSchema);
module.exports = User;
