// routes/auth.js
const express = require("express");
const router = express.Router();
const jwt = require("jsonwebtoken");
const User = require("../models/User");

const verifyToken = require("../middleware/auth");

const multer = require("multer");
// const path = require("path");

const upload = multer({ dest: "asset/uploads/images/" });

const checkFile = require("../middleware/checkFile");

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
router.post("/signup", async (req, res) => {
  try {
    const { username, password, email, fname, lname, tel } = req.body;
    const existingUser = await User.findOne({ username });
    const existingEmail = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({err: "Username already exists"});
    }
    if (existingEmail) {
      return res.status(400).json({err: "Email already exists"});
    }
    const user = new User({ username, password, email, fname, lname, tel });
    await user.save();
    res.status(201).send("User created successfully");
  } catch (err) {
    console.log(err.message);
    res.status(500).send(err.message);
  }
});

// Route สำหรับล็อกอิน
router.post("/login", async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await User.findOne({ username });
    if (!user) {
      return res.status(401).json({ err: "Invalid username or password" });
    }
    const isPasswordValid = await user.comparePassword(password);
    if (!isPasswordValid) {
      return res.status(401).send("Invalid username or password");
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
      // ตั้งเวลาหมดอายุของ Token เป็น 1 ชั่วโมง
      //   exp: Math.floor(Date.now() / 1000) + 60 * 60, // Unix timestamp in seconds
    };

    const token = jwt.sign(payload, process.env.APP_SECRET, {
      expiresIn: "7 days",
    });
    res.status(200).json({ token, payload });

    // console.log(req.body);
  } catch (err) {
    res.status(500).send(err.message);
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
      const { fname, lname, tel } = req.body;
      const imageUrl = req.imageUrl;

      const newUser = {
        fname,
        lname,
        tel,
        imageUrl,
      };

      const updatedUser = await User.findByIdAndUpdate(
        { _id: userId },
        newUser,
        { new: true }
      ).exec();

      if (!updatedUser) {
        return res.status(404).send("User not found");
      }

      res.status(200).json({ user: updatedUser });
    } catch (err) {
      res.status(500).send(err.message);
    }
  }
);

// ใช้ Middleware ใน Endpoint สำหรับ Logout
router.get("/logout", (req, res) => {
  // ทำการลบหรือเคลียร์ Token หลังจากตรวจสอบแล้วว่าถูกต้อง

  localStorage.removeItem("token");

  // โดยใน req.user จะมีข้อมูลของผู้ใช้จาก Token ที่ถูก verify แล้ว
  // ดำเนินการตรวจสอบหรือยกเลิกการใช้งาน Token จากฝั่ง server-side ตามที่ต้องการ

  // เมื่อทำการ logout หรือยกเลิกการใช้งาน Token เสร็จสิ้น
  res.status(200).json({ message: "Logged out successfully" });
});
module.exports = router;
