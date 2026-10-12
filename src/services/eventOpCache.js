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

/**
 * ✅ (12 ต.ค. 2569) ดึงงานแบบ "ส่งเฉพาะที่เปลี่ยน" — log จริงบน production:
 *    `event-op base miss rows=596 db=8063ms size=862KB` และ detail 1088KB = 10.7 วินาที
 *    เวลาแปรตามขนาดข้อมูลตรงๆ (~100 KB/วินาที) = ช่องทางรับส่งกับฐานข้อมูลถูกจำกัดความเร็ว
 *    ไม่ใช่ query ช้า — ทางแก้คือ "ดึงข้อมูลจากฐานข้อมูลให้น้อยที่สุด"
 * หลักการ: ครั้งแรกดึงทั้งชุดเก็บไว้ · ครั้งถัดไปดึงแค่
 *    (1) รายการ _id ที่ยังอยู่ในขอบเขต (ไว้ตัดงานที่ถูกลบ/หลุดสิทธิ์) และ
 *    (2) เอกสารที่ updatedAt ใหม่กว่ารอบก่อน (Mongoose ใส่ updatedAt ให้ทุก save/update/bulkWrite อัตโนมัติ)
 * ⚠️ เผื่อเวลาย้อนหลัง SYNC_MARGIN_MS กันงานที่กำลังบันทึกอยู่ตอน query · โหลดใหม่ทั้งชุดทุก FULL_RELOAD_MS กันพลาด
 */
const SYNC_MARGIN_MS = 60_000;
const FULL_RELOAD_MS = 15 * 60_000;
const MAX_SNAPS = 40;
const snaps = new Map(); // key -> { byId: Map, since, loadedAt }

async function rowsFor(key, Model, query, select) {
  const startedAt = Date.now();
  let snap = snaps.get(key);
  if (!snap || startedAt - snap.loadedAt > FULL_RELOAD_MS) {
    const rows = await Model.find(query).select(select).lean();
    snap = { byId: new Map(rows.map((r) => [String(r._id), r])), since: startedAt - SYNC_MARGIN_MS, loadedAt: startedAt };
  } else {
    const [ids, changed] = await Promise.all([
      Model.find(query).select("_id").lean(),
      Model.find({ $and: [query, { updatedAt: { $gte: new Date(snap.since) } }] }).select(select).lean(),
    ]);
    const keep = new Set(ids.map((r) => String(r._id)));
    for (const id of [...snap.byId.keys()]) if (!keep.has(id)) snap.byId.delete(id);
    changed.forEach((r) => snap.byId.set(String(r._id), r));
    // อยู่ในขอบเขตแต่ไม่มีในชุดที่เก็บ (เช่นงานเพิ่งเข้าขอบเขตโดยไม่ได้แก้ตัวงาน) → ดึงเฉพาะใบนั้น
    const missing = [...keep].filter((id) => !snap.byId.has(id));
    if (missing.length) {
      (await Model.find({ _id: { $in: missing } }).select(select).lean()).forEach((r) => snap.byId.set(String(r._id), r));
    }
    snap.since = startedAt - SYNC_MARGIN_MS;
  }
  snaps.delete(key);
  snaps.set(key, snap);
  while (snaps.size > MAX_SNAPS) snaps.delete(snaps.keys().next().value);
  const t = (r) => (r.start ? new Date(r.start).getTime() : -Infinity);
  return [...snap.byId.values()].sort((a, b) => t(b) - t(a));
}

module.exports = { bump, cached, rowsFor };
