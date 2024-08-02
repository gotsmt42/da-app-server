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

    if (!userStock || userStock.length === 0) {
       // ถ้าไม่มีข้อมูล stock หรือ userStock เป็น array ว่าง
      return res.status(200).json({ userStock: [] }); // ส่ง response กลับไปว่าไม่มีข้อมูล
    }

    const userIds = userStock.map((product) => product.userId);
    const users = await User.find({ _id: { $in: userIds } });

    const usersMap = users.reduce((acc, user) => {
      acc[user._id.toString()] = user.toObject();
      return acc;
    }, {});

    const userStockMap = userStock.reduce((acc, product) => {
      acc[product._id.toString()] = product.toObject();
      return acc;
    }, {});

    const productIds = userStock.map((product) => product.productId);
    const products = await Product.find({ _id: { $in: productIds } });

    const productsMap = products.reduce((acc, product) => {
      acc[product._id.toString()] = product.toObject();
      return acc;
    }, {});

    const updatedUserStock = Object.keys(userStockMap).map((productId) => {
      const product = userStockMap[productId];
      const user = usersMap[product.userId.toString()];
      const productInfo = productsMap[product.productId.toString()];
      if (user && productInfo) {
        const { _id, ...userDataWithoutId } = user;
        return {
          ...product,
          user: userDataWithoutId,
          productInfo: productInfo,
        };
      } else {
        return product;
      }
    });

    res.json({ userStock: updatedUserStock });
  } catch (err) {
    console.error("Error fetching user products:", err);
    res.status(500).send(err.message);
  }
});

router.post("/", verifyToken, async (req, res) => {
  try {
    const userId = req.userId;
    const { productId, quantity } = req.body;

    // ค้นหาข้อมูลสินค้าโดยใช้ productId
    const product = await Product.findById(productId);
    if (!product) {
      return res.status(404).json({ message: "Product not found" });
    }

    // ตรวจสอบว่าสินค้าคงคลังมีอยู่หรือไม่
    const existingStockProduct = await StockProduct.findOne({ userId, productId });

    if (existingStockProduct) {
      // หากสินค้าคงคลังมีอยู่แล้ว ให้ทำการอัปเดตข้อมูล
      existingStockProduct.quantity = quantity;
      existingStockProduct.name = product.name;
      existingStockProduct.description = product.description;
      existingStockProduct.type = product.type;
      existingStockProduct.price = product.price;
      existingStockProduct.countingUnit = product.countingUnit;
      existingStockProduct.imageUrl = product.imageUrl;

      await existingStockProduct.save();
      res.json({ message: "Stock updated successfully" });
    } else {
      // หากสินค้าคงคลังยังไม่มี ให้สร้างใหม่พร้อมข้อมูลจากสินค้า
      const newStockProduct = new StockProduct({
        productId,
        quantity,
        userId,
        name: product.name,
        description: product.description,
        type: product.type,
        price: product.price,
        countingUnit: product.countingUnit,
        imageUrl: product.imageUrl,
      });

      await newStockProduct.save();
      res.status(201).json({ message: "Stock added successfully" });
    }
  } catch (err) {
    console.error("Error adding/updating stock:", err);
    res.status(500).send(err.message);
  }
});
router.delete("/:id", verifyToken, async (req, res) => {
  try {
    const id = req.params.id;

    const productToDelete = await StockProduct.findById(id);

    // Check if the authenticated user is the owner of the stock product or an admin
    if (
      productToDelete.userId.toString() !== req.userId.toString() &&
      req.user.role !== "admin"
    ) {
      return res.status(403).send("Unauthorized to delete.");
    }

    // Delete stock product from database
    await StockProduct.findByIdAndDelete(id);

    // Fetch updated user stocks after deletion
    const userId = req.userId;
    const updatedStocks = await StockProduct.find({ userId });

    res.status(200).json({ message: "Stock Product deleted successfully", userStock: updatedStocks });
  } catch (err) {
    console.error("Error deleting Stock Product:", err);
    res.status(500).send(err.message);
  }
});

module.exports = router;
