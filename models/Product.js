// models/Product.js
const mongoose = require('../db');

const productSchema = new mongoose.Schema({
  name:  { type: String, default: '' },
  price: { type: Number, default: 0 },
  description: { type: String, default: '' },
  type: { type: String, default: '' },
  imageUrl: { type: String, default: 'asset/image/productDefault-1.png' }, // ให้เก็บ URL ของภาพ
  // image: { data: Buffer, contentType: String },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // เพิ่มฟิลด์ userId ที่เก็บ ObjectId ของผู้ใช้

}, { timestamps: true });

const Product = mongoose.model('Product', productSchema);

module.exports = Product;
