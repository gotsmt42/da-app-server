/**
 * อัปเดตหน้าจอแบบเรียลไทม์ (Server-Sent Events)
 *
 * ✅ ผู้ใช้สั่ง: "หน้าการอัพเดตข้อมูล หรือสถานะต่างๆ ให้เป็นแบบเรียลไทม์อัตโนมัติ ไม่ต้องรีเฟรช"
 *
 * หลักการ: ทางนี้ "ไม่ส่งข้อมูล" — ส่งแค่สัญญาณว่าข้อมูลหมวดไหนเปลี่ยน
 *     { topic: "expenses", id: "<ObjectId>", action: "post", origin: "<แท็บที่กด>", by: "<userId>", at }
 * แล้วหน้าจอที่เปิดอยู่ไปดึงข้อมูลใหม่ผ่าน API เดิมของมันเอง
 *
 * 🔒 ทำไมไม่ส่งข้อมูลจริงมาทางนี้: API เดิมทุกเส้นกรองสิทธิ์/ขอบเขตการมองเห็นไว้แล้ว (เช่น ช่างเห็นใบเบิก
 * เฉพาะของตัวเอง) ถ้าส่งข้อมูลทางนี้ต้องเขียนกฎการมองเห็นซ้ำอีกชุดให้ทุกหมวด ซึ่งพลาดจุดเดียวข้อมูลรั่วข้ามคน
 * — สัญญาณเปล่าๆ ไม่มีอะไรให้รั่ว
 *
 * ⚠️ ทำงานในหน่วยความจำของโปรเซสเดียว — ถ้าวันหนึ่งรันเซิร์ฟเวอร์หลายเครื่องพร้อมกัน ต้องเปลี่ยนตัวกระจาย
 * เป็น Redis pub/sub หรือ MongoDB change stream ไม่งั้นคนที่ต่อคนละเครื่องจะไม่ได้สัญญาณ
 * (หน้าจอยังดึงข้อมูลซ้ำเมื่อกลับมาที่แท็บ/เชื่อมต่อใหม่ ข้อมูลจึงไม่ค้างถาวร)
 */

/** ส่งบรรทัดว่างกันพร็อกซี/โหลดบาลานเซอร์ตัดการเชื่อมต่อที่เงียบนาน (ส่วนใหญ่ตัดที่ 60 วินาที) */
const HEARTBEAT_MS = 25_000;
/**
 * ตัดการเชื่อมต่อทิ้งเป็นระยะให้หน้าจอต่อใหม่ — การต่อใหม่ต้องผ่าน verifyToken อีกรอบ
 * 🔒 คนที่ถูกบังคับออกจากระบบ/ลบบัญชีจะหลุดจากช่องนี้ภายในเวลานี้เสมอ
 */
const MAX_LIFETIME_MS = 20 * 60_000;
/** เปิดหลายแท็บ/หลายเครื่องได้ แต่กันสคริปต์เปิดค้างไว้เป็นร้อยจนเซิร์ฟเวอร์หมดทรัพยากร */
const MAX_PER_USER = 8;

const clients = new Set();
let heartbeat = null;

const drop = (client) => {
  if (!clients.has(client)) return;
  clients.delete(client);
  clearTimeout(client.lifetime);
  try {
    client.res.end();
  } catch {
    /* ปิดไปแล้ว */
  }
};

const write = (client, chunk) => {
  try {
    client.res.write(chunk);
  } catch {
    drop(client);
  }
};

const ensureHeartbeat = () => {
  if (heartbeat) return;
  heartbeat = setInterval(() => {
    if (!clients.size) {
      clearInterval(heartbeat);
      heartbeat = null;
      return;
    }
    clients.forEach((c) => write(c, `: ping\n\n`));
  }, HEARTBEAT_MS);
  heartbeat.unref?.();
};

