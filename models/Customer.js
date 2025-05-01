const mongoose = require("../db/");
const bcrypt = require("bcryptjs");

const customerSchema = new mongoose.Schema(
  {
    cCompany: { type: String, required: true },
    cSite: { type: String, required: true },
    cName: { type: String, required: true },
    cEmail: { type: String, required: true },
    projName: { type: String, required: true },
    contactP: { type: String },
    address: { type: String },
    tel: String,
    imageUrl: { type: String, default: "asset/image/userDefault-2.jpg" },

    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" }, // เพิ่มฟิลด์ userId และระบุ ref เป็น "User"
  },
  { timestamps: true }
);

const Customer = mongoose.model("Customer", customerSchema);
module.exports = Customer;
