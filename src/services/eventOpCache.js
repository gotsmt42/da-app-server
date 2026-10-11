/**
 * ✅ (11 ต.ค. 2569 ผู้ใช้: "แอพช้า และค้าง ตอนอัพขึ้น production ... ค้างทุกหน้า")
 * แคชผลลัพธ์ GET /api/events/event-op ในหน่วยความจำ
 *
 * ปัญหาที่เจอใน log ของ Render: event-op ใช้เวลา 8.5–11 วินาที และโดนเรียกซ้ำพร้อมกันหลายสิบครั้ง
 * — ทุกครั้งที่มีใครแก้งาน ระบบเรียลไทม์ปลุก "ทุกหน้าจอของทุกคน" ให้ดึง event-op ใหม่พร้อมกัน
 *   (หน้าเดียวเรียก event-op หลายจุด: ป้ายเมนู/แจ้งเตือน/ตัวหน้าเอง) เซิร์ฟเวอร์ CPU เล็กจึงต้องดึง
 *   งานทั้งชุด + แปลง JSON หลาย MB ซ้ำๆ จนคิวยาว ทุกหน้าค้างตาม
 *
 * หลักการ:
 * - คีย์ = ตัวกรองสุดท้ายที่ใช้ query จริง + โหมด (slim/detail) — แอดมิน/ผู้จัดการทุกคนได้ตัวกรองเดียวกัน
 *   จึงใช้ผลลัพธ์ก้อนเดียวกัน (สิทธิ์การมองเห็นอยู่ในตัวกรองแล้ว แคชไม่ข้ามสิทธิ์)
 * - คำขอที่เข้ามาพร้อมกันระหว่างกำลัง query รอ promise เดียวกัน (ไม่ยิงฐานข้อมูลซ้ำ)
 * - งานถูกแก้ผ่าน Mongoose ที่ไหนก็ตาม (ดู hook ใน models/Events.js) → เลขเวอร์ชันขยับ แคชทั้งหมดหมดอายุทันที
 * - TTL สำรอง กันกรณีแก้ข้อมูลโดยไม่ผ่าน Mongoose (เช่นแก้ใน Atlas ตรงๆ)
 * ⚠️ อยู่ในหน่วยความจำของโปรเซสเดียว — ถ้ารันหลายเครื่องต้องย้ายไป Redis (เหมือน services/realtime.js)
 */
const TTL_MS = 30_000;
const MAX_ENTRIES = 20;
/** ⚠️ เซิร์ฟเวอร์ Render หน่วยความจำน้อย — จำกัดขนาดรวมของแคช (ข้อความ JSON) ไม่ให้กินหน่วยความจำจนช้าลงเอง */
const MAX_BYTES = 40 * 1024 * 1024;

let version = 0;
const entries = new Map(); // key -> { version, at, promise }

/** เรียกทุกครั้งที่ข้อมูลงานเปลี่ยน */
function bump() {
  version += 1;
  entries.clear();
}

/**
 * คืนผลลัพธ์จากแคช หรือรัน load() (ครั้งเดียวต่อคีย์ แม้มีคำขอพร้อมกันหลายตัว)
 * @param {string} key
 * @param {() => Promise<any>} load
 */
function cached(key, load) {
  const now = Date.now();
  const hit = entries.get(key);
  if (hit && hit.version === version && now - hit.at < TTL_MS) return hit.promise;

  const v = version;
  const entry = { version: v, at: now, size: 0, promise: null };
  entry.promise = load().then((json) => {
    entry.size = typeof json === "string" ? json.length : 0;
    let total = 0;
    entries.forEach((e) => { total += e.size; });
    // ใหญ่เกินเพดาน → ทิ้งอันเก่าสุดก่อน (อันนี้ยังส่งให้คนที่รออยู่ได้ตามปกติ)
    for (const [k, e] of entries) {
      if (total <= MAX_BYTES) break;
      if (e === entry) continue;
      total -= e.size;
      entries.delete(k);
    }
    if (total > MAX_BYTES && entries.get(key) === entry) entries.delete(key);
    return json;
  }).catch((err) => {
    if (entries.get(key) === entry) entries.delete(key);
    throw err;
  });
  if (entries.size >= MAX_ENTRIES) entries.delete(entries.keys().next().value);
  entries.set(key, entry);
  return entry.promise;
}

module.exports = { bump, cached };
