const mongoose = require("../db");

/**
 * StockMove — ประวัติการเคลื่อนไหวของสต๊อก (ทุกการเปลี่ยนยอดต้องมี 1 แถว)
 *   in      รับเข้า/เติมสต๊อก (+)
 *   out     จ่ายตามใบเบิก — วัสดุสิ้นเปลือง (−)
 *   loan    ยืมทรัพย์สินออกตามใบเบิก (−)
 *   return  รับคืนทรัพย์สิน (+)
 *   adjust  ตรวจนับ/ปรับยอด (± ตามผลต่าง)
 *   damage  รับคืนสภาพชำรุด → ยอดรอซ่อม (qty = จำนวน · ยอดในคลังไม่เปลี่ยน)
 *   lost    ทรัพย์สินสูญหาย → ตัดจำหน่าย (qty = จำนวน)
 *   repair  ซ่อมเสร็จ → กลับเข้าคลัง (+)
 *   writeoff ตัดจำหน่ายของชำรุด (qty = จำนวน)
 * balance = ยอดในคลัง (qty) หลังรายการนี้
 */
const stockMoveSchema = new mongoose.Schema(
  {
    item: { type: mongoose.Schema.Types.ObjectId, ref: "StockItem", index: true },
    itemName: { type: String, default: "" },
    unit: { type: String, default: "" },
    dept: { type: String, index: true },
    type: { type: String, enum: ["in", "out", "loan", "return", "adjust", "damage", "lost", "repair", "writeoff"], required: true },
    qty: { type: Number, required: true },
    balance: { type: Number, default: 0 },
    requestId: { type: String, default: "" },
    docNo: { type: String, default: "" },
    eventId: { type: String, default: "" },
    jobTitle: { type: String, default: "" },
    note: { type: String, default: "" },
    by: { userId: { type: String, default: "" }, name: { type: String, default: "" } },
    at: { type: Date, default: Date.now, index: true },
  },
  { timestamps: false }
);
stockMoveSchema.index({ dept: 1, at: -1 });

module.exports = mongoose.model("StockMove", stockMoveSchema);
