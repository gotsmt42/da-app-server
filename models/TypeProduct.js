// models/Product.js
const mongoose = require('../db');

const typeProductSchema = new mongoose.Schema({
  type: { type: String },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // เพิ่มฟิลด์ userId ที่เก็บ ObjectId ของผู้ใช้

}, { timestamps: true });

const TypeProduct = mongoose.model('TypeProduct', typeProductSchema);

module.exports = TypeProduct;
