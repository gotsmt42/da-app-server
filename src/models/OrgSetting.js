/**
 * ตั้งค่าองค์กร — เอกสารเดียวของทั้งระบบ (singleton, key = "org")
 *
 * ✅ ผู้ใช้สั่ง: "หน้าการตั้งค่า อยากให้ปรับเปลี่ยนได้เอง เช่น Logo แอพ / การแสดงผลต่างๆ"
 * เดิมชื่อบริษัท ที่อยู่ เลขผู้เสียภาษี และโลโก้ ถูกฝังไว้ในโค้ด (da-app/src/features/documents/utils/deliveryNotePdf.js
 * และไฟล์ใน public/) — จะเปลี่ยนทีต้องแก้โค้ดแล้ว deploy ใหม่ทุกครั้ง
 *
 * ⚠️ ค่าที่นี่ไปโผล่ "หัวกระดาษของเอกสารทุกใบที่ออกจากระบบ" — ถือเป็นข้อมูลทางการของบริษัท
 * จึงให้แก้ได้เฉพาะผู้มีสิทธิ์ manageAll และบันทึกไว้เสมอว่าใครแก้ล่าสุด
 * ⚠️ ผู้ใช้ทุกคน "อ่าน" ได้ (ต้องใช้วาดหัวเว็บ/หัวกระดาษ) แต่ไม่มีข้อมูลลับอยู่ในนี้
 */
const mongoose = require("mongoose");

/**
 * ค่าตั้งต้นขององค์กร — ✅ ผู้ใช้สั่ง: "ทำให้ระบบนี้ไปรันและใช้กับองค์กรอื่นๆ ได้ด้วย"
 * อ่านจาก environment ก่อน — บริษัทใหม่ที่ติดตั้งระบบจึงขึ้นมาเป็น "ตัวเอง" ตั้งแต่วันแรก
 * โดยไม่ต้องแก้โค้ด (ดู .env.example) · ไม่ตั้งก็กรอกทีหลังที่หน้า "ตั้งค่าองค์กร" ได้
 * ⚠️ มีผลเฉพาะตอนสร้างเอกสารครั้งแรก — องค์กรที่ตั้งค่าไปแล้ว ค่าในฐานข้อมูลชนะเสมอ
 */
const env = (key, fallback = "") => String(process.env[key] || "").trim() || fallback;

const DEFAULTS = {
  nameTh: env("ORG_NAME_TH", "องค์กรของคุณ"),
  nameEn: env("ORG_NAME_EN", "YOUR ORGANIZATION"),
  address: env("ORG_ADDRESS", ""),
  taxId: env("ORG_TAX_ID", ""),
  tel: env("ORG_TEL", ""),
  email: env("ORG_EMAIL", ""),
  website: env("ORG_WEBSITE", ""),
  // ว่าง = ใช้ไฟล์ที่ติดมากับแอป (public/logo-dark-2.png ฯลฯ) — ดู shared/services/OrgSettingService.js
  logoUrl: "",
  letterheadUrl: "",
  stampUrl: "",
  advanceClearDays: 7,
};

