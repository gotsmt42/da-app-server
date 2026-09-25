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
const {
  requireCap, ALL_ROLES, ROLES, can, normalizeRole, normalizeRank, rankFilter, canAssignRole, canManageUserOfRole, rankLabelOf, isSuperAdmin, titleOf,
  ALL_SYSTEM_ROLES, SYSTEM_ROLES, SYSTEM_ROLE_LABEL, systemRoleOf, DEFAULT_SYSTEM_ROLE,
} = require("../config/roles");

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

/**
 * รูปร่างผู้ใช้ที่ส่งให้หน้าจอ — ✅ คงคีย์เดิมไว้ให้ทุกหน้าที่เขียนไว้แล้วทำงานต่อได้
 *
 * ฐานข้อมูลเก็บตามคำที่ผู้ใช้กำหนด:  rank = ตำแหน่งในองค์กร · role = ตำแหน่งในระบบ
 * แต่ payload ยังส่ง role = ตำแหน่งในองค์กร (ชื่อเดิมที่หน้าจอทุกหน้าใช้อยู่) และส่งตำแหน่งในระบบ
 * แยกไว้ที่ systemRole เพราะคำว่า "admin" เป็นได้ทั้งสองอย่าง — ถ้าใช้คีย์เดียวกันจะแยกไม่ออก
 * ⚠️ แก้ตรงนี้ที่เดียว ทุก endpoint ที่คืนผู้ใช้จะตรงกันหมด
 */
const publicUser = (u) => {
  const doc = typeof u?.toObject === "function" ? u.toObject() : { ...u };
  delete doc.password;
  const rank = normalizeRank(doc);
  return { ...doc, rank, role: rank, systemRole: systemRoleOf(u), jobTitle: titleOf(doc) };
};

