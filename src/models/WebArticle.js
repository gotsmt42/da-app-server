const mongoose = require("../db");
const { imageSchema, editorSchema, STATUS, SLUG_RE } = require("./webShared");

/**
 * บทความบนเว็บไซต์บริษัท (หน้า /articles และ /articles/[slug])
 *
 * ⚠️ เนื้อหาเก็บเป็น "บล็อก" (ย่อหน้า หัวข้อ รายการ ตาราง หมายเหตุ) ไม่ใช่ HTML ดิบ
 *    หน้าเว็บจึงวาดได้โดยไม่ต้องใช้ dangerouslySetInnerHTML — ไม่มีช่องให้ฝังสคริปต์ (XSS)
 *    ต่อให้บัญชีผู้ดูแลถูกขโมยไป ก็แทรกโค้ดขึ้นเว็บสาธารณะผ่านบทความไม่ได้
 */
const BLOCK_TYPES = ["p", "h2", "list", "table", "note"];

const blockSchema = new mongoose.Schema(
  {
    type: { type: String, enum: BLOCK_TYPES, required: true },
    /** ใช้กับ p / h2 / note */
    text: { type: String, default: "", maxlength: 5000 },
    /** ใช้กับ list */
    items: { type: [{ type: String, maxlength: 1000 }], default: undefined },
    /** ใช้กับ table — หัวตาราง และแถว (แต่ละแถวต้องมีจำนวนช่องเท่าหัวตาราง) */
    head: { type: [{ type: String, maxlength: 200 }], default: undefined },
    rows: { type: [[{ type: String, maxlength: 500 }]], default: undefined },
  },
  { _id: false }
);

const webArticleSchema = new mongoose.Schema(
  {
    slug: {
      type: String, required: true, unique: true, trim: true, lowercase: true, maxlength: 120,
      match: [SLUG_RE, "slug ใช้ได้เฉพาะ a-z 0-9 และขีด (-) เช่น fire-alarm-pm-checklist"],
    },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    /** ⚠️ ใช้เป็น meta description ด้วย — ยาวราว 120–160 ตัวอักษรกำลังดี */
    description: { type: String, required: true, trim: true, maxlength: 400 },
    category: { type: String, required: true, trim: true, maxlength: 60 },
    /** slug ของบริการที่เกี่ยวข้อง — ใช้ทำกล่อง "บริการที่เกี่ยวข้อง" ข้างบทความ */
    relatedService: { type: String, default: "", trim: true, maxlength: 60 },
    keywords: { type: [{ type: String, trim: true, maxlength: 80 }], default: [] },
    cover: { type: imageSchema, default: undefined },
    body: {
      type: [blockSchema],
      default: [],
      validate: [(v) => v.length <= 200, "เนื้อหายาวเกินไป (ไม่เกิน 200 บล็อก)"],
    },
    status: { type: String, enum: STATUS, default: "draft", index: true },
    /** วันที่แสดงบนเว็บ — ตั้งตอนกดเผยแพร่ครั้งแรก แก้ทีหลังไม่เปลี่ยน (ไม่งั้นบทความเก่ากลายเป็น "ใหม่" ทุกครั้งที่แก้คำผิด) */
    publishedAt: { type: Date, default: null },
    updatedBy: { type: editorSchema, default: () => ({}) },
  },
  { timestamps: true }
);

webArticleSchema.index({ status: 1, publishedAt: -1 });
webArticleSchema.statics.BLOCK_TYPES = BLOCK_TYPES;

module.exports = mongoose.model("WebArticle", webArticleSchema);
