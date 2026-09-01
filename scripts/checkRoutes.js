/**
 * ตรวจตาราง route ของ Express — รันได้โดยไม่ต้องมีฐานข้อมูลจริง จึงใช้ใน CI ได้
 *
 *   npm run check:routes
 *
 * ตรวจ 2 อย่าง:
 *   1. จำนวน route ครบตามที่คาดไว้ไหม (จับกรณี router หลุดไม่ได้ mount)
 *   2. มี route ไหน "ถูกกลืน" จนเรียกไม่ถึงหรือเปล่า
 *
 * 🐛 ทำไมต้องมี: Express จับคู่ route ตามลำดับที่ประกาศ ตัวแรกที่ match ชนะ ถ้าตัวที่ประกาศก่อน
 * มีรูปแบบครอบคลุม path ของตัวที่ประกาศทีหลัง ตัวหลังจะ "ไม่มีวันถูกเรียก และไม่มี error ให้เห็น"
 * เช่น ถ้า GET /:id ขึ้นก่อน GET /event-op ระบบจะไปหางาน id ชื่อ "event-op" แทน แล้วตอบ 404 เฉยๆ
 * เป็นบั๊กที่ทั้ง `node --check` และ ESLint จับไม่ได้เลย จึงต้องมีตัวตรวจของมันเอง
 */
require("dotenv").config();

// ✅ web-push ต้องการ VAPID ตั้งแต่ตอนโหลดโมดูล — ใน CI ไม่มีค่าจริง ให้สร้างคีย์ทิ้งขึ้นมาใช้ชั่วคราว
// (ไม่ได้ส่งแจ้งเตือนอะไรจริง แค่ให้โมดูลโหลดผ่าน)
if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
  const keys = require("web-push").generateVAPIDKeys();
  process.env.VAPID_PUBLIC_KEY = keys.publicKey;
  process.env.VAPID_PRIVATE_KEY = keys.privateKey;
}
if (!process.env.VAPID_SUBJECT) process.env.VAPID_SUBJECT = "mailto:ci@example.com";
// mongoose ต่อ DB แบบ async จึงไม่บล็อกการ require — ใส่ค่าหลอกไว้กันโค้ดที่อ่าน env ตอนโหลด
if (!process.env.APP_DATABASE) process.env.APP_DATABASE = "mongodb://127.0.0.1:27017/ci-placeholder";

const app = require("../src/app");

const EXPECTED_TOTAL = 90;
const EXPECTED_PER_PREFIX = {
  "/api/events": 31,
  // ✅ ฝ่ายขาย: ท่อขาย 10 + ปฏิทินนัดหมาย 5
  // ✅ ใบมอบหมายงานข้ามแผนก — แทน /api/workorder เดิมที่ไม่เคยถูกใช้จริงเลย (0 document)
  "/api/dispatch": 14,
  "/api/auth": 8,
  "/api/files": 7,
  "/api/customer": 5,
  "/api/product": 5,
  "/api/jobtype": 4,
  "/api/systemtype": 4,
  "/api/issued-documents": 3,
  "/api/push": 3,
  "/api/stockproduct": 3,
  "/api/doc-number": 2,
  "/api/holidays": 1,
};

const decode = (re) => {
  if (!re) return "";
  const m = re.toString().match(/^\/\^\\\/(.*?)\\\/\?\(\?=\\\/\|\$\)\/i?$/);
  return m ? "/" + m[1].replace(/\\\//g, "/") : "";
};

const routes = [];
(function walk(stack, prefix) {
  for (const layer of stack) {
    if (layer.route) {
      Object.keys(layer.route.methods)
        .filter((k) => layer.route.methods[k])
        .sort()
        .forEach((m) => routes.push({ method: m.toUpperCase(), path: prefix + layer.route.path }));
    } else if (layer.name === "router" && layer.handle && layer.handle.stack) {
      walk(layer.handle.stack, prefix + decode(layer.regexp));
    }
  }
})(app._router.stack, "");

const problems = [];

// ── 1) จำนวน route ────────────────────────────────────────────────────────
if (routes.length !== EXPECTED_TOTAL) {
  problems.push(`จำนวน route ทั้งหมด = ${routes.length} แต่คาดไว้ ${EXPECTED_TOTAL}` +
    " (ถ้าเพิ่ม/ลบ route โดยตั้งใจ ให้แก้ EXPECTED_TOTAL ในไฟล์นี้ด้วย)");
}
for (const [prefix, count] of Object.entries(EXPECTED_PER_PREFIX)) {
  const actual = routes.filter((r) => r.path.startsWith(prefix + "/") || r.path === prefix).length;
  if (actual !== count) problems.push(`${prefix} มี ${actual} route แต่คาดไว้ ${count}`);
}

// ── 2) route ที่ถูกกลืน ───────────────────────────────────────────────────
const segs = (p) => p.split("/").filter(Boolean);
const shadows = (a, b) => {
  const A = segs(a), B = segs(b);
  return A.length === B.length && A.every((s, i) => s.startsWith(":") || s === B[i]);
};
for (let j = 0; j < routes.length; j++) {
  for (let i = 0; i < j; i++) {
    if (routes[i].method !== routes[j].method || routes[i].path === routes[j].path) continue;
    if (shadows(routes[i].path, routes[j].path)) {
      problems.push(
        `${routes[j].method} ${routes[j].path} เรียกไม่ถึง — ถูกกลืนโดย ${routes[i].method} ${routes[i].path} ที่ประกาศก่อน`
      );
    }
  }
}

if (problems.length) {
  console.error("❌ ตรวจตาราง route ไม่ผ่าน:");
  problems.forEach((p) => console.error("   • " + p));
  process.exit(1);
}
console.log(`✅ ตาราง route ปกติ — ${routes.length} route, ทุกเส้นทางเรียกถึงได้จริง`);
process.exit(0);
