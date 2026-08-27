/**
 * ตรวจตารางสิทธิ์ (role × capability) — รันได้โดยไม่ต้องมีฐานข้อมูลจริง จึงใช้ใน CI ได้
 *
 *   npm run check:perms
 *
 * ตรวจ 4 อย่าง:
 *   1. ตารางสิทธิ์ตรงกับ snapshot ที่คาดไว้ไหม (จับการแก้สิทธิ์โดยไม่ตั้งใจ)
 *   2. ตารางฝั่ง server กับฝั่งหน้าจอ (da-app/src/shared/utils/roles.js) ตรงกันไหม
 *   3. มี role ที่อ้างถึงในตารางแต่ไม่มีอยู่ใน ROLES ไหม (พิมพ์ผิด)
 *   4. มีสิทธิ์ไหนที่ไม่มีใครทำได้เลยไหม (เขียนไว้แล้วลืมใส่ role = ฟีเจอร์ที่ตายตั้งแต่เกิด)
 *
 * 🐛 ทำไมต้องมี: การเช็คสิทธิ์เป็นโค้ดที่ "ผิดแล้วเงียบ" — ลืมใส่ role ลงลิสต์ ผู้ใช้กลุ่มนั้นจะเห็นแค่
 * เมนูหายไปเฉยๆ ไม่มี error ไม่มี log และ test ทั่วไปก็ไม่จับ เพราะโค้ดทำงานถูกต้องตามที่เขียนไว้ทุกอย่าง
 * (เหตุผลเดียวกับที่ต้องมี checkRoutes.js — บั๊กที่ lint กับ node --check มองไม่เห็น ต้องมีตัวตรวจของมันเอง)
 */
const fs = require("fs");
const path = require("path");
const { CAPABILITIES, ROLES, ALL_ROLES, ROLE_LABEL } = require("../src/config/roles");

/**
 * ── snapshot ที่คาดไว้ ────────────────────────────────────────────────────
 * ⚠️ ถ้าตั้งใจเปลี่ยนสิทธิ์จริงๆ ให้แก้ตรงนี้ "พร้อมกับ" src/config/roles.js และฝั่งหน้าจอ —
 * การที่ต้องแก้ 3 ที่คือความตั้งใจ ไม่ใช่ความซ้ำซ้อน: มันบังคับให้การเปลี่ยนสิทธิ์เป็นการตัดสินใจ
 * ที่มองเห็นได้ใน diff เสมอ ไม่ใช่ผลข้างเคียงของการแก้อย่างอื่น
 */
const EXPECTED = {
  manageAll: ["admin"],
  approveJobs: ["admin", "manager"],
  viewAllJobs: ["admin", "manager"],
  editAnyJob: ["admin", "manager"],
  editOperation: ["admin", "manager", "user"],
  // ⚠️ ตัด sale ออกตามที่ผู้ใช้สั่ง — ทั้งสองหน้าเป็นเรื่องของงานช่าง ไม่ใช่ดีล/ยอดขายของเซล
  viewQuotations: ["admin", "manager", "technician"],
  editDocuments: ["admin", "manager"],
  viewFinance: ["admin", "manager", "technician", "user"],
  editFinance: ["admin", "manager"],
  viewContracts: ["admin", "manager", "technician"],
  editContracts: ["admin", "manager"],
  manageMasterData: ["admin", "manager"],
  createSalesPlan: ["admin", "manager", "sale"],
  viewAllSales: ["admin", "manager"],
  requestDispatch: ["admin", "manager", "sale"],
  assignDispatch: ["admin", "manager"],
  receiveDispatch: ["technician"],
};

const FRONTEND_ROLES_FILE = path.resolve(
  __dirname,
  "..", "..", "da-app", "src", "shared", "utils", "roles.js"
);

const problems = [];
const sorted = (a) => [...a].sort();
const same = (a, b) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));

// ── 1) เทียบกับ snapshot ────────────────────────────────────────────────
const capsInCode = Object.keys(CAPABILITIES);
const capsExpected = Object.keys(EXPECTED);

capsExpected.filter((c) => !capsInCode.includes(c)).forEach((c) =>
  problems.push(`สิทธิ์ "${c}" อยู่ใน snapshot แต่หายไปจาก src/config/roles.js`)
);
capsInCode.filter((c) => !capsExpected.includes(c)).forEach((c) =>
  problems.push(`สิทธิ์ "${c}" ถูกเพิ่มใน src/config/roles.js แต่ยังไม่ได้ใส่ใน snapshot ของไฟล์นี้`)
);
capsInCode.filter((c) => capsExpected.includes(c)).forEach((c) => {
  if (!same(CAPABILITIES[c], EXPECTED[c])) {
    problems.push(
      `สิทธิ์ "${c}" ไม่ตรง snapshot\n      คาดไว้: ${sorted(EXPECTED[c]).join(", ")}\n      ในโค้ด: ${sorted(CAPABILITIES[c]).join(", ")}`
    );
  }
});

