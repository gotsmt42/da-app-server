const mongoose = require('../db');

const productSchema = new mongoose.Schema({
  name:  { type: String, default: '' },
  description: { type: String, default: '' },
  type: { type: String, default: '' },
  imageUrl: { type: String, default: 'asset/image/productDefault-1.png' }, // ให้เก็บ URL ของภาพ
  stockProductId: { type: mongoose.Schema.Types.ObjectId, ref: "StockProduct" }, // เพิ่มฟิลด์ stockProductId และระบุ ref เป็น "StockProduct"
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // เพิ่มฟิลด์ userId และระบุ ref เป็น "User"

}, { timestamps: true });

const Product = mongoose.model('Product', productSchema);

module.exports = Product;
