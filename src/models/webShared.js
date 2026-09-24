const mongoose = require("../db");

/**
 * ชิ้นส่วนร่วมของ "เนื้อหาเว็บไซต์บริษัท" (da-web) — สินค้า ผลงาน บทความ ยี่ห้อ
 *
 * ⚠️ แยกคอลเลกชันจาก Product/StockProduct เดิมโดยตั้งใจ — ของเดิมคือสินค้าภายใน (ราคาทุน สต็อก)
 *    ส่วนนี้คือสิ่งที่ "คนทั้งโลกเห็น" ถ้าใช้คอลเลกชันเดียวกัน วันหนึ่งจะมีคนเผลอเปิดราคาทุนขึ้นเว็บ
 */

/** รูปหนึ่งรูป — เก็บ publicId ไว้เสมอ ไม่งั้นลบรูปออกจาก Cloudinary ไม่ได้ (รูปกำพร้าค้างเสียเงินค่าพื้นที่) */
const imageSchema = new mongoose.Schema(
  {
    url: { type: String, required: true, maxlength: 600 },
    publicId: { type: String, default: "", maxlength: 300 },
    width: { type: Number, default: 0 },
    height: { type: Number, default: 0 },
    /** ⚠️ ข้อความแทนรูป — มีผลกับ SEO ของรูป และโปรแกรมอ่านหน้าจอ ว่างได้แต่ควรกรอก */
    alt: { type: String, default: "", maxlength: 200 },
  },
  { _id: false }
);

/** ไฟล์เอกสาร (เช่น Datasheet PDF) */
const fileSchema = new mongoose.Schema(
  {
    url: { type: String, default: "", maxlength: 600 },
    publicId: { type: String, default: "", maxlength: 300 },
    name: { type: String, default: "", maxlength: 200 },
    bytes: { type: Number, default: 0 },
  },
  { _id: false }
);

/**
 * สถานะการเผยแพร่
 * ⚠️ "draft" = เห็นเฉพาะในระบบหลังบ้าน ไม่ขึ้นเว็บ — ใช้เตรียมเนื้อหาให้เสร็จก่อนเปิด
 */
const STATUS = ["published", "draft"];

/** ใครแก้ล่าสุด — ตอบคำถาม "ใครเปลี่ยนสเปกสินค้าตัวนี้" ได้เสมอ */
const editorSchema = new mongoose.Schema(
  { userId: { type: String, default: "" }, name: { type: String, default: "" } },
  { _id: false }
);

/**
 * slug สำหรับ URL — ตัวพิมพ์เล็ก a-z 0-9 และขีด เท่านั้น
 * ⚠️ URL ภาษาไทยจะถูกแปลงเป็น %E0%B8... ตอนแชร์ ยาวและดูไม่น่าเชื่อถือ จึงบังคับเป็นอังกฤษ
 */
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

module.exports = { imageSchema, fileSchema, editorSchema, STATUS, SLUG_RE };