router.get("/alluser", verifyToken, async (req, res) => {
  try {
    const token = req.token;

    // 🔒 ตัด hash รหัสผ่านออกจากผลลัพธ์ — endpoint นี้คืนข้อมูลผู้ใช้ "ทุกคน" ให้ทุกคนที่ล็อกอิน
    // ถ้าส่ง password hash ไปด้วย ใครก็ตามที่ล็อกอินได้จะดูดไปลองถอดรหัสแบบออฟไลน์ได้ทั้งบริษัท
    // (ไม่มีหน้าจอไหนใช้ค่านี้เลย — ตรวจแล้วทั้งฝั่งแอป)
    const allUser = await User.find({}).select("-password").lean();

    if (allUser) {
      res.json({ allUser: allUser.map(publicUser), token: token });
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

/**
 * ทะเบียนพนักงานแบบย่อ — ชื่อ / ตำแหน่ง / เบอร์ สำหรับช่อง "ผู้ลงนาม" ในเอกสารที่ออกจากระบบ
 *
 * ✅ ผู้ใช้ขอ: "ใบแจ้งแผนงาน และใบส่งมอบ ให้เลือกชื่อ พร้อมเบอร์ ในระบบได้เลย" — เดิมต้องพิมพ์
 * ชื่อและเบอร์เองทุกใบ ซึ่งพิมพ์ผิด/ใส่เบอร์เก่าได้ง่าย และลูกค้าโทรกลับไม่ติด
 * 🔒 คืนเฉพาะฟิลด์ที่จำเป็นต้องขึ้นหน้าเอกสารเท่านั้น — ไม่ใช่เอกสารผู้ใช้ทั้งก้อนแบบ /alluser
 */
router.get("/staff-directory", verifyToken, async (req, res) => {
  try {
    // ⚠️ ตำแหน่งที่พิมพ์ใต้ชื่อเก็บที่ jobTitle (ข้อมูลเก่าอยู่ที่ rank) — ดึงมาทั้งสองช่อง ไม่งั้นคนเก่าจะได้ค่าว่าง
    const users = await User.find({}).select("_id fname lname rank jobTitle role tel imageUrl").sort({ fname: 1 }).lean();
    res.json({
      users: users.map((u) => ({
        userId: String(u._id),
        name: [u.fname, u.lname].filter(Boolean).join(" ").trim() || u.fname || "",
        position: titleOf(u),
        tel: u.tel || "",
        rank: normalizeRank(u),          // Rank — ตำแหน่งในองค์กร
        role: normalizeRank(u),          // ⚠️ ชื่อเดิมของ Rank — คงไว้ให้หน้าจอรุ่นเก่าไม่พัง
        imageUrl: u.imageUrl || "",
      })),
    });
  } catch (err) {
    console.error("❌ ดึงทะเบียนพนักงานไม่สำเร็จ:", err);
    res.status(500).json({ message: "ดึงทะเบียนพนักงานไม่สำเร็จ" });
  }
});

router.get("/user", verifyToken, async (req, res) => {
  try {
    const userId = req.userId;
    const token = req.token;

    const user = await User.findOne({ _id: userId }).lean();

    if (user) {
      res.json({ user: publicUser(user), token: token });
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
 * ✅ ตอนนี้: ต้องล็อกอิน + มีสิทธิ์ manageAll (แอดมิน/ผู้จัดการ) ตรงกับหน้า "ทะเบียนพนักงาน" ที่เป็นทางเดียว
 * ที่เรียก route นี้จริง (StaffHub.js กันด้วย manageAll เหมือนกัน) — ไม่กระทบการใช้งานปกติเลย
 * ⚠️ role ต้องอยู่ใน ALL_ROLES เท่านั้น — กันสร้าง role มั่วที่ไม่มีในตารางสิทธิ์ ซึ่งจะกลายเป็นบัญชี
 * ที่ระบบไม่รู้จักแล้วถูกปฏิเสธเงียบๆ ทุกหน้า (บั๊กแบบที่ config/roles.js ตั้งใจกำจัด)
 */
router.post("/signup", verifyToken, requireCap("manageAll"), async (req, res) => {
  try {
    const { username, password, email, fname, lname, tel } = req.body;
    // ✅ รับทั้ง rank (ชื่อใหม่) และ role (ชื่อเดิมที่หน้าจอรุ่นเก่าส่งมา) — ทั้งสองหมายถึงตำแหน่งในองค์กร
    const role = req.body.rank !== undefined ? req.body.rank : req.body.role;
    // ✅ ตำแหน่งเฉพาะบุคคล — หน้าจอใหม่ส่ง jobTitle, ของเก่าส่ง rank (รับทั้งคู่)
    const jobTitle = String(req.body?.jobTitle ?? req.body?.rank ?? "").trim().slice(0, 80);

    const wantedRole = normalizeRole(role);
    if (!ALL_ROLES.includes(wantedRole)) {
      return res.status(400).json({
        err: `role ไม่ถูกต้อง — ต้องเป็นหนึ่งใน: ${ALL_ROLES.join(", ")}`,
      });
    }
    // 🔒 กฎข้อ 1 (ลำดับชั้น): สร้างบัญชีที่มีสิทธิ์สูงกว่าตัวเองไม่ได้ — แอดมินสร้างผู้จัดการไม่ได้
    // ⚠️ ถ้าไม่กันตรงนี้ กฎ "แอดมินตั้งใครเป็นผู้จัดการไม่ได้" จะถูกข้ามได้ง่ายๆ ด้วยการสร้างบัญชีใหม่แทน
    if (!canAssignRole(req.user, wantedRole)) {
      return res.status(403).json({
        err: `คุณไม่มีสิทธิ์สร้างบัญชีระดับ${rankLabelOf(wantedRole)} — ต้องให้ผู้จัดการเป็นคนสร้าง`,
      });
    }

    const user = new User({
      username,
      password, // ✅ ส่งรหัสผ่านตรงๆ Mongoose จะเข้ารหัสให้
      email,
      fname,
      lname,
      tel,
      rank: wantedRole,                          // Rank — ตำแหน่งในองค์กร
      role: DEFAULT_SYSTEM_ROLE[wantedRole],     // Role — ตำแหน่งในระบบ (ค่าตั้งต้นตาม Rank — เขียนไว้ชัดๆ ไม่ปล่อยให้เดา)
      jobTitle,
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
      jobTitle: titleOf(user),               // ตำแหน่งเฉพาะบุคคลที่ใช้พิมพ์ในเอกสาร
      rank: normalizeRank(user),             // Rank — ตำแหน่งในองค์กร
      role: normalizeRank(user),             // ⚠️ ชื่อเดิมของ Rank — หน้าจอรุ่นเก่าที่ยังเปิดค้างอยู่ใช้คีย์นี้
      // ✅ ชั้นในระบบ (ผู้ดูแลระบบ/สูงสุด) — แยกจากตำแหน่งในองค์กร หน้าจอใช้ตัดสินว่าจะโชว์เมนูตั้งค่าระบบไหม
      systemRole: systemRoleOf(user),        // Role — ตำแหน่งในระบบ (ส่งชื่อนี้เพื่อกันสับสนกับ role ที่เป็น Rank ใน payload)
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
 *   • แก้ของคนอื่นได้เฉพาะผู้มีสิทธิ์จัดการระบบ (manageAll = แอดมิน/ผู้จัดการ) ตรงกับหน้า "ทะเบียนพนักงาน"
 *   • **เปลี่ยน role ได้เฉพาะผู้มีสิทธิ์จัดการระบบ และเปลี่ยนของตัวเองไม่ได้** — กันทั้งการยกระดับตัวเอง
 *     และกันแอดมินคนสุดท้ายเผลอถอดสิทธิ์ตัวเองจนไม่มีใครเข้าไปแก้ได้อีก
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
      // ✅ ตำแหน่งเฉพาะบุคคล (jobTitle) แก้ไขได้จากหน้าบัญชีของตัวเอง — ใช้พิมพ์ใต้ชื่อในเอกสาร
      // ⚠️ คนละเรื่องกับ Rank (ตำแหน่งในองค์กร = role) และ Role (ในระบบ = systemRole) — ช่องนี้ไม่ให้สิทธิ์อะไรเลย
      // ⚠️ หน้าจอรุ่นเก่าส่งข้อความตำแหน่งมาในช่อง rank — แต่ตอนนี้ rank คือ "ตำแหน่งในองค์กร"
      // จึงรับเป็น jobTitle เฉพาะตอนที่ค่าที่ส่งมา "ไม่ใช่คีย์ของตำแหน่ง" — ไม่งั้นการเปลี่ยน Rank
      // จะกลายเป็นการเขียนทับตำแหน่งในเอกสารเป็นคำว่า "technician" โดยไม่ตั้งใจ
      const legacyTitle = ALL_ROLES.includes(normalizeRole(req.body.rank)) ? undefined : req.body.rank;
      const jobTitleInput = req.body.jobTitle !== undefined ? req.body.jobTitle : legacyTitle;
      if (jobTitleInput !== undefined) newUser.jobTitle = String(jobTitleInput || "").trim().slice(0, 80);

      const existingUser = await User.findById(userId);
      if (!existingUser) {
        return res.status(404).json({ message: "ไม่พบผู้ใช้ที่ต้องการแก้ไข" });
      }

      /**
       * 🐛 บั๊กที่แก้ (ผู้ใช้แจ้ง "อัปเดตของตัวเองไม่ได้"): หน้าทะเบียนพนักงานส่ง role เดิมติดมากับ
       * ทุกการแก้ไขเสมอ พอแอดมินแก้ข้อมูล "ของตัวเอง" จึงโดนกฎ "เปลี่ยนสิทธิ์ตัวเองไม่ได้" เด้งกลับ
       * ทั้งที่ไม่ได้เปลี่ยนสิทธิ์อะไรเลย
       * ✅ กติกาที่ถูกต้องคือห้าม "การเปลี่ยนสิทธิ์" ไม่ใช่ห้าม "การส่งฟิลด์ role มา" — ถ้าค่าที่ส่งมา
       * เท่ากับสิทธิ์ปัจจุบันก็ถือว่าไม่มีอะไรเปลี่ยน ปล่อยผ่านได้ (ยังกันการยกระดับสิทธิ์ครบเหมือนเดิม)
       */
      // ✅ ขอเปลี่ยน Rank — หน้าจอใหม่ส่ง rank, ของเก่าส่ง role
      const rankInput = ALL_ROLES.includes(normalizeRole(req.body.rank)) ? req.body.rank : role;
      if (rankInput !== undefined) {
        const wantedRole = normalizeRole(rankInput);
        const currentRole = normalizeRank(existingUser);   // Rank ปัจจุบันของคนที่ถูกแก้
        if (wantedRole !== currentRole) {
          if (!isAdmin) {
            return res.status(403).json({ message: "เปลี่ยนสิทธิ์ผู้ใช้ได้เฉพาะแอดมิน/ผู้จัดการเท่านั้น" });
          }
          // ✅ Super Admin เปลี่ยน "ตำแหน่งในองค์กร" ของตัวเองได้ (ผู้ใช้สั่ง "เปลี่ยนตำแหน่งในองค์กรได้หมด")
          //    — อำนาจของ Super Admin มาจากสิทธิ์ในระบบ ไม่ได้มาจากตำแหน่ง จึงไม่เสี่ยงล็อกตัวเองออก
          if (isSelf && !isSuperAdmin(req.user)) {
            return res.status(403).json({ message: "เปลี่ยนสิทธิ์ของตัวเองไม่ได้ — ให้ผู้ที่มีสิทธิ์จัดการผู้ใช้ท่านอื่นเป็นคนเปลี่ยนให้" });
          }
          if (!ALL_ROLES.includes(wantedRole)) {
            return res.status(400).json({ message: `สิทธิ์ไม่ถูกต้อง — ต้องเป็นหนึ่งใน: ${ALL_ROLES.join(", ")}` });
          }
          // 🔒 กฎข้อ 2: แตะบัญชีที่ระดับสูงกว่าตัวเองไม่ได้ (แอดมินถอด/เปลี่ยนสิทธิ์ผู้จัดการไม่ได้)
          if (!canManageUserOfRole(req.user, currentRole)) {
            return res.status(403).json({ message: `คุณไม่มีสิทธิ์แก้ไขสิทธิ์ของ${rankLabelOf(currentRole)} — ต้องให้ผู้ที่มีสิทธิ์สูงกว่าเป็นคนแก้` });
          }
          // 🔒 กฎข้อ 1: ตั้งสิทธิ์ที่สูงกว่าระดับตัวเองไม่ได้ (แอดมินตั้งใครเป็นผู้จัดการไม่ได้)
          if (!canAssignRole(req.user, wantedRole)) {
            return res.status(403).json({ message: `คุณไม่มีสิทธิ์ตั้งใครเป็น${rankLabelOf(wantedRole)} — ต้องให้ผู้ที่มีสิทธิ์ระดับนั้นขึ้นไปเป็นคนตั้ง` });
          }
          /**
           * 🔒 ยืนยันตัวตนซ้ำด้วยรหัสผ่านของ "คนที่กดเปลี่ยน" (ผู้ใช้สั่ง)
           * ✅ การเปลี่ยนสิทธิ์คือการให้/ถอดอำนาจในระบบ — ถ้าเครื่องถูกเปิดทิ้งไว้หรือ token หลุด
           * คนอื่นจะยกระดับสิทธิ์ให้บัญชีของตัวเองไม่ได้ถ้าไม่รู้รหัสผ่านของเจ้าของเครื่อง
           * ⚠️ ต้องตรวจที่ server เท่านั้น — กล่องกรอกรหัสผ่านบนหน้าจอเป็นแค่ UX ข้ามได้ด้วยการยิง API ตรง
           */
          const confirmPassword = String(req.body.confirmPassword || "").trim();
          if (!confirmPassword) {
            return res.status(400).json({ message: "การเปลี่ยนสิทธิ์ต้องยืนยันด้วยรหัสผ่านของคุณ" });
          }
          const actorAccount = await User.findById(req.userId).select("+password").lean();
          const passwordOk = actorAccount?.password
            ? await bcrypt.compare(confirmPassword, actorAccount.password)
            : false;
          if (!passwordOk) {
            return res.status(401).json({ message: "รหัสผ่านไม่ถูกต้อง — เปลี่ยนสิทธิ์ไม่สำเร็จ" });
          }
          // 🔒 กันระบบไม่มีแอดมินเหลือเลย — ถ้าถอดสิทธิ์แอดมินคนสุดท้าย จะไม่มีใครเข้าไปแก้อะไรได้อีก
          // (รวมถึงตั้งสิทธิ์คืน) ต้องกู้ด้วยการแก้ฐานข้อมูลตรงๆ เท่านั้น
          if (currentRole === ROLES.ADMIN) {
            const admins = await User.countDocuments(rankFilter([ROLES.ADMIN]));
            if (admins <= 1) {
              return res.status(409).json({ message: "ถอดสิทธิ์แอดมินคนสุดท้ายไม่ได้ — ต้องมีแอดมินอย่างน้อย 1 คนในระบบ" });
            }
          }
          newUser.rank = wantedRole;   // Rank — ตำแหน่งในองค์กร
        }
      }

      /**
       * ── ชั้นสิทธิ์ "ในระบบ" (ผู้ดูแลระบบสูงสุด / ผู้ดูแลระบบ / ผู้ใช้งาน) ─────────────────
       * ✅ ผู้ใช้สั่งให้แยกสิทธิ์ในระบบออกจากตำแหน่งในองค์กร — ตั้งคนละช่อง คนละกติกา
       * 🔒 ตั้งได้เฉพาะผู้ดูแลระบบสูงสุด (manageSystem) · ยืนยันรหัสผ่านเหมือนการเปลี่ยนสิทธิ์ ·
       * เปลี่ยนของตัวเองไม่ได้ · และต้องเหลือผู้ดูแลระบบสูงสุดอย่างน้อย 1 คนเสมอ
       */
      if (req.body.systemRole !== undefined) {
        const wanted = String(req.body.systemRole || "").trim().toLowerCase();
        const currentSystemRole = systemRoleOf(existingUser);
        if (wanted !== currentSystemRole) {
          if (!can(req.user, "manageSystem")) {
            return res.status(403).json({ message: `ตั้งสิทธิ์ในระบบได้เฉพาะ ${SYSTEM_ROLE_LABEL[SYSTEM_ROLES.SUPER]} เท่านั้น` });
          }
          if (isSelf) {
            return res.status(403).json({ message: "เปลี่ยนสิทธิ์ในระบบของตัวเองไม่ได้ — ให้ผู้ดูแลระบบสูงสุดท่านอื่นเป็นคนเปลี่ยนให้" });
          }
          if (!ALL_SYSTEM_ROLES.includes(wanted)) {
            return res.status(400).json({ message: `สิทธิ์ในระบบไม่ถูกต้อง — ต้องเป็นหนึ่งใน: ${ALL_SYSTEM_ROLES.join(", ")}` });
          }
          const confirmPassword = String(req.body.confirmPassword || "").trim();
          if (!confirmPassword) {
            return res.status(400).json({ message: "การเปลี่ยนสิทธิ์ในระบบต้องยืนยันด้วยรหัสผ่านของคุณ" });
          }
          const actor = await User.findById(req.userId).select("+password").lean();
          const ok = actor?.password ? await bcrypt.compare(confirmPassword, actor.password) : false;
          if (!ok) return res.status(401).json({ message: "รหัสผ่านไม่ถูกต้อง — เปลี่ยนสิทธิ์ในระบบไม่สำเร็จ" });

          // 🔒 ต้องเหลือผู้ดูแลระบบสูงสุดอย่างน้อย 1 คน ไม่งั้นไม่มีใครเข้าหน้าตั้งค่าระบบได้อีกเลย
          if (currentSystemRole === SYSTEM_ROLES.SUPER && wanted !== SYSTEM_ROLES.SUPER) {
            const all = await User.find({}).select("rank role systemRole").lean();
            const supers = all.filter((u) => systemRoleOf(u) === SYSTEM_ROLES.SUPER);
            if (supers.length <= 1) {
              return res.status(409).json({
                message: `ลดชั้น ${SYSTEM_ROLE_LABEL[SYSTEM_ROLES.SUPER]} คนสุดท้ายไม่ได้ — ต้องมีอย่างน้อย 1 คนในระบบ`,
              });
            }
          }
          newUser.systemRole = wanted;
        }
      }

      if (req.file && req.file.path) {
        newUser.imageUrl = req.file.path;
        console.log("📷 Uploaded to:", req.file.path);
      } else {
        console.log("⚠️ ไม่มีไฟล์ใหม่ถูกอัปโหลด");
      }

      /**
       * 🐛 ที่แก้ (ผู้ใช้แจ้ง "ตอนนี้ยังต้อง logout ออกใหม่ตลอด"):
       * เดิมเปลี่ยน role แล้ว +1 sessionVersion → token เดิมหมดอายุ → เจ้าตัวถูกเตะออกกลางทาง
       * ✅ ไม่จำเป็นเลย เพราะ middleware/auth.js โหลด User จากฐานข้อมูลใหม่ "ทุก request" อยู่แล้ว
       * สิทธิ์จริงจึงเปลี่ยนทันทีตั้งแต่คำขอถัดไป ส่วนเมนู/ป้ายบนหน้าจอฝั่งเบราว์เซอร์รีเฟรชเอง
       * (ดู AuthContext.refreshUserData ฝั่งแอป)
       * ⚠️ sessionVersion ยังใช้อยู่สำหรับกรณีที่ต้อง "บังคับออกจากระบบ" จริงๆ เท่านั้น
       */
      const update = { $set: newUser };

      const updatedUser = await User.findByIdAndUpdate(
        userId,
        update,
        { new: true },
      ).exec();

      if (!updatedUser) {
        return res.status(404).send("User not found");
      }

      res.status(200).json({ user: publicUser(updatedUser) });
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

    const target = await User.findById(userId).select("rank role systemRole").lean();
    if (!target) return res.status(404).json({ message: "ไม่พบผู้ใช้ที่ต้องการลบ" });
    // 🔒 กฎข้อ 2 (ลำดับชั้น): ลบบัญชีที่ระดับสูงกว่าตัวเองไม่ได้ — แอดมินลบผู้จัดการไม่ได้
    if (!canManageUserOfRole(req.user, target.role)) {
      return res.status(403).json({ message: `คุณไม่มีสิทธิ์ลบบัญชีของ${rankLabelOf(target.role)} — ต้องให้ผู้ที่มีสิทธิ์สูงกว่าเป็นคนลบ` });
    }
    // 🔒 ระบบต้องเหลือแอดมินอย่างน้อย 1 คนเสมอ (เหตุผลเดียวกับการถอดสิทธิ์)
    if (normalizeRank(target) === ROLES.ADMIN) {
      const admins = await User.countDocuments(rankFilter([ROLES.ADMIN]));
      if (admins <= 1) {
        return res.status(409).json({ message: "ลบแอดมินคนสุดท้ายไม่ได้ — ต้องมีแอดมินอย่างน้อย 1 คนในระบบ" });
      }
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
