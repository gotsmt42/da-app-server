/**
 * permissionOverrides — เอาสิทธิ์ที่ผู้ดูแลปรับเองจากฐานข้อมูล มาใส่ให้ can() ใช้
 *
 * ✅ ผู้ใช้สั่ง: "ตั้งค่ากำหนดสิทธิ์ได้ด้วยว่าอยากให้ใครมองเห็นเมนูอะไร และจัดการอะไรได้บ้าง"
 *
 * ⚠️ can() ต้องเป็นฟังก์ชัน sync (ถูกเรียกหลายร้อยจุด ทั้งใน middleware และกลาง loop) — จึงเก็บตารางไว้ใน
 * หน่วยความจำของโปรเซส แล้วรีเฟรชเป็นระยะ ไม่ใช่ไป query ฐานข้อมูลทุกครั้งที่เช็คสิทธิ์
 * ⚠️ รีเฟรชทุก 60 วินาทีด้วย เผื่อวันหนึ่งรันหลายเครื่อง — เครื่องที่ไม่ได้รับคำสั่งบันทึกจะตามทันภายใน 1 นาที
 * ⚠️ โหลดไม่สำเร็จ = ใช้ตารางค่าเริ่มต้นในโค้ดต่อไป (ไม่ใช่เปิดสิทธิ์ทุกอย่าง) — ปลอดภัยไว้ก่อนเสมอ
 */
const OrgSetting = require("../models/OrgSetting");
const { setCapabilityOverrides, setRankLabels } = require("../config/roles");

const REFRESH_MS = 60_000;
let timer = null;

async function refreshPermissionOverrides() {
  try {
    const doc = await OrgSetting.findOne({ key: "org" }).select("capabilityOverrides rankLabels roleLabels").lean();
    // ✅ ชื่อ Rank ที่ตั้งเองต้องมาพร้อมกัน — ข้อความแจ้งเตือน/ข้อความตอบกลับใช้ชื่อนี้
    // ⚠️ roleLabels = ชื่อฟิลด์เก่าก่อนแยก Role/Rank — อ่านต่อไปเพื่อชื่อที่ตั้งไว้แล้วไม่หาย
    setRankLabels(doc?.rankLabels || doc?.roleLabels || {});
    return setCapabilityOverrides(doc?.capabilityOverrides || {});
  } catch (err) {
    console.error("❌ โหลดสิทธิ์ที่ปรับเองไม่สำเร็จ (ใช้ค่าเริ่มต้นต่อไป):", err.message);
    return null;
  }
}

function startPermissionOverrideRefresh() {
  refreshPermissionOverrides();
  if (timer) return;
  timer = setInterval(refreshPermissionOverrides, REFRESH_MS);
  timer.unref?.();
}

module.exports = { refreshPermissionOverrides, startPermissionOverrideRefresh };
