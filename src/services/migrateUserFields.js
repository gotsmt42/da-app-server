/**
 * ย้ายชื่อฟิลด์ของผู้ใช้ให้ตรงกับคำที่ใช้ทั้งระบบ — ✅ ผู้ใช้สั่ง: "ทำรายการให้ตรง และตามชื่อจริงๆด้วย"
 *
 *   เดิม                                  →  ใหม่
 *   role      = ตำแหน่งในองค์กร (manager)  →  rank     = ตำแหน่งในองค์กร
 *   systemRole= ตำแหน่งในระบบ (superadmin) →  role     = ตำแหน่งในระบบ
 *   rank      = ข้อความตำแหน่งที่พิมพ์เอง  →  jobTitle = ตำแหน่งเฉพาะบุคคล
 *
 * ⚠️ ทำงานอัตโนมัติตอนเซิร์ฟเวอร์เริ่ม และ "รันซ้ำกี่รอบก็ได้" (idempotent) — แตะเฉพาะเอกสารที่ยังเป็นรูปแบบเก่า
 * ⚠️ ไม่ลบข้อมูลทิ้ง: ถ้าเดาไม่ได้จริงๆ จะข้ามเอกสารนั้นและเขียน log ไว้ ไม่เดาสุ่มให้สิทธิ์ใคร
 * ⚠️ โค้ดที่เหลืออ่านได้ทั้งสองรูปแบบอยู่แล้ว (normalizeRole/systemRoleOf ใน config/roles.js)
 *    การย้ายนี้จึงเป็นเรื่อง "ให้คนเปิดฐานข้อมูลอ่านรู้เรื่อง" ไม่ใช่เงื่อนไขให้ระบบทำงาน
 */
const User = require("../models/User");
const { ALL_ROLES, ALL_SYSTEM_ROLES, DEFAULT_SYSTEM_ROLE, ROLES, LEGACY_RANK_ALIAS } = require("../config/roles");

const lower = (v) => String(v || "").trim().toLowerCase();
/**
 * ตำแหน่งในองค์กรที่ค่านี้หมายถึง — รองรับ "ชื่อคีย์เดิม" ด้วย
 * ⚠️ จำเป็นหลังเปลี่ยนคีย์ admin → techadmin: ถ้าไม่แปลงให้ เอกสารเก่าที่ยังเป็น "admin" จะกลายเป็น
 * "ไม่รู้ตำแหน่ง" แล้วโดนข้ามทั้งหมด (ระบบยังอ่านออกอยู่ แต่ข้อมูลในฐานข้อมูลจะไม่ถูกเก็บกวาดสักที)
 */
const asRank = (v) => {
  const r = lower(v);
  if (ALL_ROLES.includes(r)) return r;
  return LEGACY_RANK_ALIAS[r] || "";
};

/** เอกสารนี้เป็นรูปแบบใหม่แล้วหรือยัง — ดูที่ rank ว่าเป็นคีย์ตำแหน่งในองค์กรจริง */
const isNewShape = (u) => ALL_ROLES.includes(lower(u.rank)) && ALL_SYSTEM_ROLES.includes(lower(u.role));

/** คำนวณค่าใหม่ของผู้ใช้หนึ่งคน (แยกออกมาเพื่อทดสอบได้) */
function nextShape(u) {
  const rawRank = lower(u.rank);
  const rawRole = lower(u.role);

  // ตำแหน่งในองค์กร: ของใหม่อยู่ที่ rank, ของเก่าอยู่ที่ role
  const rank = asRank(rawRank) || asRank(rawRole);
  if (!rank) return null; // ไม่รู้ว่าเป็นตำแหน่งอะไร — ข้ามไว้ ให้คนมาดูเอง ดีกว่าเดา

  // ตำแหน่งในระบบ: ถ้า role เป็นค่าระบบ "และ" ไม่ได้ถูกใช้เป็นตำแหน่งองค์กรอยู่ ให้ถือว่าเป็นของใหม่แล้ว
  const legacySystem = lower(u.systemRole);
  let role;
  if (asRank(rawRank) && ALL_SYSTEM_ROLES.includes(rawRole)) role = rawRole;
  else if (ALL_SYSTEM_ROLES.includes(legacySystem)) role = legacySystem;
  else role = DEFAULT_SYSTEM_ROLE[rank] || "member";

  // ตำแหน่งเฉพาะบุคคล: ข้อความเดิมใน rank ที่ไม่ใช่คีย์ตำแหน่ง
  const legacyTitle = asRank(rawRank) ? "" : String(u.rank || "").trim();
  const jobTitle = String(u.jobTitle || "").trim() || legacyTitle;

  return { rank, role, jobTitle };
}

async function migrateUserFields({ log = true } = {}) {
  const users = await User.find({}).select("username rank role systemRole jobTitle").lean();
  const pending = users.filter((u) => !isNewShape(u) || u.systemRole);
  if (!pending.length) return { moved: 0, skipped: 0, total: users.length };

  const ops = [];
  const skipped = [];
  for (const u of pending) {
    const next = nextShape(u);
    if (!next) { skipped.push(u.username); continue; }
    ops.push({
      updateOne: {
        filter: { _id: u._id },
        update: { $set: next, $unset: { systemRole: "" } },
      },
    });
  }
  if (ops.length) await User.bulkWrite(ops, { ordered: false });

  if (log) {
    console.log(`✅ ย้ายชื่อฟิลด์ผู้ใช้เป็น rank/role/jobTitle แล้ว ${ops.length} คน (ทั้งหมด ${users.length})`);
    if (skipped.length) console.warn(`⚠️  ข้าม ${skipped.length} คนเพราะไม่รู้ตำแหน่งในองค์กร: ${skipped.join(", ")}`);
  }
  return { moved: ops.length, skipped: skipped.length, total: users.length };
}

module.exports = { migrateUserFields, nextShape, isNewShape, ROLES };
