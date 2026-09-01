// routes/auth.js
const express = require("express");
const router = express.Router();
const jwt = require("jsonwebtoken");
const User = require("../models/User");

const verifyToken = require("../middleware/auth");

const multer = require("multer");

const { storage } = require("../config/cloudinary");
const { fileFilter, limits } = require("../config/upload");
const upload = multer({ storage, fileFilter, limits });

const checkFile = require("../middleware/checkFile");

// 🔒 ตารางสิทธิ์กลางของระบบ — ใช้ requireCap แทนการเช็ค role เขียนสดตามที่ config/roles.js กำหนดไว้
const { requireCap, ALL_ROLES, can, normalizeRole } = require("../config/roles");

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

/**
 * สร้างผู้ใช้ใหม่ — **แอดมินเท่านั้น**
 *
 * 🔒 ที่แก้ (ช่องโหว่ร้ายแรง: ยกระดับสิทธิ์โดยไม่ต้องล็อกอิน)
 * เดิม route นี้ไม่มี verifyToken เลย และรับ role จาก req.body มาใส่ตรงๆ ขณะที่ models/User.js
 * ประกาศ role เป็น String เปล่าๆ ไม่มี enum — ผลคือ **ใครก็ตามบนอินเทอร์เน็ต** ยิง POST มาที่
 * /api/auth/signup พร้อม { role: "admin" } แล้วได้บัญชีแอดมินทันที จากนั้น login รับ JWT อายุ 30 วัน
 * แล้วเข้าถึงข้อมูลทั้งระบบได้ทั้งหมด
 *
 * ✅ ตอนนี้: ต้องล็อกอิน + มีสิทธิ์ manageAll (แอดมิน) ตรงกับหน้า "ทะเบียนพนักงาน" ที่เป็นทางเดียว
 * ที่เรียก route นี้จริง (StaffHub.js กันด้วย manageAll เหมือนกัน) — ไม่กระทบการใช้งานปกติเลย
 * ⚠️ role ต้องอยู่ใน ALL_ROLES เท่านั้น — กันสร้าง role มั่วที่ไม่มีในตารางสิทธิ์ ซึ่งจะกลายเป็นบัญชี
 * ที่ระบบไม่รู้จักแล้วถูกปฏิเสธเงียบๆ ทุกหน้า (บั๊กแบบที่ config/roles.js ตั้งใจกำจัด)
 */
