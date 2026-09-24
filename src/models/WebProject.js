const mongoose = require("../db");
const { imageSchema, editorSchema, STATUS, SLUG_RE } = require("./webShared");

/**
 * ผลงานที่แสดงบนเว็บไซต์บริษัท (หน้า /projects และ /projects/[slug])
 *
 * ⚠️ ชื่อลูกค้าต้องได้รับอนุญาตก่อนเผยแพร่เสมอ — ถ้ายังไม่ได้ ปล่อย customer ว่างไว้
 *    หน้าเว็บจะแสดง "ขอสงวนชื่อลูกค้า" ให้เอง
 * ⚠️ systems ต้องเป็น slug ของบริการจริงบนเว็บ (fire-alarm, cctv, ...) — ใช้ทั้งเป็นตัวกรองและลิงก์
 *    ข้ามไปหน้าบริการ ค่าที่ไม่รู้จักจะไม่มีลิงก์ และไม่ขึ้นในตัวกรอง
 * ⚠️ slug คือ URL ที่ Google เก็บไว้ — เปลี่ยนหลังเผยแพร่แล้ว = ลิงก์เดิมกลายเป็น 404
 */
// ⚠️ "engineering" (งานระบบอาคาร) ถูกแทนด้วย "fire-pump" ตามที่บริษัทสั่ง (24 ก.ย. 2569)
const SYSTEMS = ["fire-alarm", "fire-pump", "cctv", "access-control", "network", "maintenance"];

const webProjectSchema = new mongoose.Schema(
  {
    slug: {
      type: String, required: true, unique: true, trim: true, lowercase: true, maxlength: 120,
      match: [SLUG_RE, "slug ใช้ได้เฉพาะ a-z 0-9 และขีด (-) เช่น factory-cctv-2569"],
    },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    customer: { type: String, default: "", trim: true, maxlength: 200 },
    location: { type: String, required: true, trim: true, maxlength: 150 },
    systems: {
      type: [{ type: String, enum: SYSTEMS }],
      validate: [(v) => v.length > 0, "เลือกระบบอย่างน้อย 1 ระบบ"],
    },
    completedAt: { type: Date, required: true },
    summary: { type: String, required: true, trim: true, maxlength: 500 },
    scope: { type: [{ type: String, trim: true, maxlength: 300 }], default: [] },
    /** โจทย์ → วิธีแก้ → ผลลัพธ์: ส่วนที่ทำให้ผลงานน่าเชื่อถือกว่าการลงรูปอย่างเดียว */
    challenge: { type: String, default: "", trim: true, maxlength: 3000 },
    solution: { type: String, default: "", trim: true, maxlength: 3000 },
    result: { type: String, default: "", trim: true, maxlength: 3000 },
    images: { type: [imageSchema], default: [], validate: [(v) => v.length <= 24, "รูปได้ไม่เกิน 24 รูป"] },
    status: { type: String, enum: STATUS, default: "draft", index: true },
    /** ✅ แสดงในส่วน "ผลงานล่าสุด" บนหน้าแรก */
    featured: { type: Boolean, default: false },
    updatedBy: { type: editorSchema, default: () => ({}) },
  },
  { timestamps: true }
);

webProjectSchema.index({ status: 1, completedAt: -1 });
webProjectSchema.statics.SYSTEMS = SYSTEMS;

module.exports = mongoose.model("WebProject", webProjectSchema);
