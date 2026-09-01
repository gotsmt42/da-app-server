// routes/products.js
const express = require("express");
const router = express.Router();

const Customer = require("../models/Customer");
const CalendarEvent = require("../models/Events");
const User = require("../models/User");

const multer = require("multer");
const { UPLOAD_IMAGES_DIR } = require("../config/paths");

const { fileFilter, limits } = require("../config/upload");
const upload = multer({ dest: UPLOAD_IMAGES_DIR, fileFilter, limits });

const verifyToken = require("../middleware/auth");
const { can } = require("../config/roles");
const checkFile = require("../middleware/checkFile");

// Route to get all products
router.get("/", verifyToken, async (req, res) => {
  try {
    // ✅ ทุก role เห็นรายชื่อลูกค้า/โครงการทั้งหมดเหมือนกัน (ใช้เป็น master list ตอนเลือกชื่อโครงการ
    // ตอนเพิ่ม/แก้ไขแผนงาน) ไม่ใช่ข้อมูลส่วนตัวของใครคนใดคนหนึ่ง เดิมกรองเฉพาะของตัวเองสำหรับ non-admin
    // ทำให้ช่างเห็นโครงการที่คนอื่นเพิ่มไว้ไม่ครบ เวลาเพิ่มงานใหม่
    const userCustomers = await Customer.find({});

    // ดึง userId ทั้งหมดจาก userFiles
    // ⚠️ ต้องกรอง null/undefined ออกก่อนเสมอ — ลูกค้าที่ไม่มีเจ้าของเกิดได้ปกติ
    // (นำเข้าข้อมูล / สร้างอัตโนมัติตอนอนุมัติใบแจ้งงาน / เจ้าของถูกลบไปแล้ว)
    const userIds = userCustomers.map((customer) => customer.userId).filter(Boolean);

    // ค้นหาข้อมูลผู้ใช้จาก model User โดยใช้ userIds
    const users = await User.find({ _id: { $in: userIds } });

    // แปลงค่า userId ใน userFiles เป็น role จากข้อมูลใน users
    const updatedUserCustomers = userCustomers.map((customer) => {
      // 🐛 BUG ที่แก้ (ทั้ง GET /api/customer ตอบ 500 → ช่างเพิ่ม/แก้ไขแผนงานไม่ได้เลย):
      // เดิมเรียก customer.userId.toString() ตรงๆ — ลูกค้าแถวเดียวที่ไม่มี userId ทำให้
      // ทั้ง endpoint ล่ม และพังเป็นวงกว้างเพราะฟอร์มแผนงานเรียกเส้นทางนี้ตอนเปิดทุกครั้ง
      const user = customer.userId
        ? users.find((u) => u._id.toString() === customer.userId.toString())
        : null;
      if (user) {
        // คัดลอกค่าทั้งหมดของผู้ใช้ยกเว้น _id
        const { _id, ...userDataWithoutId } = user.toObject();
        return { ...customer._doc, user: userDataWithoutId }; // เพิ่ม property user ที่มีค่าข้อมูลผู้ใช้ยกเว้น _id
      } else {
        return customer;
      }
    });

    if (!userCustomers) {
      return res.status(404).json({ message: "Customers not found" });
    }

    res.json({ userCustomers: updatedUserCustomers });
  } catch (err) {
    console.error("Error fetching user products:", err);
    res.status(500).send(err.message);
  }
});

