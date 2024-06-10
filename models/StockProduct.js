const mongoose = require("mongoose");

const stockProductSchema = new mongoose.Schema(
  {
    productId: { type: mongoose.Schema.Types.ObjectId, ref: "Product" }, // เพิ่มฟิลด์ productId ที่เก็บ ObjectId ของสินค้า
    price: {
      type: mongoose.Types.Decimal128,
      required: true,
    },
    quantity: {
      type: Number,
      required: true,
    },
    countingUnit: {
      type: String,
      default: "EA",
    },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" }, // เพิ่มฟิลด์ userId ที่เก็บ ObjectId ของผู้ใช้
  },
  { timestamps: true }
);

const StockProduct = mongoose.model("StockProduct", stockProductSchema);

module.exports = StockProduct;