router.post("/signup", verifyToken, requireCap("manageAll"), async (req, res) => {
  try {
    const { username, password, email, fname, lname, tel, role, rank } =
      req.body;

    const wantedRole = normalizeRole(role);
    if (!ALL_ROLES.includes(wantedRole)) {
      return res.status(400).json({
        err: `role ไม่ถูกต้อง — ต้องเป็นหนึ่งใน: ${ALL_ROLES.join(", ")}`,
      });
    }

    const user = new User({
      username,
      password, // ✅ ส่งรหัสผ่านตรงๆ Mongoose จะเข้ารหัสให้
      email,
      fname,
      lname,
      tel,
      role: wantedRole,
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

    const user = await User.findOne({
      $or: [{ username }, { email: username }],
    });

    if (!user) {
      return res.status(401).json({ err: "ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง" });
    }

    // 🔒 ที่แก้: เดิมมี console.log 4 บรรทัดตรงนี้ที่พ่นรหัสผ่านข้อความล้วนของผู้ใช้ + hash ใน
    // ฐานข้อมูล ออกมาทุกครั้งที่มีคนล็อกอิน — log ของ Render เก็บย้อนหลังและเปิดดูได้
    // ⚠️ ถ้าต้องดีบักการล็อกอินในอนาคต ให้ log แค่ username กับผลลัพธ์ true/false เท่านั้น
    // ห้ามแตะตัวรหัสผ่านหรือ hash เด็ดขาด
    const isPasswordValid = await bcrypt.compare(password, user.password);

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
      sessionVersion: user.sessionVersion || 0,
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

/**
 * แก้ไขข้อมูลผู้ใช้
 *
 * 🔒 ที่แก้ (ช่องโหว่ร้ายแรง: ยกระดับสิทธิ์ + แก้ข้อมูลคนอื่น)
 * เดิมมีแค่ verifyToken — ไม่เช็คเลยว่า "คนที่ยิงมาเป็นเจ้าของบัญชีนี้ไหม" หรือ "มีสิทธิ์แก้คนอื่นไหม"
 * ผลคือผู้ใช้ที่ล็อกอินอยู่คนใดก็ได้ (ช่าง/เซล/user ทั่วไป) ยิง PUT /api/auth/user/<id ของตัวเอง>
 * พร้อม { role: "admin" } แล้วกลายเป็นแอดมินทันที หรือแก้ชื่อ/เบอร์ของคนอื่นทั้งระบบก็ได้
 *
 * ✅ กติกาใหม่:
 *   • แก้ของตัวเองได้ (ชื่อ/นามสกุล/เบอร์/รูป) — เป็นการใช้งานปกติของหน้า "บัญชีของฉัน"
 *   • แก้ของคนอื่นได้เฉพาะแอดมิน (manageAll) — ตรงกับหน้า "ทะเบียนพนักงาน" ที่กันด้วยสิทธิ์เดียวกัน
 *   • **เปลี่ยน role ได้เฉพาะแอดมิน และเปลี่ยนของตัวเองไม่ได้** — กันทั้งการยกระดับตัวเอง และกัน
 *     แอดมินคนสุดท้ายเผลอถอดสิทธิ์ตัวเองจนไม่มีใครเข้าไปแก้ได้อีก
 */
router.put(
  "/user/:id",
  verifyToken,
  upload.single("image"),
  checkFile,
  async (req, res) => {
    try {
      const userId = req.params.id;
      const { fname, lname, tel, role } = req.body;

      const isSelf = String(req.userId) === String(userId);
      const isAdmin = can(req.user, "manageAll");
      if (!isSelf && !isAdmin) {
        return res.status(403).json({ message: "แก้ไขได้เฉพาะข้อมูลของตัวเองเท่านั้น" });
      }

      // ⚠️ สร้าง object แบบใส่เฉพาะช่องที่ส่งมาจริง — เดิมยัด { fname, lname, tel, role } ทั้งก้อน
      // ทำให้ช่องที่ผู้ใช้ไม่ได้ส่งมาถูกเขียนทับเป็น undefined โดยไม่ตั้งใจ
      const newUser = {};
      if (fname !== undefined) newUser.fname = fname;
      if (lname !== undefined) newUser.lname = lname;
      if (tel !== undefined) newUser.tel = tel;

      if (role !== undefined) {
        const wantedRole = normalizeRole(role);
        if (!isAdmin) {
          return res.status(403).json({ message: "เปลี่ยนสิทธิ์ผู้ใช้ได้เฉพาะแอดมินเท่านั้น" });
        }
        if (isSelf) {
          return res.status(403).json({ message: "เปลี่ยนสิทธิ์ของตัวเองไม่ได้ — ให้แอดมินคนอื่นเป็นคนเปลี่ยนให้" });
        }
        if (!ALL_ROLES.includes(wantedRole)) {
          return res.status(400).json({ message: `role ไม่ถูกต้อง — ต้องเป็นหนึ่งใน: ${ALL_ROLES.join(", ")}` });
        }
        newUser.role = wantedRole;
      }

      if (req.file && req.file.path) {
        newUser.imageUrl = req.file.path;
        console.log("📷 Uploaded to:", req.file.path);
      } else {
        console.log("⚠️ ไม่มีไฟล์ใหม่ถูกอัปโหลด");
      }

      const existingUser = await User.findById(userId);
      if (!existingUser) {
        return res.status(404).send("User not found");
      }

      // ✅ เปลี่ยน role เมื่อไหร่ ให้เพิ่ม sessionVersion เพื่อบังคับ token เก่าให้หมดอายุทันที
      // (ผู้ใช้จะถูกเตะออกจากระบบในการเรียก API ครั้งถัดไป และต้อง login ใหม่เพื่อรับสิทธิ์ล่าสุด)
      const update = { $set: newUser };
      // เปลี่ยน role เมื่อไหร่ ให้เพิ่ม sessionVersion เพื่อบังคับ token เก่าหมดอายุทันที
      if (newUser.role !== undefined && newUser.role !== existingUser.role) {
        update.$inc = { sessionVersion: 1 };
      }

      const updatedUser = await User.findByIdAndUpdate(
        userId,
        update,
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

/**
 * ลบผู้ใช้ — **แอดมินเท่านั้น**
 * 🔒 ที่แก้: เดิมมีแค่ verifyToken — ผู้ใช้ที่ล็อกอินอยู่คนใดก็ได้ลบบัญชีใครก็ได้ รวมถึงลบแอดมินทิ้ง
 * ⚠️ ลบตัวเองไม่ได้ — กันแอดมินคนสุดท้ายลบตัวเองจนไม่เหลือใครจัดการระบบ
 */
router.delete("/user/:id", verifyToken, requireCap("manageAll"), async (req, res) => {
  try {
    const userId = req.params.id;

    if (String(req.userId) === String(userId)) {
      return res.status(400).json({ message: "ลบบัญชีของตัวเองไม่ได้" });
    }

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
