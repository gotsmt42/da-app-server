const mongoose = require("mongoose");

const stockProductSchema = new mongoose.Schema(
  {
    productId: { type: mongoose.Schema.Types.ObjectId, ref: "Product" }, // เพิ่มฟิลด์ productId ที่เก็บ ObjectId ของสินค้า
    name: { type: String, default: "" },

    description: { type: String, default: ""},
    type: { type: String, default: "" },
    price: {
      type: mongoose.Types.Decimal128,
    },
    countingUnit: {
      type: String,
      default: "EA",
    },
    imageUrl: { type: String, default: "asset/image/productDefault-1.png" }, // ให้เก็บ URL ของภาพ
    quantity: {
      type: Number,
      required: true,
    },
    
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" }, // เพิ่มฟิลด์ userId ที่เก็บ ObjectId ของผู้ใช้
  },
  { timestamps: true }
);

const StockProduct = mongoose.model("StockProduct", stockProductSchema);

module.exports = StockProduct;
