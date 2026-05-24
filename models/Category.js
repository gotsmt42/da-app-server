// models/Category.js
const mongoose = require('../db/');

const categorySchema = new mongoose.Schema({
  name: { type: String, unique: true, trim: true }, // ✅ ไม่ให้ซ้ำ
}, { timestamps: true });

const Category = mongoose.model('Category', categorySchema);
module.exports = Category;
