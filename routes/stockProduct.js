const express = require("express");
const router = express.Router();

const StockProduct = require("../models/StockProduct");
const verifyToken = require("../middleware/auth");
const User = require("../models/User");

router.get("/", verifyToken, async (req, res) => {
    try {
      const userId = req.userId;
  
      let userProducts;
  
      if (req.user.role === "admin") {
        userProducts = await StockProduct.find({});
      } else {
        userProducts = await StockProduct.find({ userId: userId });
      }
  
      // ดึง userId ทั้งหมดจาก userFiles
      const userIds = userProducts.map((stock) => stock.userId);
  
      // ค้นหาข้อมูลผู้ใช้จาก model User โดยใช้ userIds
      const users = await User.find({ _id: { $in: userIds } });
  
      // แปลงค่า userId ใน userFiles เป็น role จากข้อมูลใน users
      const updatedUserProducts = userProducts.map((product) => {
        const user = users.find(
          (user) => user._id.toString() === product.userId.toString()
        );
        if (user) {
          // คัดลอกค่าทั้งหมดของผู้ใช้ยกเว้น _id
          const { _id, ...userDataWithoutId } = user.toObject();
          return { ...product._doc, user: userDataWithoutId }; // เพิ่ม property user ที่มีค่าข้อมูลผู้ใช้ยกเว้น _id
        } else {
          return product; // ถ้าไม่พบ user ให้ใช้ค่าเดิมของ file
        }
      });
  
      if (!userProducts) {
        return res.status(404).json({ message: "Stock products not found" });
      }
  
      res.json({ userStockProducts: updatedUserProducts });
    } catch (err) {
      console.error("Error fetching user stock products:", error);
      res.status(500).send(err.message);
    }
  });

router.post("/", verifyToken, async (req, res) => {
  try {
    const userId = req.userId;

    const { productId, price, quantity } = req.body;


    const newStockProduct = new StockProduct({
      productId,
      price,
      quantity,
      userId
    });

    console.log(newStockProduct);

    await newStockProduct.save();

    res.status(201).json({ message: "Stock added successfully" });
  } catch (err) {
    res.status(500).send(err.message);
  }
});

router.put("/:id", verifyToken, async (req, res) => {
  const id = req.params.id;

  try {
    const { price, quantity } = req.body;

    await StockProduct.findByIdAndUpdate(id, { price, quantity });

    res.status(200).send("Stock updated successfully");
  } catch (err) {
    res.status(500).send(err.message);
  }
});

router.delete("/:id", verifyToken, async (req, res) => {
  try {
    const id = req.params.id;

    await StockProduct.findByIdAndDelete(id);

    res.status(200).send("Stock deleted successfully");
  } catch (err) {
    console.error("Error deleting stock:", err);
    res.status(500).send(err.message);
  }
});


module.exports = router;
