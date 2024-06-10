const express = require("express");
const router = express.Router();

const StockProduct = require("../models/StockProduct");
const verifyToken = require("../middleware/auth");
const User = require("../models/User");
const Product = require("../models/Product");

router.get("/", verifyToken, async (req, res) => {
  try {
    const userId = req.userId;

    let userStock;

    if (req.user.role === "admin") {
      userStock = await StockProduct.find({});
    } else {
      userStock = await StockProduct.find({ userId: userId });
    }

    // ดึง userId ทั้งหมดจาก userStock
    const userIds = userStock.map((product) => product.userId);

    // ดึงข้อมูลผู้ใช้จาก model User โดยใช้ userIds
    const users = await User.find({ _id: { $in: userIds } });

    // แปลงข้อมูลผู้ใช้ให้อยู่ในรูปแบบของ Object โดยใช้ _id เป็น key
    const usersMap = users.reduce((acc, user) => {
      acc[user._id.toString()] = user.toObject();
      return acc;
    }, {});

    // แปลงข้อมูล StockProduct ให้อยู่ในรูปแบบของ Object โดยใช้ _id เป็น key
    const userStockMap = userStock.reduce((acc, product) => {
      acc[product._id.toString()] = product.toObject();
      return acc;
    }, {});

    // ดึงรายการ productId ทั้งหมดจาก userStock
    const productIds = userStock.map((product) => product.productId);

    // ดึงข้อมูล Product จากฐานข้อมูลโดยใช้ productId ที่ได้
    const products = await Product.find({ _id: { $in: productIds } });

    // แปลงข้อมูล Product ให้อยู่ในรูปแบบของ Object โดยใช้ _id เป็น key
    const productsMap = products.reduce((acc, product) => {
      acc[product._id.toString()] = product.toObject();
      return acc;
    }, {});

    // อัพเดตข้อมูล StockProduct โดยเพิ่มข้อมูลผู้ใช้และ Product ในแต่ละรายการ
    const updatedUserStock = Object.keys(userStockMap).map((productId) => {
      const product = userStockMap[productId];
      const user = usersMap[product.userId.toString()];
      const productInfo = productsMap[product.productId.toString()];
      if (user && productInfo) {
        const { _id, ...userDataWithoutId } = user;
        return { ...product, user: userDataWithoutId, productInfo: productInfo };
      } else {
        return product;
      }
    });

    if (!userStock) {
      return res.status(404).json({ message: "Stocks not found" });
    }

    res.json({ userStock: updatedUserStock });
  } catch (err) {
    console.error("Error fetching user products:", err);
    res.status(500).send(err.message);
  }
});


router.post("/", verifyToken, async (req, res) => {
  try {
    const userId = req.userId;

    const { productId, price, quantity, countingUnit } = req.body;

    const newStockProduct = new StockProduct({
      productId,
      price,
      quantity,
      countingUnit,
      userId,
    });

    await newStockProduct.save();

    res.status(201).json({ message: "Stock added successfully" });
  } catch (err) {
    console.error("Error adding stock:", err);
    res.status(500).send(err.message);
  }
});

module.exports = router;
