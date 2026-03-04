// routes/auth.js
const express = require("express");
const router = express.Router();
const jwt = require("jsonwebtoken");
const User = require("../models/User");

const verifyToken = require("../middleware/auth");

const multer = require("multer");

const { cloudinary, storage } = require("../utils/cloudinary");
const upload = multer({ storage });

const checkFile = require("../middleware/checkFile");

router.post("/validate-password", verifyToken, async (req, res) => {
  try {
    const { password } = req.body;
    const userId = req.userId;

    // ตรวจสอบว่ามีการส่ง password มาหรือไม่
    if (!password || password.trim() === "") {
      return res
        .status(400)
        .json({ valid: false, message: "กรุณากรอกรหัสผ่าน" });
    }

    // ดึงข้อมูลผู้ใช้จาก userId
    const user = await User.findById(userId).select("+password").exec();

    if (!user) {
      return res
        .status(401)
        .json({ valid: false, message: "ข้อมูลไม่ถูกต้อง" });
    }

    // เปรียบเทียบรหัสผ่าน
    const isMatch = await bcrypt.compare(password.trim(), user.password);

    if (!isMatch) {
      return res
        .status(401)
        .json({ valid: false, message: "ข้อมูลไม่ถูกต้อง" });
    }

    // หากรหัสผ่านถูกต้อง
    res.json({ valid: true, message: "ยืนยันรหัสผ่านสำเร็จ" });
  } catch (error) {
    console.error("Error validating password:", error);
    res
      .status(500)
      .json({ valid: false, message: "เกิดข้อผิดพลาดในการตรวจสอบรหัสผ่าน" });
  }
});

router.get("/alluser", verifyToken, async (req, res) => {
  try {
    const token = req.token;

    const allUser = await User.find({}).exec();

    if (allUser) {
      res.json({ allUser: allUser, token: token });
    } else {
      res.json({
        err: "Username หรือ Password ไม่ถูกต้องกรุณาลองใหม่อีกครั้ง",
      });
    }
    // console.log(user);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

router.get("/user", verifyToken, async (req, res) => {
  try {
    const userId = req.userId;
    const token = req.token;

    const user = await User.findOne({ _id: userId }).exec();

    if (user) {
      res.json({ user: user, token: token });
    } else {
      res.json({
        err: "Username หรือ Password ไม่ถูกต้องกรุณาลองใหม่อีกครั้ง",
      });
    }

    // console.log(user);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// Route สำหรับสมัครสมาชิก
// Route สำหรับสมัครสมาชิก

const bcrypt = require("bcryptjs");

router.post("/signup", async (req, res) => {
  try {
    const { username, password, email, fname, lname, tel, role, rank } =
      req.body;

    console.log("🟢 รหัสผ่านที่ได้รับก่อนเข้ารหัส:", password);

    const user = new User({
      username,
      password, // ✅ ส่งรหัสผ่านตรงๆ Mongoose จะเข้ารหัสให้
      email,
      fname,
      lname,
      tel,
      role,
      rank,
    });

    await user.save();

    res.status(201).json({ message: "สมัครสมาชิกสำเร็จ!" });
  } catch (err) {
    console.log(err.message);
    res.status(500).json({ err: "เกิดข้อผิดพลาดในระบบ กรุณาลองใหม่อีกครั้ง" });
  }
});

// Route สำหรับล็อกอิน
router.post("/login", async (req, res) => {
  try {
    const { username, password } = req.body;

    console.log("🟢 ค่าที่ได้รับจากผู้ใช้:", password);

    const user = await User.findOne({
      $or: [{ username }, { email: username }],
    });

    if (!user) {
      return res.status(401).json({ err: "ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง" });
    }

    console.log("🟢 รหัสผ่านที่เข้ารหัสในฐานข้อมูล:", user.password);

    const isPasswordValid = await bcrypt.compare(password, user.password);

    console.log("🟢 password ที่ได้รับจากผู้ใช้:", password);
    console.log("🟢 password ที่เข้ารหัสในฐานข้อมูล:", user.password);
    console.log("🟢 bcrypt.compare() ผลลัพธ์:", isPasswordValid);
    if (!isPasswordValid) {
      return res.status(401).json({ err: "ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง" });
    }

    const payload = {
      userId: user._id,
      email: user.email,
      fname: user.fname,
      lname: user.lname,
      tel: user.tel,
      username: user.username,
      rank: user.rank,
      role: user.role,
      imageUrl: user.imageUrl, // ✅ เพิ่มตรงนี้
    };

    const token = jwt.sign(payload, process.env.APP_SECRET, {
      expiresIn: "30d",
    });

    res.status(200).json({ token, payload, message: "เข้าสู่ระบบสำเร็จ!" });
  } catch (err) {
    console.error("🔴 Error in login:", err);
    res.status(500).json({ err: "เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง" });
  }
});

// Update route
router.put(
  "/user/:id",
  verifyToken,
  upload.single("image"),
  checkFile,
  async (req, res) => {
    try {
      const userId = req.params.id;
      const { fname, lname, tel, role } = req.body;

      console.log(req.body);

      // const imageUrl = req.imageUrl;

      const newUser = {
        fname,
        lname,
        tel,
        role,
      };

      if (req.file && req.file.path) {
        newUser.imageUrl = req.file.path;
        console.log("📷 Uploaded to:", req.file.path);
      } else {
        console.log("⚠️ ไม่มีไฟล์ใหม่ถูกอัปโหลด");
      }

      const updatedUser = await User.findByIdAndUpdate(
        { _id: userId },
        newUser,
        { new: true },
      ).exec();

      if (!updatedUser) {
        return res.status(404).send("User not found");
      }

      res.status(200).json({ user: updatedUser });
    } catch (err) {
      res.status(500).send(err.message);
    }
  },
);

router.delete("/user/:id", verifyToken, async (req, res) => {
  try {
    const userId = req.params.id;

    const deletedUser = await User.findByIdAndDelete(userId);

    if (!deletedUser) {
      return res.status(404).json({ message: "ไม่พบผู้ใช้ที่ต้องการลบ" });
    }

    res.status(200).json({ message: "ลบผู้ใช้สำเร็จ" });
  } catch (err) {
    res.status(500).json({ message: "เกิดข้อผิดพลาดในการลบผู้ใช้" });
  }
});

router.get("/logout", (req, res) => {
  // ✅ ไม่ต้องลบ token ที่ฝั่ง server ถ้าใช้ JWT แบบ stateless
  res.status(200).json({ message: "Logged out successfully" });
});

// ใช้ Middleware ใน Endpoint สำหรับ Logout
// router.get("/logout", (req, res) => {
//   // ทำการลบหรือเคลียร์ Token หลังจากตรวจสอบแล้วว่าถูกต้อง

//   localStorage.removeItem("token");

//   // โดยใน req.user จะมีข้อมูลของผู้ใช้จาก Token ที่ถูก verify แล้ว
//   // ดำเนินการตรวจสอบหรือยกเลิกการใช้งาน Token จากฝั่ง server-side ตามที่ต้องการ

//   // เมื่อทำการ logout หรือยกเลิกการใช้งาน Token เสร็จสิ้น
//   res.status(200).json({ message: "Logged out successfully" });
// });
module.exports = router;