// Route to get one customer
/**
 * PATCH /api/customer/map — ตั้ง/แก้/ลบ "ลิงก์ตำแหน่งบน Google Maps" ของโครงการหนึ่ง
 *
 * ✅ ที่เพิ่ม (ผู้ใช้ขอ: "ทำแบบเดียวกันที่มีงานของทุกหน้า ให้ดู หรือแก้ไข google maps ได้"):
 * เดิมพิกัดมีเฉพาะในระบบใบแจ้งงาน — หน้าอื่นที่มีงาน (ปฏิทิน/การดำเนินงาน/ภาพรวมงาน) ไม่มีเลย
 *
 * ⚠️ เก็บที่ "ทะเบียนลูกค้า" ไม่ใช่ที่ตัวงานแต่ละใบ — โครงการเดิมอยู่ที่เดิมเสมอ ถ้าเก็บรายงาน
 * จะต้องมากรอกซ้ำทุกครั้งที่ลงงานใหม่ และงานเก่า/ใหม่ของที่เดียวกันจะมีพิกัดไม่ตรงกันได้
 * (เป็นเหตุผลเดียวกับที่ระบบใบแจ้งงานก็ sync ลงทะเบียนลูกค้าเช่นกัน)
 *
 * ⚠️ สิทธิ์ "แยกตามสิทธิเดิม" ตามที่ผู้ใช้ระบุ:
 *   • แอดมิน/ผู้จัดการ (manageMasterData) — เป็นเจ้าของทะเบียนลูกค้าอยู่แล้ว แก้ได้ทุกโครงการ
 *   • ช่างที่มีงานอยู่ที่โครงการนั้นจริง — คนที่ไปหน้างานเองคือคนที่รู้พิกัดที่ถูกต้องที่สุด
 *     (เช็คจากงานจริงในระบบ ไม่ใช่เชื่อค่าที่ส่งมา)
 *   • คนอื่น = อ่านอย่างเดียว (พิกัดถูกส่งไปกับ GET /api/customer อยู่แล้ว)
 */
router.patch("/map", verifyToken, async (req, res) => {
  try {
    const company = String(req.body.company || "").trim();
    const site = String(req.body.site || "").trim();
    if (!site) return res.status(400).json({ message: "ต้องระบุโครงการ" });

    // ลิงก์ต้องเป็น http(s) เท่านั้น — ค่านี้ถูกเอาไปใส่ href บนหน้าจอของทุกคนที่เห็นงานนี้
    // ถ้าปล่อย "javascript:..." ผ่านได้ จะกลายเป็นช่องทาง XSS ทันที
    const rawUrl = String(req.body.mapUrl || "").trim();
    let mapUrl = "";
    if (rawUrl) {
      try {
        const u = new URL(rawUrl);
        if (!["http:", "https:"].includes(u.protocol)) throw new Error("bad protocol");
        mapUrl = rawUrl;
      } catch {
        return res.status(400).json({ message: "ลิงก์ไม่ถูกต้อง — ต้องขึ้นต้นด้วย http:// หรือ https://" });
      }
    }

    let allowed = can(req.user, "manageMasterData");
    if (!allowed) {
      // มีงานของตัวเองอยู่ที่โครงการนี้ไหม (ผู้รับผิดชอบ / ทีมเข้างาน / คนสร้างงาน)
      const uid = String(req.userId || "");
      const mine = await CalendarEvent.exists({
        site,
        ...(company ? { company } : {}),
        $or: [
          { responsiblePersonId: uid },
          { resPerson: uid },
          { userId: uid },
          { team: req.user?.fname },
          { "teamMembers.userId": uid },
        ],
      });
      allowed = Boolean(mine);
    }
    if (!allowed) {
      return res.status(403).json({ message: "แก้พิกัดได้เฉพาะแอดมิน/ผู้จัดการ หรือช่างที่มีงานอยู่ที่โครงการนี้" });
    }

    // ⚠️ ทะเบียนลูกค้ามี unique index ที่ (cCompany, cSite) — ต้อง match ด้วยคู่นี้เท่านั้น
    // ⚠️ ต้องใส่ userId ให้แถวใหม่เสมอ (GET /api/customer อ่านฟิลด์นี้ — แถวไม่มีเจ้าของเคยทำให้ 500)
    await Customer.updateOne(
      { cCompany: company, cSite: site },
      { $set: { mapUrl }, $setOnInsert: { cCompany: company, cSite: site, userId: req.userId } },
      { upsert: true }
    );
    const customer = await Customer.findOne({ cCompany: company, cSite: site }).lean();
    res.json({ customer });
  } catch (err) {
    console.error("❌ แก้พิกัดโครงการไม่สำเร็จ:", err);
    res.status(500).json({ message: "แก้พิกัดโครงการไม่สำเร็จ" });
  }
});

