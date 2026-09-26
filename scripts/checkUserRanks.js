/**
 * checkUserRanks.js — "หมอตรวจสิทธิ์" รายบุคคล (รันด้วย `npm run check:users`)
 *
 * ✅ ทำไมต้องมี: เวลาผู้ใช้แจ้งว่า "ตั้ง Super Admin แล้วแต่เมนูไม่ขึ้น" เดิมต้องไล่เดาทีละชั้น
 * (ฟิลด์ในฐานข้อมูล → ตารางสิทธิ์ → payload ใน token → เมนูบนหน้าจอ) สคริปต์นี้ตอบให้ในคำสั่งเดียว
 * ว่าแต่ละบัญชี "ระบบมองว่าเป็นใคร" และ "ได้สิทธิ์อะไรบ้าง" พร้อมชี้จุดที่ข้อมูลไม่สมบูรณ์
 *
 * ── วิธีใช้ ──────────────────────────────────────────────────────────────
 *   npm run check:users          ตรวจอย่างเดียว (ไม่แตะข้อมูล)
 *   npm run check:users -- --fix เติม rank ให้บัญชีที่ยังไม่มี (ถามก่อนไม่ได้ ตรวจผลก่อนรันเสมอ)
 *
 * ⚠️ --fix แก้ข้อมูลจริงในฐานข้อมูลที่ MONGO_URI ชี้อยู่ — ดูผลตรวจให้ครบก่อนค่อยรัน
 * ⚠️ ระบบมีสองคำที่ห้ามสับสน (ดู src/config/roles.js):
 *      role  ในฐานข้อมูล = "ชั้นในระบบ" (superadmin / admin / member) ในรูปแบบใหม่
 *      rank  ในฐานข้อมูล = "ตำแหน่งในองค์กร" (ผู้จัดการแผนกช่าง / ช่างเทคนิค / เซล ...)
 *    ข้อมูลเก่าเก็บตำแหน่งในองค์กรไว้ที่ role และไม่มี rank — สคริปต์นี้จึงตรวจทั้งสองแบบ
 */
require("dotenv").config();
const mongoose = require("../src/db");
const User = require("../src/models/User");
const {
  can, normalizeRank, systemRoleOf, rankLabelOf, SYSTEM_ROLE_LABEL, LEGACY_RANK_ALIAS,
  ALL_ROLES, ALL_SYSTEM_ROLES, CAPABILITIES,
} = require("../src/config/roles");

const FIX = process.argv.includes("--fix");
const CAPS = Object.keys(CAPABILITIES);

/** ตำแหน่งในองค์กรที่ควรได้ ถ้าจะเติมให้บัญชีที่ยังไม่มี — เดาจากค่าเก่าที่ยังพอเชื่อได้ */
const guessRank = (u) => {
  const raw = String(u.rank || "").trim().toLowerCase();
  if (LEGACY_RANK_ALIAS[raw]) return LEGACY_RANK_ALIAS[raw];   // ช่อง rank เป็นชื่อคีย์เดิม → แปลงตรงๆ
  /**
   * ⚠️ ห้ามเดาตำแหน่งจากช่อง role เมื่อ role เป็น "ชั้นในระบบ" (member/admin/superadmin) —
   * รูปแบบใหม่ช่องนั้นไม่ใช่ตำแหน่งในองค์กรอีกแล้ว เดาไปก็ได้ตำแหน่งมั่วที่ให้สิทธิ์ผิดคน
   * ✅ กรณีแบบนี้ต้องให้คนเลือกเองจากหน้าพนักงาน — ข้อมูลที่หายไปแล้วไม่มีใครกู้คืนได้จากค่าที่เหลือ
   */
  const role = String(u.role || "").trim().toLowerCase();
  if (ALL_SYSTEM_ROLES.includes(role)) return null;
  const viaRole = LEGACY_RANK_ALIAS[role] || role;
  return ALL_ROLES.includes(viaRole) ? viaRole : null;
};

const rawRank = (u) => String(u.rank || "").trim().toLowerCase();

/**
 * ค่าในช่อง rank เป็นอะไร — แยกสามกรณีให้ขาด ไม่งั้นวินิจฉัยผิด
 *   ok      ใช้ได้ตามคีย์ปัจจุบัน
 *   legacy  ชื่อคีย์เดิมที่ระบบยังอ่านออก (LEGACY_RANK_ALIAS) — ควรเก็บกวาดแต่ไม่ได้พัง
 *   junk    ค่าที่ไม่ใช่ตำแหน่งเลย (เช่นเผลอเขียนชั้นในระบบลงไป) — อันตราย ต้องแก้
 *   empty   ยังไม่เคยตั้ง
 */
