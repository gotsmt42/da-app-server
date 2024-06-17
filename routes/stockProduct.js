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
      return res.status(404).json({ message: "Stocks not found" });
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
    const { productId, price, quantity, countingUnit } = req.body;

    const product = await Product.findById(productId);
    if (!product) {
      return res.status(404).json({ message: "Product not found" });
    }

    const existingStockProduct = await StockProduct.findOne({
      userId,
      productId,
    });

    if (existingStockProduct) {
      // If stock for this product and user exists, update quantity and price
      existingStockProduct.quantity = quantity;
      existingStockProduct.price = price;
      existingStockProduct.countingUnit = countingUnit;
      await existingStockProduct.save();
      res.json({ message: "Stock updated successfully" });
    } else {
      // If stock doesn't exist, create a new one
      const newStockProduct = new StockProduct({
        productId,
        price,
        quantity,
        countingUnit,
        userId,
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

    res.status(200).send("Stock Product deleted successfully");
  } catch (err) {
    console.error("Error deleting Stock Product:", err);
    res.status(500).send(err.message);
  }
});

module.exports = router;
