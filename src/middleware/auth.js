const jwt = require('jsonwebtoken');
const User = require("../models/User");
const BOOT_TIME = require("../config/bootTime");

// ⚠️ เดิมเขียนว่า `module.exports = verifyToken = async (...)` ซึ่ง verifyToken ไม่เคยถูกประกาศ
// = สร้างตัวแปร global ขึ้นมาโดยไม่ตั้งใจ (implicit global) ไปทับ/ชนกับที่อื่นได้ และถ้าวันไหนเปลี่ยนมา
// ใช้ "use strict" หรือ ES module จะพังทันที — ประกาศเป็น const แล้วค่อย export ให้ชัดเจน
const verifyToken = async (req, res, next) => {
   try {
    const authHeader = req.header("Authorization");

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ message: "Access denied. No token provided." });
    }

    const token = authHeader.replace("Bearer ", "").trim();

    const decoded = jwt.verify(token, process.env.APP_SECRET);

    // ✅ Production เท่านั้น: ทุกครั้งที่ deploy (process restart) ให้ token ที่ออกก่อนหน้านี้ทั้งหมดหมดอายุทันที
    // (เว้น dev/local ไว้ เพราะ nodemon restart บ่อยระหว่างพัฒนา จะรบกวนการทดสอบถ้าบังคับด้วย)
    if (process.env.NODE_ENV === "production" && decoded.iat * 1000 < BOOT_TIME) {
      return res.status(401).json({ message: "Token expired" });
    }

    const user = await User.findById(decoded.userId);

    if (!user) {
      return res.status(404).json({ message: "User not found." });
    }

    // ✅ ถ้า sessionVersion ใน token ไม่ตรงกับใน DB (เช่น ถูกเปลี่ยน role หรือถูกบังคับให้ออกจากระบบ)
    // ให้ถือว่า token หมดอายุ — ฝั่ง frontend มี interceptor ดักข้อความนี้อยู่แล้วเพื่อเตะออกอัตโนมัติ
    const tokenSessionVersion = decoded.sessionVersion || 0;
    const currentSessionVersion = user.sessionVersion || 0;
    if (tokenSessionVersion !== currentSessionVersion) {
      return res.status(401).json({ message: "Token expired" });
    }

    req.userId = decoded.userId;
    req.user = user;
    req.token = token;

    next();
  } catch (error) {
    if (error.name === "TokenExpiredError") {
      return res.status(401).json({ message: "Token expired" });
    }

    if (error.name === "JsonWebTokenError") {
      return res.status(403).json({ message: "Invalid token" });
    }

    console.error("❌ Token verification error:", error);
    return res.status(500).json({ message: "Internal Server Error" });
  }
};

module.exports = verifyToken;