const rankState = (u) => {
  const raw = rawRank(u);
  if (!raw) return "empty";
  if (ALL_ROLES.includes(raw)) return "ok";
  if (LEGACY_RANK_ALIAS[raw]) return "legacy";
  return "junk";
};

(async () => {
  await new Promise((r) => (mongoose.connection.readyState === 1 ? r() : mongoose.connection.once("open", r)));
  const users = await User.find({}).select("username fname lname role rank systemRole jobTitle").lean();

  const problems = [];
  console.log(`\n👥 ผู้ใช้ทั้งหมด ${users.length} คน\n`);
  console.log(
    "ชื่อ".padEnd(16) + "role (ในฐานข้อมูล)".padEnd(20) + "rank (ในฐานข้อมูล)".padEnd(20) +
    "→ ชั้นในระบบ".padEnd(16) + "→ ตำแหน่งในองค์กร".padEnd(22) + "สิทธิ์ที่ได้"
  );
  console.log("─".repeat(116));

  for (const u of users) {
    const rank = normalizeRank(u);
    const sys = systemRoleOf(u);
    const granted = CAPS.filter((c) => can(u, c)).length;
    const name = String(u.fname || u.username || "-").slice(0, 15);
    const rankOk = ALL_ROLES.includes(rank);
    const mark = rankOk ? "" : "  ⚠️";
    console.log(
      name.padEnd(16) +
      String(u.role ?? "-").padEnd(20) +
      String(u.rank ?? "-").padEnd(20) +
      `${SYSTEM_ROLE_LABEL[sys] || sys}`.padEnd(16) +
      `${rankOk ? rankLabelOf(rank) : "(ไม่ทราบ)"}`.padEnd(22) +
      `${granted}/${CAPS.length}${mark}`
    );

    const state = rankState(u);
    if (state === "junk") {
      problems.push({
        user: u,
        why: `ช่อง rank มีค่าที่ไม่ใช่ตำแหน่งในองค์กร ("${u.rank}") — น่าจะเผลอเขียนชั้นในระบบทับลงไป`,
        guess: guessRank(u),
      });
    } else if (!rankOk) {
      problems.push({
        user: u,
        why: `ไม่มีตำแหน่งในองค์กรที่ถูกต้อง (role="${u.role ?? "-"}" rank="${u.rank ?? "-"}")`,
        guess: guessRank(u),
      });
    } else if (state === "legacy") {
      problems.push({
        user: u,
        why: `ยังเก็บชื่อคีย์เดิมไว้ (rank="${u.rank}") — ระบบอ่านออกอยู่แล้ว แต่ควรเปลี่ยนเป็น "${rank}"`,
        guess: rank,
      });
    } else if (u.role && !ALL_SYSTEM_ROLES.includes(String(u.role).toLowerCase()) && !ALL_ROLES.includes(String(u.role).toLowerCase())) {
      problems.push({ user: u, why: `ค่า role="${u.role}" ไม่ใช่ทั้งชั้นในระบบและตำแหน่งในองค์กร`, guess: null });
    }
  }

  if (!problems.length) {
    console.log("\n✅ ข้อมูลสิทธิ์ของทุกบัญชีสมบูรณ์ — ไม่มีอะไรต้องแก้\n");
  } else {
    console.log(`\n⚠️  พบ ${problems.length} บัญชีที่ข้อมูลไม่สมบูรณ์ (สิทธิ์งานจะถูกปฏิเสธทั้งหมดโดยไม่มี error ให้เห็น):\n`);
    for (const p of problems) {
      console.log(`  • ${p.user.fname || p.user.username}: ${p.why}`);
      console.log(`    ${p.guess ? `เติมให้เป็น "${rankLabelOf(p.guess)}" ได้` : "เดาไม่ได้ ต้องเลือกตำแหน่งเองจากหน้าพนักงาน"}`);
    }
    if (FIX) {
      let fixed = 0;
      for (const p of problems.filter((x) => x.guess)) {
        await User.updateOne({ _id: p.user._id }, { $set: { rank: p.guess } });
        fixed += 1;
        console.log(`  ✓ เติม rank="${p.guess}" ให้ ${p.user.fname || p.user.username} แล้ว`);
      }
      console.log(`\n🔧 แก้ไขแล้ว ${fixed} บัญชี — รันซ้ำอีกครั้งเพื่อยืนยัน\n`);
    } else {
      console.log("\n   รัน `npm run check:users -- --fix` เพื่อเติมให้อัตโนมัติ (เฉพาะรายการที่เดาได้)\n");
    }
  }

  await mongoose.disconnect();
  process.exit(problems.length && !FIX ? 1 : 0);
})();