// ── 2) role ที่ไม่มีอยู่จริง / สิทธิ์ที่ไม่มีใครทำได้ ────────────────────
capsInCode.forEach((c) => {
  const roles = CAPABILITIES[c];
  if (!roles.length) {
    problems.push(`สิทธิ์ "${c}" ไม่มี role ไหนทำได้เลย — ฟีเจอร์นี้จะไม่มีใครใช้ได้`);
  }
  roles.filter((r) => !ALL_ROLES.includes(r)).forEach((r) =>
    problems.push(`สิทธิ์ "${c}" อ้างถึง role "${r}" ที่ไม่มีใน ROLES (พิมพ์ผิด?)`)
  );
});

// ── 3) เทียบกับตารางฝั่งหน้าจอ ──────────────────────────────────────────
// ⚠️ อ่านเป็นข้อความแล้ว parse แทนการ import — ไฟล์ฝั่งโน้นเป็น ES module และอยู่คนละ repo
// จึง require ตรงๆ ไม่ได้ (การอ่านข้อความจึงเป็นทางที่ทำได้จริงและไม่ต้องตั้ง build ให้ script ตรวจสอบ)
if (!fs.existsSync(FRONTEND_ROLES_FILE)) {
  console.log(`⚠️  ข้ามการเทียบกับฝั่งหน้าจอ — ไม่พบ ${FRONTEND_ROLES_FILE}`);
  console.log("   (ปกติเกิดตอนรันใน CI ที่ checkout มาแค่ repo เดียว ไม่ถือว่าผิด)");
} else {
  const src = fs.readFileSync(FRONTEND_ROLES_FILE, "utf8");
  const block = src.match(/export const CAPABILITIES = \{([\s\S]*?)\n\};/);
  if (!block) {
    problems.push("อ่านตาราง CAPABILITIES จากไฟล์ฝั่งหน้าจอไม่ได้ — รูปแบบไฟล์เปลี่ยนไปหรือเปล่า?");
  } else {
    const feCaps = {};
    block[1].split("\n").forEach((line) => {
      const m = line.match(/^\s*(\w+):\s*\[(.*?)\],?\s*$/);
      if (!m) return;
      feCaps[m[1]] = m[2]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        // ค่าฝั่งโน้นเขียนเป็น ROLES.ADMIN — แปลงกลับเป็นสตริงจริงเพื่อเทียบ
        .map((s) => (s.startsWith("ROLES.") ? ROLES[s.slice(6)] : s.replace(/["']/g, "")));
    });
    capsInCode.forEach((c) => {
      if (!feCaps[c]) return problems.push(`สิทธิ์ "${c}" มีฝั่ง server แต่ไม่มีฝั่งหน้าจอ`);
      if (!same(CAPABILITIES[c], feCaps[c])) {
        problems.push(
          `สิทธิ์ "${c}" สองฝั่งไม่ตรงกัน\n      server: ${sorted(CAPABILITIES[c]).join(", ")}\n      หน้าจอ: ${sorted(feCaps[c]).join(", ")}`
        );
      }
    });
    Object.keys(feCaps).filter((c) => !capsInCode.includes(c)).forEach((c) =>
      problems.push(`สิทธิ์ "${c}" มีฝั่งหน้าจอ แต่ไม่มีฝั่ง server`)
    );
  }
}

// ── รายงานผล ────────────────────────────────────────────────────────────
const pad = (s, n) => s + " ".repeat(Math.max(0, n - [...s].length));
const COL = 18;

console.log("\n📋 ตารางสิทธิ์ (role × capability)\n");
console.log("   " + pad("", 20) + ALL_ROLES.map((r) => pad(ROLE_LABEL[r], COL)).join(""));
capsInCode.forEach((c) => {
  const row = ALL_ROLES.map((r) => pad(CAPABILITIES[c].includes(r) ? "     ✓" : "     ·", COL)).join("");
  console.log("   " + pad(c, 20) + row);
});

console.log("");
if (problems.length) {
  console.error(`❌ พบปัญหา ${problems.length} จุด\n`);
  problems.forEach((p) => console.error("   • " + p));
  console.error("");
  process.exit(1);
}
console.log(`✅ ตารางสิทธิ์ปกติ — ${capsInCode.length} สิทธิ์ · ${ALL_ROLES.length} role · ตรงกันทั้งสองฝั่ง\n`);