/** รับการเชื่อมต่อใหม่ — ⚠️ ต้องผ่าน verifyToken มาก่อนเสมอ (ใช้ req.userId) */
function attach(req, res) {
  const userId = String(req.userId || "");
  const mine = [...clients].filter((c) => c.userId === userId);
  if (mine.length >= MAX_PER_USER) drop(mine[0]);

  res.status(200);
  res.set({
    "Content-Type": "text/event-stream; charset=utf-8",
    // ⚠️ no-transform สำคัญ: middleware compression จะข้ามการบีบอัดให้ — ถ้าบีบอัด ข้อความจะค้างในบัฟเฟอร์
    // ไม่ถูกส่งออกไปจนกว่าจะเต็ม หน้าจอจะไม่ได้สัญญาณอะไรเลยแบบเงียบๆ
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();
  req.socket?.setTimeout?.(0);
  req.socket?.setKeepAlive?.(true);

  const client = { res, userId };
  clients.add(client);
  client.lifetime = setTimeout(() => drop(client), MAX_LIFETIME_MS);
  client.lifetime.unref?.();
  req.on("close", () => drop(client));

  write(client, `retry: 3000\nevent: ready\ndata: ${JSON.stringify({ at: Date.now() })}\n\n`);
  ensureHeartbeat();
}

/**
 * ประกาศว่าข้อมูลหมวดหนึ่งเปลี่ยน
 * @param {object} e
 * @param {string} e.topic   หมวด เช่น "expenses" / "events" / "dispatch"
 * @param {string} [e.id]    เอกสารที่เปลี่ยน (ถ้ารู้)
 * @param {string} [e.action]
 * @param {string} [e.origin] รหัสแท็บที่เป็นคนกด — แท็บนั้นอัปเดตหน้าจอตัวเองไปแล้ว ไม่ต้องดึงซ้ำ
 * @param {string} [e.by]    userId คนที่กด
 * @param {string[]} [e.userIds] ส่งเฉพาะคนเหล่านี้ (ไม่ใส่ = ทุกคนที่ต่ออยู่)
 */
function publish({ topic, id = "", action = "", origin = "", by = "", userIds = null }) {
  if (!topic || !clients.size) return;
  const data = JSON.stringify({ topic, id, action, origin, by, at: Date.now() });
  const only = userIds ? new Set(userIds.map(String)) : null;
  clients.forEach((c) => {
    if (!only || only.has(c.userId)) write(c, `event: change\ndata: ${data}\n\n`);
  });
}

/**
 * หมวดของแต่ละ router (ตาม path ใต้ /api) — หน้าจอ subscribe ด้วยชื่อหมวดพวกนี้
 * ⚠️ ใบมอบหมายงาน (dispatch) สร้าง/แก้งานในปฏิทินด้วย จึงประกาศทั้งสองหมวด
 */
const TOPICS_BY_BASE = {
  auth: ["users"],
  customer: ["customers"],
  product: ["products"],
  stockproduct: ["products"],
  files: ["files"],
  events: ["events"],
  jobtype: ["lookups"],
  systemtype: ["lookups"],
  "issued-documents": ["documents"],
  dispatch: ["dispatch", "events"],
  expenses: ["expenses"],
  settings: ["settings"],
};

/** คำสั่งที่ไม่ได้เปลี่ยนข้อมูลที่ใครเห็น — ไม่ต้องปลุกทุกหน้าจอให้ดึงใหม่ */
const NOT_A_CHANGE = [
  /^\/auth\/(login|validate-password)(\/|$)/,
  /^\/files\/files\/download-zip/,
  /^\/events\/[^/]+\/billing\/scan/,
  /^\/expenses\/[^/]+\/blank-claim-form/,
];

const OBJECT_ID = /^[a-f0-9]{24}$/i;

/**
 * middleware: หลังคำสั่งเปลี่ยนข้อมูล (POST/PUT/PATCH/DELETE) สำเร็จ → ประกาศหมวดของ router นั้น
 * ✅ จุดเดียวครอบทุก route — เพิ่ม route ใหม่ในหมวดเดิมก็ได้เรียลไทม์ทันทีโดยไม่ต้องจำมาเรียก publish เอง
 * ⚠️ ต้อง mount ที่ router ของ /api "ก่อน" router ย่อยทุกตัว (req.path จะเป็น /expenses/... )
 */
function publishMutations(req, res, next) {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();
  const path = req.path || "";
  if (NOT_A_CHANGE.some((re) => re.test(path))) return next();
  const [, base = "", second = ""] = path.split("/");
  const topics = TOPICS_BY_BASE[base];
  if (!topics) return next();

  res.on("finish", () => {
    if (res.statusCode >= 400) return;
    const origin = String(req.header("X-Client-Id") || "").slice(0, 64);
    const id = OBJECT_ID.test(second) ? second : "";
    const by = String(req.userId || "");
    topics.forEach((topic) => publish({ topic, id, action: req.method.toLowerCase(), origin, by }));
  });
  next();
}

const stats = () => ({ connections: clients.size, users: new Set([...clients].map((c) => c.userId)).size });

module.exports = { attach, publish, publishMutations, stats, TOPICS_BY_BASE };
