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
  store.dirty = true;
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
 * ✅ (12 ต.ค. 2569) คลังงานในหน่วยความจำ — ดึงจากฐานข้อมูลให้น้อยที่สุด
 *
 * log จริงบน production: `event-op base miss rows=596 db=8063ms size=862KB` · detail 1088KB = 10.7 วินาที
 * ping ฐานข้อมูลแค่ 4–23ms แต่เวลาแปรตามขนาดข้อมูลตรงๆ (~100 KB/วินาที) = Atlas M0 (ฟรี) จำกัดความเร็วรับส่ง
 * ผู้ใช้ขอแก้ด้วยโค้ดโดยไม่ต้องอัปเกรดแพ็กเกจ
 *
 * หลักการ:
 * - เก็บงาน "ทุกใบแบบเต็ม" ไว้ชุดเดียวในหน่วยความจำ (ทั้งระบบราว 600 ใบ ≈ 1–2 MB)
 * - ซิงก์เฉพาะใบที่ updatedAt ใหม่กว่ารอบก่อน (Mongoose ใส่ updatedAt ให้ทุก save/update/bulkWrite อัตโนมัติ)
 *   — ซิงก์เมื่อมีการแก้งาน (hook ใน models/Events.js เรียก bump) หรือครบ SYNC_TTL_MS กันการแก้นอกแอป
 * - แต่ละคำขอยังถามฐานข้อมูลด้วย "ตัวกรองจริง" เสมอ แต่ขอแค่ _id (ราว 20KB) → สิทธิ์การมองเห็น/ลำดับ
 *   ตรงกับ MongoDB ทุกประการ ไม่ต้องเขียนตัวกรองซ้ำในโค้ด แล้วค่อยหยิบเนื้องานจากคลัง
 * - โหลดใหม่ทั้งชุดเบื้องหลังทุก FULL_RELOAD_MS (ไม่บล็อกผู้ใช้) — ล้างใบที่ถูกลบ/กันข้อมูลคลาดเคลื่อน
 * ⚠️ เผื่อเวลาย้อนหลัง SYNC_MARGIN_MS กันงานที่กำลังบันทึกอยู่พอดีตอนซิงก์
 * ⚠️ อยู่ในหน่วยความจำของโปรเซสเดียว — ถ้ารันหลายเครื่องต้องย้ายไปใช้ change stream/Redis
 */
const SYNC_MARGIN_MS = 60_000;
const SYNC_TTL_MS = 60_000;
const FULL_RELOAD_MS = 6 * 3600_000;

const store = { byId: null, since: 0, syncedAt: 0, loadedAt: 0, dirty: true, syncing: null, reloading: null };
const Model = () => require("../models/Events");

async function fullLoad() {
  const startedAt = Date.now();
  const rows = await Model().find({}).lean();
  store.byId = new Map(rows.map((r) => [String(r._id), r]));
  store.since = startedAt - SYNC_MARGIN_MS;
  store.syncedAt = startedAt;
  store.loadedAt = startedAt;
  console.log(`📦 โหลดคลังงาน ${rows.length} ใบ ใช้ ${Date.now() - startedAt}ms`);
}

/** ทำให้คลังเป็นปัจจุบัน (คำขอพร้อมกันรอรอบเดียวกัน) */
function ensureFresh() {
  if (!store.byId) {
    store.reloading ||= fullLoad().finally(() => { store.reloading = null; });
    return store.reloading;
  }
  const now = Date.now();
  if (now - store.loadedAt > FULL_RELOAD_MS && !store.reloading) {
    // เบื้องหลัง — ระหว่างนี้ใช้ชุดเดิม + ซิงก์ส่วนต่างตามปกติ
    store.reloading = fullLoad().catch((e) => console.error("⚠️ โหลดคลังงานใหม่ไม่สำเร็จ:", e.message)).finally(() => { store.reloading = null; });
  }
  if (!store.dirty && now - store.syncedAt < SYNC_TTL_MS) return Promise.resolve();
  if (store.syncing) return store.syncing;
  store.dirty = false;
  const startedAt = now;
  store.syncing = Model().find({ updatedAt: { $gte: new Date(store.since) } }).lean()
    .then((rows) => {
      rows.forEach((r) => store.byId.set(String(r._id), r));
      store.since = startedAt - SYNC_MARGIN_MS;
      store.syncedAt = startedAt;
    })
    .catch((e) => { store.dirty = true; throw e; })
    .finally(() => { store.syncing = null; });
  return store.syncing;
}

/** ตัดฟิลด์ตาม select แบบ Mongoose ("a b c" = เอาเฉพาะ · "-a -b" = ตัดออก · ไม่ระบุ = ทั้งหมด) — คืน object ใหม่เสมอ */
function project(doc, select) {
  if (!select) return { ...doc };
  const fields = String(select).split(/\s+/).filter(Boolean);
  if (fields.every((f) => f.startsWith("-"))) {
    const out = { ...doc };
    fields.forEach((f) => { delete out[f.slice(1)]; });
    return out;
  }
  const out = { _id: doc._id };
  fields.forEach((f) => { if (doc[f] !== undefined) out[f] = doc[f]; });
  return out;
}

/**
 * แทน CalendarEvent.find(query).select(select).sort(sort).lean() — ผลเหมือนกัน แต่ดึงจากฐานข้อมูลแค่ _id
 * @param {object} query ตัวกรอง MongoDB ตามเดิม
 * @param {{select?: string, sort?: object}} [opts]
 */
async function findEvents(query, { select, sort } = {}) {
  let q = Model().find(query).select("_id");
  if (sort) q = q.sort(sort);
  const [ids] = await Promise.all([q.lean(), ensureFresh()]);
  const missing = ids.map((r) => String(r._id)).filter((id) => !store.byId.has(id));
  if (missing.length) {
    (await Model().find({ _id: { $in: missing } }).lean()).forEach((r) => store.byId.set(String(r._id), r));
  }
  return ids.map((r) => store.byId.get(String(r._id))).filter(Boolean).map((d) => project(d, select));
}

/** อุ่นคลังตอนเปิดเซิร์ฟเวอร์ — ผู้ใช้คนแรกไม่ต้องรอ */
const warmEvents = () => ensureFresh().catch((e) => console.error("⚠️ อุ่นคลังงานไม่สำเร็จ:", e.message));

module.exports = { bump, cached, findEvents, warmEvents };
