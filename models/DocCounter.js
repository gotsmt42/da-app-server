const mongoose = require("../db/");

/**
 * DocCounter — ตัวนับเลขที่เอกสารแบบ "เดินหน้าอย่างเดียว" ต่อชนิดเอกสาร + ต่อปี
 *
 * ✅ ทำไมต้องเก็บที่ฐานข้อมูล ไม่ใช่ localStorage ฝั่งเบราว์เซอร์:
 * เลขที่เอกสารเป็นเลขอ้างอิงที่ส่งให้ลูกค้าและใช้ตามงานกันจริง ห้ามซ้ำเด็ดขาด — ถ้าเก็บฝั่งเบราว์เซอร์
 * แต่ละเครื่อง/แต่ละคนจะมีตัวนับของตัวเองแยกกัน แอดมิน 2 คนออกใบพร้อมกันก็ได้เลขเดียวกันทันที
 * และล้างแคชเบราว์เซอร์ทีเดียวเลขก็ย้อนกลับไปเริ่มใหม่
 *
 * ✅ findOneAndUpdate + $inc เป็น operation เดียวที่ MongoDB การันตีความเป็น atomic ให้ในตัว
 * (ต่อให้มีคนกดออกใบพร้อมกัน 10 คน ก็ได้เลขคนละใบแน่นอน ไม่ต้องใช้ transaction/lock เพิ่ม)
 *
 * key = `${docType}:${year}` เช่น "delivery:2569" — แยกตัวนับตามปี พ.ศ. ให้เลขรีเซ็ตเองทุกต้นปี
 * ตามรูปแบบเลขที่เอกสารที่บริษัทใช้อยู่ (เช่น 050008/2569)
 */
const docCounterSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, index: true },
    seq: { type: Number, required: true, default: 0 },
  },
  { timestamps: true }
);

const DocCounter = mongoose.model("DocCounter", docCounterSchema);
module.exports = DocCounter;
