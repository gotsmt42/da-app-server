const mongoose = require("../db");
const { imageSchema, fileSchema, editorSchema, STATUS } = require("./webShared");

/**
 * สินค้าที่แสดงบนเว็บไซต์บริษัท (หน้า /products)
 *
 * ⚠️ ห้ามเพิ่มช่องราคาในนี้ — ราคางานระบบขึ้นกับหน้างาน ราคาที่ขึ้นเว็บจะกลายเป็นราคาที่ลูกค้ายึด
 *    ไว้ต่อรองทุกครั้ง ให้ลูกค้าขอใบเสนอราคาแทน (ปุ่มบนการ์ดสินค้าพาไปฟอร์มพร้อมชื่อสินค้าแล้ว)
 * ⚠️ category ต้องตรงกับ PRODUCT_CATEGORIES ฝั่งเว็บ (da-web/src/data/products.ts) — หมวดที่ไม่รู้จัก
 *    จะไม่มีปุ่มกรองบนหน้าเว็บ ลูกค้าจะหาสินค้านั้นไม่เจอด้วยการกรอง
 */
const CATEGORIES = ["fire-alarm", "cctv", "access-control", "network", "security", "accessories"];

const webProductSchema = new mongoose.Schema(
  {
    category: { type: String, enum: CATEGORIES, required: true, index: true },
    /** ประเภทย่อย เช่น "ตู้ควบคุม" "อุปกรณ์ตรวจจับ" — เป็นตัวกรองชั้นที่สามบนหน้าเว็บ */
    type: { type: String, required: true, trim: true, maxlength: 80 },
    name: { type: String, required: true, trim: true, maxlength: 200 },
    brand: { type: String, required: true, trim: true, maxlength: 80 },
    /** รุ่นจริงจากแค็ตตาล็อกผู้ผลิต — ว่างได้ (เว็บไม่แสดง) */
    model: { type: String, default: "", trim: true, maxlength: 120 },
    description: { type: String, required: true, trim: true, maxlength: 1500 },
    specs: {
      type: [
        new mongoose.Schema(
          {
            label: { type: String, required: true, trim: true, maxlength: 80 },
            value: { type: String, required: true, trim: true, maxlength: 300 },
          },
          { _id: false }
        ),
      ],
      default: [],
      validate: [(v) => v.length <= 30, "ข้อมูลจำเพาะได้ไม่เกิน 30 แถว"],
    },
    /** รูปแรก = รูปหน้าปก */
    images: { type: [imageSchema], default: [], validate: [(v) => v.length <= 12, "รูปได้ไม่เกิน 12 รูป"] },
    datasheet: { type: fileSchema, default: () => ({}) },
    status: { type: String, enum: STATUS, default: "draft", index: true },
    /** ✅ สินค้าแนะนำ — ขึ้นก่อนในรายการ */
    featured: { type: Boolean, default: false },
    /** ลำดับที่ตั้งเอง — น้อยขึ้นก่อน */
    order: { type: Number, default: 0 },
    updatedBy: { type: editorSchema, default: () => ({}) },
  },
  { timestamps: true }
);

// หน้าเว็บขอ "ที่เผยแพร่แล้ว เรียงตามลำดับ" เสมอ — index ตามรูปคำถามจริง
webProductSchema.index({ status: 1, featured: -1, order: 1 });

webProductSchema.statics.CATEGORIES = CATEGORIES;

module.exports = mongoose.model("WebProduct", webProductSchema);
