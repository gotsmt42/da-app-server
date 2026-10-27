const mongoose = require("../db");

/**
 * StockItem — สินค้า/ทรัพย์สินในคลังของแผนก (เมนู "สต๊อก · ทรัพย์สินแผนก")
 *
 * ✅ (27 ต.ค. 2569 ผู้ใช้: "ทำระบบสต๊อกสินค้าแผนก ต้องให้กรอกใบเบิกเพื่อขอเบิก และตัดยอดออกจากข้อมูล realtime"
 *    · "หรือเป็นทรัพย์สินแผนก" → เลือก "มีทั้ง 2 แบบ" · "แยกคลังต่อแผนก")
 *   kind:
 *     consumable = วัสดุสิ้นเปลือง/อะไหล่ → เบิกแล้วตัดยอดถาวร
 *     asset      = ทรัพย์สิน/เครื่องมือ (สว่าน บันได มิเตอร์) → ยืมไปใช้ ต้องคืน (ตัดยอดตอนจ่าย คืนยอดตอนรับคืน)
 *   ยอด:
 *     qty      = จำนวนที่อยู่ในคลังตอนนี้ (หยิบได้จริง)
 *     reserved = จองไว้ให้ใบเบิกที่รออนุมัติ (ยังไม่ออกจากคลัง) → เบิกได้ = qty − reserved
 *     onLoan   = ทรัพย์สินที่ยืมออกไปอยู่ (เฉพาะ asset) → ทั้งหมดที่แผนกมี = qty + onLoan
 * ⚠️ ทุกการเปลี่ยนยอดทำผ่าน routes/stock.js แบบอะตอมมิก ($inc + เงื่อนไข) และบันทึก StockMove ทุกครั้ง
 */
const stockItemSchema = new mongoose.Schema(
  {
    dept: { type: String, required: true, index: true },
    code: { type: String, default: "", index: true },
    name: { type: String, required: true, trim: true },
    kind: { type: String, enum: ["consumable", "asset"], default: "consumable" },
    category: { type: String, default: "", trim: true },
    unit: { type: String, default: "ชิ้น", trim: true },
    qty: { type: Number, default: 0, min: 0 },
    reserved: { type: Number, default: 0, min: 0 },
    onLoan: { type: Number, default: 0, min: 0 },
    /** จุดสั่งซื้อ — คงเหลือ (เบิกได้) ต่ำกว่านี้ = ขึ้นป้าย "ใกล้หมด" */
    minQty: { type: Number, default: 0, min: 0 },
    location: { type: String, default: "", trim: true },
    /** รูปสินค้า (Cloudinary) — ✅ ผู้ใช้: "ให้ใส่รูปสินค้าได้ด้วย และแสดงให้สวยงาม ไม่รก" */
    photo: { url: { type: String, default: "" }, publicId: { type: String, default: "" } },
    note: { type: String, default: "", trim: true },
    active: { type: Boolean, default: true, index: true },
    createdBy: { userId: { type: String, default: "" }, name: { type: String, default: "" } },
  },
  { timestamps: true }
);
stockItemSchema.index({ dept: 1, name: 1 });

module.exports = mongoose.model("StockItem", stockItemSchema);