router.get("/:id", verifyToken, async (req, res) => {
  const id = req.params.id;
  try {
    const customer = await Customer.findOne({ _id: id }).exec();
    res.json({ customer });
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// Route to create a new product
router.post(
  "/",
  verifyToken,
  upload.single("image"),
  checkFile,

  async (req, res) => {
    try {
      const userId = req.userId;

      const { cCompany, cSite,  cEmail, cName, address, tel, tax } = req.body;

      const imageUrl = req.imageUrl;

      const customer = new Customer({
        cCompany,
        cSite,
        cEmail,
        cName,
        address,
        tel,
        tax,
        imageUrl,
        userId,
      });
      const newCustomer = await customer.save({});

      res
        .status(201)
        .json({ message: "Customer created successfully", data: newCustomer });

      // console.log(product);
    } catch (err) {
      // ✅ ชนกับ unique index (cCompany+cSite) — โครงการนี้มีอยู่แล้วจริงๆ ไม่ใช่ error ร้ายแรง
      if (err.code === 11000) {
        return res.status(409).send("มีโครงการนี้อยู่แล้ว");
      }
      res.status(500).send(err.message);
    }
  }
);

// Route to update a product
router.put(
  "/:id",
  verifyToken,
  upload.single("image"),
  checkFile,
  async (req, res) => {
    const id = req.params.id;

    try {
      const existingCustomer = await Customer.findById(id);
      if (!existingCustomer) {
        return res.status(404).send("Product not found.");
      }

      // ✅ ตอนนี้ทุก role เห็นลูกค้า/โครงการของทุกคนแล้ว (จาก GET /) จึงต้องเช็คสิทธิ์แก้ไขตรงนี้เพิ่ม
      // ไม่งั้นใครก็แก้ไขข้อมูลของคนอื่นได้หมดแค่รู้ id (เดิมไม่มีการเช็คเลย)
      if (existingCustomer.userId !== req.userId && !can(req.user, "manageAll")) {
        return res.status(403).send("Unauthorized to edit this customer.");
      }

      const { cCompany, cSite, cEmail, cName,  address, tel, tax} = req.body;

      const imageUrl = req.imageUrl;

      const newCustomer = {
        cCompany,
        cSite,
        cEmail,
        cName,

        address,
        tel,
        tax,
        imageUrl,
      };

      await Customer.findOneAndUpdate({ _id: id }, newCustomer, {
        new: true,
      }).exec();

      res.status(200).send("Product updated successfully");
    } catch (err) {
      if (err.code === 11000) {
        return res.status(409).send("มีโครงการนี้อยู่แล้ว");
      }
      res.status(500).send(err.message);
    }
  }
);

// Route to delete a product
router.delete("/:id", verifyToken, async (req, res) => {
  try {
    const id = req.params.id;

    const customerToDelete = await Customer.findById(id);
    if (!customerToDelete) {
      return res.status(404).send("Product not found.");
    }

    // Check if the authenticated user is the owner of the file or an admin
    if (customerToDelete.userId !== req.userId && !can(req.user, "manageAll")) {
      return res.status(403).send("Unauthorized to delete this file.");
    }

    // Delete file from disk
    // fs.unlinkSync(productToDelete.imageUrl);

    // Delete file from database
    await Customer.findByIdAndDelete(id);

    res.status(200).send("Product deleted successfully");
  } catch (err) {
    console.error("Error deleting Product:", err);
    res.status(500).send(err.message);
  }
});

module.exports = router;
