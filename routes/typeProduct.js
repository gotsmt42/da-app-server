// routes/products.js
const express = require("express");
const router = express.Router();

const Product = require("../models/Product");
const TypeProduct = require("../models/TypeProduct");
const User = require("../models/User");


const verifyToken = require("../middleware/auth");

// // Route to get all products
router.get("/", verifyToken, async (req, res) => {
  try {
    const userId = req.userId;

    let userTypeProducts

    if (req.user.role === "admin") {
        userTypeProducts = await TypeProduct.find({});
    } else {
        userTypeProducts = await TypeProduct.find({ userId: userId});
    }

    // ดึง userId ทั้งหมดจาก userFiles
    const userIds = userTypeProducts.map(type => type.userId);

    // ค้นหาข้อมูลผู้ใช้จาก model User โดยใช้ userIds
    const users = await User.find({ _id: { $in: userIds } });

    // แปลงค่า userId ใน userProduct เป็น role จากข้อมูลใน users
    const updatedUserTypeProducts = userTypeProducts.map(typeProduct => {
      const user = users.find(user => user._id.toString() === typeProduct.userId.toString());
      if (user) {
        // คัดลอกค่าทั้งหมดของผู้ใช้ยกเว้น _id
        const { _id, ...userDataWithoutId } = user.toObject();
        return { ...typeProduct._doc, user: userDataWithoutId }; // เพิ่ม property user ที่มีค่าข้อมูลผู้ใช้ยกเว้น _id
      } else {
        return type; // ถ้าไม่พบ user ให้ใช้ค่าเดิมของ file
      }
    });



    if (!userTypeProducts) {
      return res.status(404).json({ message: "Type product not found" });
    }

    res.json({ userTypeProducts: updatedUserTypeProducts });
  } catch (err) {
    console.error("Error fetching user type products:", error);
    res.status(500).send(err.message);
  }
});

// // Route to get one products
// router.get("/:id", verifyToken, async (req, res) => {
//   const id = req.params.id;
//   try {
//     const product = await Product.findOne({ _id: id }).exec();
//     res.json({ product });
//   } catch (err) {
//     res.status(500).send(err.message);
//   }
// });

// // Route to update a product
// router.put(
//   "/:id",
//   verifyToken,
//   upload.single("image"),
//   checkFile,
//   async (req, res) => {
//     const id = req.params.id;

//     try {
//       const { name, price, description, type } = req.body;

//       const imageUrl = req.imageUrl;

//       const newProduct = {
//         name,
//         price,
//         description,
//         type,
//         imageUrl,
//       };

//       await Product.findOneAndUpdate({ _id: id }, newProduct, {
//         new: true,
//       }).exec();

//       res.status(200).send("Product updated successfully");
//     } catch (err) {
//       res.status(500).send(err.message);
//     }
//   }
// );

// // Route to delete a product
// router.delete("/:id", verifyToken, async (req, res) => {
//   try {
//     const id = req.params.id;

//     const productToDelete = await Product.findById(id);
//     if (!productToDelete) {
//       return res.status(404).send("Product not found.");
//     }

//     // Check if the authenticated user is the owner of the file or an admin
//     if (productToDelete.userId !== req.userId && req.user.role !== "admin") {
//       return res.status(403).send("Unauthorized to delete this file.");
//     }

//     // Delete file from disk
//     // fs.unlinkSync(productToDelete.imageUrl);

//     // Delete file from database
//     await Product.findByIdAndDelete(id);

//     res.status(200).send("Product deleted successfully");
//   } catch (err) {
//     console.error("Error deleting Product:", err);
//     res.status(500).send(err.message);
//   }
// });



module.exports = router;
