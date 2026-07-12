// routes/products.js
const express = require("express");
const router = express.Router();

const fs = require("fs");
const Customer = require("../models/Customer");
const User = require("../models/User");

const multer = require("multer");
// const path = require("path");

const upload = multer({ dest: "asset/uploads/images/" });

const verifyToken = require("../middleware/auth");
const checkFile = require("../middleware/checkFile");

// Route to get all products
router.get("/", verifyToken, async (req, res) => {
  try {
    // ✅ ทุก role เห็นรายชื่อลูกค้า/โครงการทั้งหมดเหมือนกัน (ใช้เป็น master list ตอนเลือกชื่อโครงการ
    // ตอนเพิ่ม/แก้ไขแผนงาน) ไม่ใช่ข้อมูลส่วนตัวของใครคนใดคนหนึ่ง เดิมกรองเฉพาะของตัวเองสำหรับ non-admin
    // ทำให้ช่างเห็นโครงการที่คนอื่นเพิ่มไว้ไม่ครบ เวลาเพิ่มงานใหม่
    const userCustomers = await Customer.find({});

    // ดึง userId ทั้งหมดจาก userFiles
    const userIds = userCustomers.map((customer) => customer.userId);

    // ค้นหาข้อมูลผู้ใช้จาก model User โดยใช้ userIds
    const users = await User.find({ _id: { $in: userIds } });

    // แปลงค่า userId ใน userFiles เป็น role จากข้อมูลใน users
    const updatedUserCustomers = userCustomers.map((customer) => {
      const user = users.find(
        (user) => user._id.toString() === customer.userId.toString()
      );
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
      if (existingCustomer.userId !== req.userId && req.user.role !== "admin") {
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
    if (customerToDelete.userId !== req.userId && req.user.role !== "admin") {
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
