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

const DEFAULTS = {
  nameTh: "บริษัท ดู ออล อาคิเทค แอนด์ เอ็นจิเนียริ่ง จำกัด",
  nameEn: "DO ALL ARCHITECT AND ENGINEERING CO.,LTD.",
  address: "สำนักงานใหญ่ : 68/155 หมู่ 3 ถนนชัยพฤกษ์ ตำบลคลองพระอุดม อำเภอปากเกร็ด จังหวัดนนทบุรี 11120",
  taxId: "เลขประจำตัวผู้เสียภาษี 0125563014222",
  tel: "",
  email: "",
  website: "",
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