const orgSettingSchema = new mongoose.Schema(
  {
    key: { type: String, default: "org", unique: true, index: true },
    nameTh: { type: String, default: DEFAULTS.nameTh },
    nameEn: { type: String, default: DEFAULTS.nameEn },
    address: { type: String, default: DEFAULTS.address },
    taxId: { type: String, default: DEFAULTS.taxId },
    tel: { type: String, default: "" },
    email: { type: String, default: "" },
    website: { type: String, default: "" },
    /**
     * ช่องทางติดต่อแบบแชต/โซเชียล ที่ไปโผล่เป็นเมนู "ติดต่อ" บนหัวเว็บ
     * ⚠️ เบอร์โทร/อีเมล/เว็บไซต์ ไม่ได้ซ้ำไว้ตรงนี้ — ใช้ tel/email/website ด้านบนร่วมกัน
     *    (เป็นข้อมูลชุดเดียวกันของบริษัท ถ้าแยกเก็บสองที่จะมีวันที่สองที่ไม่ตรงกัน)
     * ⚠️ ว่าง = ไม่แสดงช่องทางนั้น · ไม่มีช่องทางไหนเลย = ไม่มีปุ่ม "ติดต่อ" บนหัวเว็บ
     */
    contactLine: { type: String, default: "" },
    contactFacebook: { type: String, default: "" },
    /** โลโก้บนหัวเว็บ/หน้าเข้าสู่ระบบ */
    logoUrl: { type: String, default: "" },
    /** โลโก้หัวกระดาษ — ควรเป็นไฟล์ที่ตัดขอบว่างออกแล้ว ไม่งั้นหัวกระดาษจะมีช่องว่างเกิน */
    letterheadUrl: { type: String, default: "" },
    /** ตราประทับบริษัทบนเอกสาร */
    stampUrl: { type: String, default: "" },
    /**
     * กำหนดวันเคลียร์ใบ Advance หลังจ่ายเงิน (วัน)
     * ⚠️ ใช้ตอนบันทึกจ่ายเงินเมื่อผู้อนุมัติเบิกจ่ายไม่ได้ระบุวันเอง และใช้ยิงเตือนรายวัน
     */
    advanceClearDays: { type: Number, default: DEFAULTS.advanceClearDays, min: 1, max: 90 },
    /**
     * ส่วนต่างของตารางสิทธิ์ที่ผู้ดูแลปรับเอง { role: { capability: true|false } }
     * ✅ ผู้ใช้สั่ง: "ตั้งค่ากำหนดสิทธิ์ได้ว่าใครมองเห็นเมนูอะไร จัดการอะไรได้บ้าง"
     * ⚠️ เก็บเฉพาะ "ส่วนต่าง" ไม่ใช่ทั้งตาราง — เพิ่มสิทธิ์ใหม่ในโค้ดวันหลังจะได้ค่าเริ่มต้นอัตโนมัติ
     * ⚠️ ตัวตัดสินจริงอยู่ที่ can() ใน config/roles.js ซึ่งอ่านค่าชุดนี้จากหน่วยความจำ (services/permissionOverrides.js)
     */
    capabilityOverrides: { type: mongoose.Schema.Types.Mixed, default: {} },
    /**
     * ชื่อ Rank (ตำแหน่งในองค์กร) ที่ตั้งเอง { rank: "ชื่อที่อยากให้แสดง" } — ✅ ผู้ใช้ขอให้เปลี่ยนชื่อได้
     * ⚠️ เปลี่ยนแค่ชื่อที่แสดง คีย์ของ Rank คงเดิมเสมอ (ผู้ใช้ทุกคนและตารางสิทธิ์อ้างคีย์นี้อยู่)
     * ⚠️ Role (Super Admin/Admin/Member) ไม่อยู่ที่นี่ — เป็นศัพท์ของระบบ เปลี่ยนชื่อไม่ได้
     */
    rankLabels: { type: mongoose.Schema.Types.Mixed, default: {} },
    updatedBy: { userId: { type: String, default: "" }, name: { type: String, default: "" } },
  },
  { timestamps: true, collection: "orgsettings" }
);

/**
 * ค่าปัจจุบัน (สร้างเอกสารเริ่มต้นให้อัตโนมัติถ้ายังไม่มี)
 * ⚠️ แคชสั้นๆ — ถูกอ่านทุกครั้งที่บันทึกจ่ายเงิน/ยิงเตือน ไม่ควรวิ่ง query ทุกรอบ
 */
let cache = { at: 0, data: null };
const CACHE_MS = 30_000;

orgSettingSchema.statics.current = async function current({ fresh = false } = {}) {
  if (!fresh && cache.data && Date.now() - cache.at < CACHE_MS) return cache.data;
  const doc = await this.findOneAndUpdate(
    { key: "org" },
    { $setOnInsert: { key: "org" } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  ).lean();
  cache = { at: Date.now(), data: doc };
  return doc;
};

/** เรียกหลังบันทึกทุกครั้ง — ไม่งั้นค่าที่เพิ่งแก้จะยังไม่มีผลจนกว่าแคชจะหมดอายุ */
orgSettingSchema.statics.clearCache = function clearCache() {
  cache = { at: 0, data: null };
};

orgSettingSchema.statics.DEFAULTS = DEFAULTS;

module.exports = mongoose.model("OrgSetting", orgSettingSchema);
