const mongoose = require("../db/");
const bcrypt = require("bcryptjs");

const customerSchema = new mongoose.Schema(
  {
    cCompany: { type: String, required: true },
    cSite: { type: String, required: true },
    cEmail: { type: String},
    cName: { type: String},
    address: { type: String },
    tel: String,
    tax: String,
    imageUrl: { type: String, default: "asset/image/userDefault-1.jpg" },

    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" }, // เพิ่มฟิลด์ userId และระบุ ref เป็น "User"
  },
  { timestamps: true }
);

const Customer = mongoose.model("Customer", customerSchema);
module.exports = Customer;
