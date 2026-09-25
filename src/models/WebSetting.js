const mongoose = require("../db");
const { editorSchema, imageSchema, SLUG_RE } = require("./webShared");

/**
 * การแสดงผลของเว็บไซต์บริษัท — มีเอกสารเดียว (key = "web")
 *
 * ⚠️ ข้อมูลติดต่อ (เบอร์/อีเมล/LINE/Facebook) ไม่ได้อยู่ที่นี่ — ใช้ของ OrgSetting ที่ Super Admin
 *    ตั้งไว้อยู่แล้ว (routes/settings.js) เว็บกับแอปจึงใช้เบอร์ชุดเดียวกันเสมอ ไม่มีทางไม่ตรงกัน
 * ⚠️ ทุกช่องมีค่าตั้งต้น — เอกสารยังไม่เคยถูกสร้าง หน้าเว็บก็ต้องแสดงผลได้ครบ (ดู current())
 */
const statSchema = new mongoose.Schema(
  {
    value: { type: Number, required: true, min: 0, max: 1e7 },
    suffix: { type: String, default: "", maxlength: 8 },
    label: { type: String, required: true, maxlength: 60 },
    note: { type: String, default: "", maxlength: 120 },
  },
  { _id: false }
);

/**
 * รูปของแต่ละบริการ (หน้าแรก · หน้าบริการ) — ✅ บริษัทสั่ง "พวกระบบ อยากให้มีรูปภาพด้วย" (25 ก.ย. 2569)
 * ⚠️ ไม่ตั้ง = เว็บใช้ภาพประกอบที่ติดมากับเว็บ (public/services/<slug>.svg) — อัปภาพถ่ายงานจริงทับได้ทีละบริการ
 * ⚠️ slug ต้องตรงกับบริการบนเว็บ (fire-alarm, fire-protection, ...) — slug ที่ไม่มีบนเว็บจะถูกเว็บมองข้ามเฉยๆ
 */
const serviceImageSchema = new mongoose.Schema(
  {
    slug: { type: String, required: true, maxlength: 60, match: SLUG_RE },
    image: { type: imageSchema, required: true },
  },
  { _id: false }
);

const DEFAULTS = {
  // ✅ บริษัทยืนยัน: ประสบการณ์ทีมวิศวกรกว่า 10 ปี · ⚠️ อีกสามตัวเลขยังเป็นค่าประมาณ ต้องยืนยันก่อนเปิดเว็บ
  stats: [
    { value: 10, suffix: "+", label: "ปีประสบการณ์", note: "ทีมวิศวกรผู้เชี่ยวชาญกำกับดูแลทุกโครงการ" },
    { value: 500, suffix: "+", label: "โครงการที่ส่งมอบแล้ว", note: "งานติดตั้งระบบใหม่และงานปรับปรุงระบบเดิม" },
    { value: 300, suffix: "+", label: "ลูกค้าองค์กร", note: "ภาคอุตสาหกรรม ภาครัฐ และอาคารพาณิชย์" },
    { value: 24, suffix: "/7", label: "บริการงานฉุกเฉิน", note: "สำหรับลูกค้าสัญญาบำรุงรักษา" },
  ],
  showStats: true,
  showProjects: true,
  showBrands: true,
  showArticles: true,
  businessHoursWeekdays: "จันทร์ – ศุกร์ 08:30 – 17:30 น.",
  businessHoursSaturday: "เสาร์ (นัดหมายล่วงหน้า)",
  businessHoursClosed: "อาทิตย์และวันหยุดนักขัตฤกษ์",
  emergencyNote: "งานฉุกเฉินของระบบแจ้งเหตุเพลิงไหม้และระบบความปลอดภัย ติดต่อได้นอกเวลาทำการ",
  serviceAreas: ["กรุงเทพมหานคร", "นนทบุรี", "ปทุมธานี", "สมุทรปราการ", "นครปฐม", "สมุทรสาคร", "อยุธยา", "ชลบุรี"],
  /** ประกาศสั้นๆ แถบบนสุดของเว็บ (เช่น วันหยุดยาว) — ว่าง = ไม่แสดง */
  announcement: "",
};

const webSettingSchema = new mongoose.Schema(
  {
    key: { type: String, default: "web", unique: true },
    stats: { type: [statSchema], default: DEFAULTS.stats, validate: [(v) => v.length <= 6, "ตัวเลขได้ไม่เกิน 6 ช่อง"] },
    showStats: { type: Boolean, default: DEFAULTS.showStats },
    showProjects: { type: Boolean, default: DEFAULTS.showProjects },
    showBrands: { type: Boolean, default: DEFAULTS.showBrands },
    showArticles: { type: Boolean, default: DEFAULTS.showArticles },
    businessHoursWeekdays: { type: String, default: DEFAULTS.businessHoursWeekdays, maxlength: 80 },
    businessHoursSaturday: { type: String, default: DEFAULTS.businessHoursSaturday, maxlength: 80 },
    businessHoursClosed: { type: String, default: DEFAULTS.businessHoursClosed, maxlength: 80 },
    emergencyNote: { type: String, default: DEFAULTS.emergencyNote, maxlength: 200 },
    serviceAreas: { type: [{ type: String, maxlength: 60 }], default: DEFAULTS.serviceAreas },
    announcement: { type: String, default: "", maxlength: 200 },
    /**
     * ✅ ช่องทางติดต่อ "ของเว็บไซต์บริษัท" — แยกจากตั้งค่าองค์กรของแอปหลังบ้านโดยสิ้นเชิง
     *    (ผู้ใช้สั่ง 25 ก.ย. 2569: "ย้ายออกไปในส่วนของตั้งค่าเว็บไซต์ต่างหากเลย ไม่ต้องรวมกับในแอปหลังบ้าน")
     * ⚠️ แก้ที่นี่ = เปลี่ยนเฉพาะเว็บบริษัท · เบอร์/อีเมลบนเอกสาร PDF และเมนูติดต่อในแอป ยังใช้ตั้งค่าองค์กรเหมือนเดิม
     * ⚠️ ว่าง = ไม่แสดงช่องทางนั้นบนเว็บ
     */
    contactHotline: { type: String, default: "", maxlength: 60 },
    contactTel: { type: String, default: "", maxlength: 60 },
    contactEmail: { type: String, default: "", maxlength: 120 },
    contactLine: { type: String, default: "", maxlength: 300 },
    contactFacebook: { type: String, default: "", maxlength: 300 },
    serviceImages: { type: [serviceImageSchema], default: [], validate: [(v) => v.length <= 20, "รูปบริการได้ไม่เกิน 20 รูป"] },
    updatedBy: { type: editorSchema, default: () => ({}) },
  },
  { timestamps: true }
);

/** เอกสารปัจจุบัน — ยังไม่เคยสร้างก็คืนค่าตั้งต้น (ไม่สร้างเอกสารตอนอ่าน) */
webSettingSchema.statics.current = async function current() {
  const doc = await this.findOne({ key: "web" }).lean();
  return { ...DEFAULTS, ...(doc || {}) };
};
webSettingSchema.statics.DEFAULTS = DEFAULTS;

module.exports = mongoose.model("WebSetting", webSettingSchema);
