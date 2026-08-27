import fs from "fs";
import path from "path";

function walk(d) {
  return fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith(".js") ? [path.join(d, e.name)] : []
  );
}

const files = walk("src/routes");
const noAuth = [];
const noAuthz = [];

for (const f of files) {
  const src = fs.readFileSync(f, "utf8");
  const re = /router\.(get|post|put|patch|delete)\(\s*[`'"]([^`'"]*)[`'"]/g;
  const marks = [];
  let m;
  while ((m = re.exec(src))) marks.push({ i: m.index, method: m[1].toUpperCase(), p: m[2] });

  marks.forEach((mk, idx) => {
    const end = idx + 1 < marks.length ? marks[idx + 1].i : src.length;
    const body = src.slice(mk.i, end);
    const line = src.slice(0, mk.i).split("\n").length;
    const label = `${f.split(path.sep).join("/")}:${line}  ${mk.method} ${mk.p}`;

    const hasToken = /verifyToken/.test(body);
    // สัญญาณว่ามีการจำกัดขอบเขต: เช็คสิทธิ์ หรือผูกกับตัวผู้ใช้เอง
    const hasAuthz = /can\(\s*req\.user|requireCap|canSeeDoc|scopeFor|isAdminOrManager\(\s*req|req\.user\.role|req\.userId|req\.user\._id/.test(body);

    if (!hasToken) noAuth.push(label);
    else if (!hasAuthz) noAuthz.push(label);
  });
}

console.log("=== [A] ไม่มี verifyToken เลย — เรียกได้โดยไม่ต้องล็อกอิน ===");
noAuth.forEach((o) => console.log("  " + o));
console.log(`  รวม ${noAuth.length} เส้นทาง\n`);

console.log("=== [B] ล็อกอินแล้วทำได้ทันที ไม่มีเช็คสิทธิ์/ความเป็นเจ้าของ ===");
noAuthz.forEach((o) => console.log("  " + o));
console.log(`  รวม ${noAuthz.length} เส้นทาง`);
