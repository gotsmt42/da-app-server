/**
 * /api/stock — สต๊อก · ทรัพย์สินแผนก
 *
 * ✅ (27 ต.ค. 2569 ผู้ใช้: "ทำระบบสต๊อกสินค้าแผนก ต้องให้กรอกใบเบิกเพื่อขอเบิก และตัดยอดออกจากข้อมูล realtime
 *    ทำให้สมบูรณ์ สวยงาม และใช้งานง่าย" · "หรือเป็นทรัพย์สินแผนก")
 *   ผู้ใช้เลือก: อนุมัติก่อนตัดยอด · แยกคลังต่อแผนก · บังคับอิงงาน · มีทั้งวัสดุ (ตัดยอด) และทรัพย์สิน (ยืม-คืน)
 *
 * สิทธิ์ (config/roles.js):
 *   requestStock — ยื่นใบเบิก/ยืมของจากคลังแผนกตัวเอง · ดูคลังแผนกตัวเอง
 *   manageStock  — จัดการคลังทุกแผนก: เพิ่ม/แก้สินค้า · รับเข้า/ตรวจนับ · อนุมัติจ่ายของ · ไม่อนุมัติ · รับคืน
 * ยอด: เบิกได้ = qty − reserved · ยื่นใบ = จองยอด (reserved) · อนุมัติ = ตัดยอดจริง · ไม่อนุมัติ/ยกเลิก = ปล่อยยอดจอง
 * ⚠️ ทุกการเปลี่ยนยอดเป็นอะตอมมิก ($inc + เงื่อนไขยอดพอ) กันสองคนเบิกชิ้นสุดท้ายพร้อมกัน · บันทึก StockMove ทุกครั้ง
 * ✅ เรียลไทม์: services/realtime.js ประกาศหมวด "stock" ทุกครั้งที่มีการเขียน — หน้าจอทุกเครื่องดึงยอดใหม่ทันที
 */
const express = require("express");
const multer = require("multer");
const streamifier = require("streamifier");

const StockItem = require("../models/StockItem");
const StockMove = require("../models/StockMove");
const StockRequest = require("../models/StockRequest");
const CalendarEvent = require("../models/Events");
const DocCounter = require("../models/DocCounter");
const { cloudinary } = require("../config/cloudinary");
const { fileFilter, limits } = require("../config/upload");
const verifyToken = require("../middleware/auth");
const { can, titleOf, departmentOf, DEPARTMENT, DEPARTMENT_LABEL, effectiveCapabilities } = require("../config/roles");
const { sendPushToUsers, sendPushToRoles } = require("../services/PushNotify");

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), fileFilter, limits });
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"];

const DEPTS = Object.values(DEPARTMENT);
const DEPT_PREFIX = { service: "SV", sales: "SL" };
const personName = (u) => [u?.fname, u?.lname].map((x) => String(x || "").trim()).filter(Boolean).join(" ") || u?.username || "ผู้ใช้";
const actor = (req) => ({ userId: String(req.user?._id || req.userId || ""), name: personName(req.user) });
const isId = (v) => /^[a-f0-9]{24}$/i.test(String(v || ""));
const str = (v, max = 200) => String(v ?? "").trim().slice(0, max);
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : NaN; };
const canManage = (req) => can(req.user, "manageStock");
const canRequest = (req) => can(req.user, "requestStock") || canManage(req);
const myDept = (req) => departmentOf(req.user) || DEPARTMENT.SERVICE;
/** แผนกที่ขอดู/ทำรายการ — ผู้จัดการคลังเลือกได้ทุกแผนก · คนอื่นได้แผนกตัวเองเท่านั้น */
const deptFor = (req, raw) => {
  const d = String(raw || "");
  if (canManage(req)) return DEPTS.includes(d) ? d : myDept(req);
  return myDept(req);
};
const managerRanks = () => effectiveCapabilities().manageStock || [];
const log = (doc, action, detail, who) => doc.activityLog.push({ action, detail, userId: who.userId, userName: who.name, timestamp: new Date() });

const nextDocNo = async () => {
  const year = new Date().getFullYear() + 543;
  const c = await DocCounter.findOneAndUpdate({ key: `stockreq:${year}` }, { $inc: { seq: 1 } }, { new: true, upsert: true, setDefaultsOnInsert: true });
  return `SR-${String(c.seq).padStart(5, "0")}/${year}`;
};
const nextItemCode = async (dept) => {
  const c = await DocCounter.findOneAndUpdate({ key: `stockitem:${dept}` }, { $inc: { seq: 1 } }, { new: true, upsert: true, setDefaultsOnInsert: true });
  return `${DEPT_PREFIX[dept] || "ST"}-${String(c.seq).padStart(4, "0")}`;
};
const move = (item, type, qty, req, extra = {}) => StockMove.create({
  item: item._id, itemName: item.name, unit: item.unit, dept: item.dept, type, qty, balance: item.qty, by: actor(req), at: new Date(), ...extra,
});
const reqLink = (doc) => `/stock?tab=requests&id=${doc._id}`;
const sumLine = (doc) => doc.lines.map((l) => `${l.name} ×${l.qty}`).join(", ").slice(0, 140);

// ══ ค่าตั้งต้น ═══════════════════════════════════════════════════════════════

router.get("/config", verifyToken, (req, res) => {
  if (!canRequest(req)) return res.status(403).json({ message: "ไม่มีสิทธิ์ใช้งานระบบสต๊อก" });
  const depts = canManage(req) ? DEPTS : [myDept(req)];
  res.json({ depts: depts.map((d) => ({ value: d, label: DEPARTMENT_LABEL[d] || d })), myDept: myDept(req), canManage: canManage(req) });
});

/** ป้ายตัวเลข: ผู้จัดการ = ใบรออนุมัติ + ของใกล้หมด · ผู้ยื่น = ใบที่ยังยืมของค้าง */
router.get("/summary", verifyToken, async (req, res) => {
  try {
    if (!canRequest(req)) return res.json({ pending: 0, low: 0, myLoans: 0, badge: 0 });
    const me = String(req.userId);
    const scope = canManage(req) ? {} : { dept: myDept(req) };
    const [pending, lowItems, myLoans, myPending] = await Promise.all([
      canManage(req) ? StockRequest.countDocuments({ ...scope, status: "pending" }) : 0,
      StockItem.countDocuments({ ...scope, active: true, minQty: { $gt: 0 }, $expr: { $lt: [{ $subtract: ["$qty", "$reserved"] }, "$minQty"] } }),
      StockRequest.countDocuments({ "requester.userId": me, status: "issued", "lines.kind": "asset" }),
      StockRequest.countDocuments({ "requester.userId": me, status: "pending" }),
    ]);
    res.json({ pending, low: lowItems, myLoans, myPending, badge: canManage(req) ? pending : 0 });
  } catch (err) {
    console.error("❌ stock summary:", err.message);
    res.status(500).json({ message: "โหลดสรุปสต๊อกไม่สำเร็จ" });
  }
});

// ══ คลังสินค้า ══════════════════════════════════════════════════════════════

router.get("/items", verifyToken, async (req, res) => {
  try {
    if (!canRequest(req)) return res.status(403).json({ message: "ไม่มีสิทธิ์ดูคลัง" });
    const dept = deptFor(req, req.query.dept);
    const q = { dept };
    if (req.query.all !== "1" || !canManage(req)) q.active = true;
    const items = await StockItem.find(q).sort({ kind: 1, category: 1, name: 1 }).lean();
    res.json({ dept, items });
  } catch (err) {
    res.status(500).json({ message: "โหลดคลังไม่สำเร็จ" });
  }
});

router.post("/items", verifyToken, async (req, res) => {
  try {
    if (!canManage(req)) return res.status(403).json({ message: "เพิ่มสินค้าได้เฉพาะผู้ดูแลคลัง" });
    const b = req.body || {};
    const dept = deptFor(req, b.dept);
    const name = str(b.name, 160);
    if (!name) return res.status(400).json({ message: "กรุณาระบุชื่อสินค้า/ทรัพย์สิน" });
    const qty = Math.max(0, Math.floor(num(b.qty) || 0));
    const item = await StockItem.create({
      dept, code: str(b.code, 40) || await nextItemCode(dept), name, kind: b.kind === "asset" ? "asset" : "consumable",
      category: str(b.category, 80), unit: str(b.unit, 30) || "ชิ้น", qty, minQty: Math.max(0, Math.floor(num(b.minQty) || 0)),
      location: str(b.location, 120), note: str(b.note, 500), createdBy: actor(req),
    });
    if (qty > 0) await move(item, "in", qty, req, { note: "ยอดตั้งต้น" });
    res.json({ item });
  } catch (err) {
    console.error("❌ stock add item:", err.message);
    res.status(500).json({ message: "เพิ่มสินค้าไม่สำเร็จ" });
  }
});

router.put("/items/:id", verifyToken, async (req, res) => {
  try {
    if (!canManage(req)) return res.status(403).json({ message: "แก้สินค้าได้เฉพาะผู้ดูแลคลัง" });
    if (!isId(req.params.id)) return res.status(404).json({ message: "ไม่พบสินค้า" });
    const b = req.body || {};
    const $set = {};
    if (b.name !== undefined) { const n = str(b.name, 160); if (!n) return res.status(400).json({ message: "กรุณาระบุชื่อ" }); $set.name = n; }
    ["category", "location", "note", "code"].forEach((k) => { if (b[k] !== undefined) $set[k] = str(b[k], k === "note" ? 500 : 120); });
    if (b.unit !== undefined) $set.unit = str(b.unit, 30) || "ชิ้น";
    if (b.minQty !== undefined) $set.minQty = Math.max(0, Math.floor(num(b.minQty) || 0));
    if (b.kind !== undefined) $set.kind = b.kind === "asset" ? "asset" : "consumable";
    if (b.active !== undefined) $set.active = Boolean(b.active);
    const item = await StockItem.findByIdAndUpdate(req.params.id, { $set }, { new: true });
    if (!item) return res.status(404).json({ message: "ไม่พบสินค้า" });
    res.json({ item });
  } catch (err) {
    res.status(500).json({ message: "บันทึกไม่สำเร็จ" });
  }
});

/** รูปสินค้า — อัปทับรูปเดิม (ลบรูปเก่าใน Cloudinary ให้ด้วย ไม่ให้ค้างเปลืองที่) */
router.post("/items/:id/photo", verifyToken, upload.single("photo"), async (req, res) => {
  try {
    if (!canManage(req)) return res.status(403).json({ message: "ใส่รูปได้เฉพาะผู้ดูแลคลัง" });
    if (!isId(req.params.id)) return res.status(404).json({ message: "ไม่พบสินค้า" });
    if (!req.file || !IMAGE_TYPES.includes(req.file.mimetype)) return res.status(400).json({ message: "กรุณาเลือกไฟล์รูปภาพ" });
    const cur = await StockItem.findById(req.params.id).select("photo dept");
    if (!cur) return res.status(404).json({ message: "ไม่พบสินค้า" });
    const out = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { resource_type: "image", folder: `stock/${cur.dept}`, public_id: `${cur._id}_${Date.now()}`, overwrite: true },
        (err, r) => (err ? reject(err) : resolve(r)),
      );
      streamifier.createReadStream(req.file.buffer).pipe(stream);
    });
    const old = cur.photo?.publicId;
    const item = await StockItem.findByIdAndUpdate(cur._id, { $set: { photo: { url: out.secure_url, publicId: out.public_id } } }, { new: true });
    if (old) cloudinary.uploader.destroy(old).catch(() => {});
    res.json({ item });
  } catch (err) {
    console.error("❌ stock photo:", err.message);
    res.status(500).json({ message: "อัปโหลดรูปไม่สำเร็จ" });
  }
});

router.delete("/items/:id/photo", verifyToken, async (req, res) => {
  try {
    if (!canManage(req)) return res.status(403).json({ message: "ลบรูปได้เฉพาะผู้ดูแลคลัง" });
    if (!isId(req.params.id)) return res.status(404).json({ message: "ไม่พบสินค้า" });
    const cur = await StockItem.findById(req.params.id).select("photo");
    if (!cur) return res.status(404).json({ message: "ไม่พบสินค้า" });
    const old = cur.photo?.publicId;
    const item = await StockItem.findByIdAndUpdate(cur._id, { $set: { photo: { url: "", publicId: "" } } }, { new: true });
    if (old) cloudinary.uploader.destroy(old).catch(() => {});
    res.json({ item });
  } catch (err) {
    res.status(500).json({ message: "ลบรูปไม่สำเร็จ" });
  }
});

/** รับเข้า (type=in · qty = จำนวนที่เพิ่ม) หรือ ตรวจนับ (type=count · qty = ยอดที่นับได้จริงในคลัง) */
router.post("/items/:id/adjust", verifyToken, async (req, res) => {
  try {
    if (!canManage(req)) return res.status(403).json({ message: "ปรับยอดได้เฉพาะผู้ดูแลคลัง" });
    if (!isId(req.params.id)) return res.status(404).json({ message: "ไม่พบสินค้า" });
    const type = req.body?.type === "count" ? "count" : "in";
    const n = Math.floor(num(req.body?.qty));
    const note = str(req.body?.note, 300);
    const cur = await StockItem.findById(req.params.id);
    if (!cur) return res.status(404).json({ message: "ไม่พบสินค้า" });
    let item;
    if (type === "in") {
      if (!(n > 0)) return res.status(400).json({ message: "จำนวนรับเข้าต้องมากกว่า 0" });
      item = await StockItem.findByIdAndUpdate(cur._id, { $inc: { qty: n } }, { new: true });
      await move(item, "in", n, req, { note: note || "รับเข้า" });
    } else {
      if (!(n >= 0)) return res.status(400).json({ message: "ยอดที่นับได้ไม่ถูกต้อง" });
      if (n < cur.reserved) return res.status(409).json({ message: `ยอดนับได้ (${n}) น้อยกว่ายอดที่จองไว้ให้ใบเบิกที่รออนุมัติ (${cur.reserved}) — พิจารณาใบเบิกก่อน` });
      item = await StockItem.findOneAndUpdate({ _id: cur._id, qty: cur.qty }, { $set: { qty: n } }, { new: true });
      if (!item) return res.status(409).json({ message: "ยอดเพิ่งเปลี่ยนระหว่างบันทึก — ลองใหม่อีกครั้ง" });
      if (n !== cur.qty) await move(item, "adjust", n - cur.qty, req, { note: note || `ตรวจนับ ${cur.qty} → ${n}` });
    }
    res.json({ item });
  } catch (err) {
    console.error("❌ stock adjust:", err.message);
    res.status(500).json({ message: "ปรับยอดไม่สำเร็จ" });
  }
});

router.get("/moves", verifyToken, async (req, res) => {
  try {
    if (!canRequest(req)) return res.status(403).json({ message: "ไม่มีสิทธิ์" });
    const dept = deptFor(req, req.query.dept);
    const q = { dept };
    if (isId(req.query.item)) q.item = req.query.item;
    const moves = await StockMove.find(q).sort({ at: -1 }).limit(Math.min(Number(req.query.limit) || 200, 500)).lean();
    res.json({ moves });
  } catch (err) {
    res.status(500).json({ message: "โหลดประวัติไม่สำเร็จ" });
  }
});

// ══ ใบเบิก ══════════════════════════════════════════════════════════════════

router.get("/requests", verifyToken, async (req, res) => {
  try {
    if (!canRequest(req)) return res.status(403).json({ message: "ไม่มีสิทธิ์" });
    const q = {};
    if (canManage(req) && req.query.scope !== "mine") {
      if (DEPTS.includes(String(req.query.dept || ""))) q.dept = req.query.dept;
    } else {
      q["requester.userId"] = String(req.userId);
    }
    if (req.query.status) q.status = { $in: String(req.query.status).split(",") };
    const requests = await StockRequest.find(q).sort({ createdAt: -1 }).limit(300).lean();
    res.json({ requests });
  } catch (err) {
    res.status(500).json({ message: "โหลดใบเบิกไม่สำเร็จ" });
  }
});

router.get("/requests/:id", verifyToken, async (req, res) => {
  try {
    if (!isId(req.params.id)) return res.status(404).json({ message: "ไม่พบใบเบิก" });
    const doc = await StockRequest.findById(req.params.id).lean();
    if (!doc) return res.status(404).json({ message: "ไม่พบใบเบิก" });
    if (!canManage(req) && doc.requester.userId !== String(req.userId)) return res.status(403).json({ message: "ดูได้เฉพาะใบของตัวเอง" });
    res.json({ request: doc });
  } catch (err) {
    res.status(500).json({ message: "โหลดใบเบิกไม่สำเร็จ" });
  }
});

/** ปล่อยยอดจองของใบ (ไม่อนุมัติ/ยกเลิก) */
const releaseReserved = async (doc) => {
  for (const l of doc.lines) {
    // eslint-disable-next-line no-await-in-loop -- รายการต่อใบน้อย
    await StockItem.updateOne({ _id: l.item, reserved: { $gte: l.qty } }, { $inc: { reserved: -l.qty } });
  }
};

router.post("/requests", verifyToken, async (req, res) => {
  const reservedDone = [];
  try {
    if (!canRequest(req)) return res.status(403).json({ message: "ไม่มีสิทธิ์ยื่นใบเบิก" });
    const b = req.body || {};
    const dept = deptFor(req, b.dept);
    if (!isId(b.eventId)) return res.status(400).json({ message: "กรุณาเลือกงานที่จะใช้ของ (ทุกใบต้องอิงงาน)" });
    const ev = await CalendarEvent.findById(b.eventId).select("title system site company backgroundColor jobNo").lean();
    if (!ev) return res.status(400).json({ message: "ไม่พบงานที่เลือก" });
    const raw = Array.isArray(b.lines) ? b.lines : [];
    const want = new Map();
    raw.forEach((l) => {
      const n = Math.floor(num(l?.qty));
      if (isId(l?.item) && n > 0) want.set(String(l.item), (want.get(String(l.item)) || 0) + n);
    });
    if (!want.size) return res.status(400).json({ message: "เพิ่มรายการที่จะเบิกอย่างน้อย 1 รายการ" });
    const items = await StockItem.find({ _id: { $in: [...want.keys()] }, dept, active: true }).lean();
    if (items.length !== want.size) return res.status(400).json({ message: "มีรายการที่ไม่อยู่ในคลังของแผนกนี้" });

    // จองยอดทีละรายการแบบอะตอมมิก — ไม่พอ = คืนยอดที่จองไปแล้วทั้งหมด
    for (const it of items) {
      const n = want.get(String(it._id));
      // eslint-disable-next-line no-await-in-loop -- ต้องทำทีละรายการเพื่อย้อนกลับได้
      const r = await StockItem.updateOne(
        { _id: it._id, $expr: { $gte: [{ $subtract: ["$qty", "$reserved"] }, n] } },
        { $inc: { reserved: n } },
      );
      if (!r.modifiedCount) {
        // eslint-disable-next-line no-await-in-loop
        const now = await StockItem.findById(it._id).select("qty reserved").lean();
        throw Object.assign(new Error("short"), { status: 409, message: `“${it.name}” เบิกได้แค่ ${Math.max(0, (now?.qty || 0) - (now?.reserved || 0))} ${it.unit}` });
      }
      reservedDone.push([it._id, n]);
    }

    const who = actor(req);
    const doc = new StockRequest({
      docNo: await nextDocNo(), dept, status: "pending",
      requester: { ...who, position: titleOf(req.user) || "" },
      eventId: String(ev._id), jobType: ev.title || "", jobColor: ev.backgroundColor || "",
      jobTitle: [ev.title, ev.system, ev.site || ev.company ? `โครงการ ${ev.site || ev.company}` : "", ev.jobNo].filter(Boolean).join(" · "),
      lines: items.map((it) => ({ item: it._id, code: it.code, name: it.name, unit: it.unit, kind: it.kind, qty: want.get(String(it._id)) })),
      note: str(b.note, 1000),
      dueReturnAt: b.dueReturnAt && /^\d{4}-\d{2}-\d{2}$/.test(String(b.dueReturnAt)) ? new Date(`${b.dueReturnAt}T12:00:00Z`) : null,
    });
    log(doc, "created", `ยื่นใบเบิก ${doc.lines.length} รายการ`, who);
    await doc.save();
    Promise.resolve(sendPushToRoles(managerRanks(), {
      title: `📦 ใบเบิกของใหม่ ${doc.docNo} — ${who.name}`,
      body: `${sumLine(doc)}\nงาน: ${doc.jobTitle}`,
      url: reqLink(doc), tag: `stock-${doc._id}`, renotify: true,
    }, [who.userId])).catch((e) => console.error("❌ push stock create:", e.message));
    res.json({ request: doc });
  } catch (err) {
    for (const [id, n] of reservedDone) {
      // eslint-disable-next-line no-await-in-loop -- ย้อนการจองที่ทำไปแล้ว
      await StockItem.updateOne({ _id: id, reserved: { $gte: n } }, { $inc: { reserved: -n } }).catch(() => {});
    }
    if (err.status) return res.status(err.status).json({ message: err.message });
    console.error("❌ stock create request:", err.message);
    res.status(500).json({ message: "ยื่นใบเบิกไม่สำเร็จ" });
  }
});

/** อนุมัติ + จ่ายของ → ตัดยอดจริง (วัสดุ = ออกถาวร · ทรัพย์สิน = ย้ายไปยอดยืม) */
router.post("/requests/:id/issue", verifyToken, async (req, res) => {
  try {
    if (!canManage(req)) return res.status(403).json({ message: "อนุมัติได้เฉพาะผู้ดูแลคลัง" });
    if (!isId(req.params.id)) return res.status(404).json({ message: "ไม่พบใบเบิก" });
    const doc = await StockRequest.findOneAndUpdate({ _id: req.params.id, status: "pending" }, { $set: { status: "issued" } }, { new: true });
    if (!doc) return res.status(409).json({ message: "ใบนี้ไม่ได้รออนุมัติแล้ว" });
    const who = actor(req);
    for (const l of doc.lines) {
      const loan = l.kind === "asset";
      // eslint-disable-next-line no-await-in-loop -- ตัดทีละรายการ + บันทึกประวัติ
      const item = await StockItem.findOneAndUpdate(
        { _id: l.item, reserved: { $gte: l.qty }, qty: { $gte: l.qty } },
        { $inc: { reserved: -l.qty, qty: -l.qty, onLoan: loan ? l.qty : 0 } },
        { new: true },
      );
      if (!item) continue; // ยอดถูกแก้ด้วยมือระหว่างทาง — ข้าม (มีประวัติตรวจนับให้ตามดู)
      // eslint-disable-next-line no-await-in-loop
      await move(item, loan ? "loan" : "out", -l.qty, req, { requestId: String(doc._id), docNo: doc.docNo, eventId: doc.eventId, jobTitle: doc.jobTitle });
    }
    doc.issuedBy = who; doc.issuedAt = new Date();
    log(doc, "issued", `อนุมัติและจ่ายของแล้ว${req.body?.note ? ` · ${str(req.body.note, 300)}` : ""}`, who);
    await doc.save();
    const hasLoan = doc.lines.some((l) => l.kind === "asset");
    Promise.resolve(sendPushToUsers([doc.requester.userId], {
      title: `✅ อนุมัติใบเบิก ${doc.docNo} แล้ว — รับของได้`,
      body: `${sumLine(doc)}${hasLoan ? "\n⚠️ มีทรัพย์สินที่ต้องคืนหลังใช้งาน" : ""}`,
      url: reqLink(doc), tag: `stock-${doc._id}`,
    })).catch(() => {});
    res.json({ request: doc });
  } catch (err) {
    console.error("❌ stock issue:", err.message);
    res.status(500).json({ message: "อนุมัติไม่สำเร็จ" });
  }
});

router.post("/requests/:id/reject", verifyToken, async (req, res) => {
  try {
    if (!canManage(req)) return res.status(403).json({ message: "ไม่อนุมัติได้เฉพาะผู้ดูแลคลัง" });
    const reason = str(req.body?.reason, 300);
    if (!reason) return res.status(400).json({ message: "กรุณาระบุเหตุผล" });
    const doc = isId(req.params.id) && await StockRequest.findOneAndUpdate({ _id: req.params.id, status: "pending" }, { $set: { status: "rejected" } }, { new: true });
    if (!doc) return res.status(409).json({ message: "ใบนี้ไม่ได้รออนุมัติแล้ว" });
    await releaseReserved(doc);
    const who = actor(req);
    doc.rejectedBy = who; doc.rejectedAt = new Date(); doc.rejectReason = reason;
    log(doc, "rejected", `ไม่อนุมัติ: ${reason}`, who);
    await doc.save();
    Promise.resolve(sendPushToUsers([doc.requester.userId], {
      title: `↩️ ไม่อนุมัติใบเบิก ${doc.docNo}`, body: `${reason} · โดย ${who.name}`, url: reqLink(doc), tag: `stock-${doc._id}`,
    })).catch(() => {});
    res.json({ request: doc });
  } catch (err) {
    res.status(500).json({ message: "บันทึกไม่สำเร็จ" });
  }
});

router.post("/requests/:id/cancel", verifyToken, async (req, res) => {
  try {
    if (!isId(req.params.id)) return res.status(404).json({ message: "ไม่พบใบเบิก" });
    const cur = await StockRequest.findById(req.params.id).select("requester status").lean();
    if (!cur) return res.status(404).json({ message: "ไม่พบใบเบิก" });
    if (cur.requester.userId !== String(req.userId) && !canManage(req)) return res.status(403).json({ message: "ยกเลิกได้เฉพาะใบของตัวเอง" });
    const doc = await StockRequest.findOneAndUpdate({ _id: req.params.id, status: "pending" }, { $set: { status: "cancelled" } }, { new: true });
    if (!doc) return res.status(409).json({ message: "ยกเลิกได้เฉพาะใบที่ยังรออนุมัติ" });
    await releaseReserved(doc);
    const who = actor(req);
    doc.cancelledBy = who; doc.cancelledAt = new Date();
    log(doc, "cancelled", "ยกเลิกใบเบิก", who);
    await doc.save();
    res.json({ request: doc });
  } catch (err) {
    res.status(500).json({ message: "ยกเลิกไม่สำเร็จ" });
  }
});

/** รับคืนทรัพย์สิน — body.lines: [{ lineId, qty }] (ไม่ส่ง = คืนครบทุกรายการที่ค้าง) */
router.post("/requests/:id/return", verifyToken, async (req, res) => {
  try {
    if (!canManage(req)) return res.status(403).json({ message: "รับคืนได้เฉพาะผู้ดูแลคลัง" });
    const doc = isId(req.params.id) && await StockRequest.findById(req.params.id);
    if (!doc || doc.status !== "issued") return res.status(409).json({ message: "ใบนี้ไม่มีทรัพย์สินที่ค้างคืน" });
    const ask = Array.isArray(req.body?.lines) && req.body.lines.length
      ? new Map(req.body.lines.map((x) => [String(x.lineId), Math.floor(num(x.qty))]))
      : null;
    const who = actor(req);
    const done = [];
    for (const l of doc.lines) {
      if (l.kind !== "asset") continue;
      const left = l.qty - l.returnedQty;
      const n = ask ? Math.min(ask.get(String(l._id)) || 0, left) : left;
      if (!(n > 0)) continue;
      // eslint-disable-next-line no-await-in-loop
      const item = await StockItem.findOneAndUpdate({ _id: l.item, onLoan: { $gte: n } }, { $inc: { qty: n, onLoan: -n } }, { new: true })
        // ทรัพย์สินที่ยอดยืมถูกตรวจนับทับไปแล้ว — คืนเข้าคลังอย่างเดียว
        // eslint-disable-next-line no-await-in-loop
        || await StockItem.findByIdAndUpdate(l.item, { $inc: { qty: n } }, { new: true });
      l.returnedQty += n;
      done.push(`${l.name} ×${n}`);
      // eslint-disable-next-line no-await-in-loop
      if (item) await move(item, "return", n, req, { requestId: String(doc._id), docNo: doc.docNo, eventId: doc.eventId, jobTitle: doc.jobTitle });
    }
    if (!done.length) return res.status(400).json({ message: "ไม่มีจำนวนที่จะรับคืน" });
    const allBack = doc.lines.every((l) => l.kind !== "asset" || l.returnedQty >= l.qty);
    if (allBack) doc.status = "returned";
    log(doc, "returned", `รับคืน ${done.join(", ")}${allBack ? " · คืนครบแล้ว" : ""}`, who);
    await doc.save();
    Promise.resolve(sendPushToUsers([doc.requester.userId], {
      title: `📥 รับคืนทรัพย์สินแล้ว ${doc.docNo}`, body: done.join(", "), url: reqLink(doc), tag: `stock-${doc._id}`,
    })).catch(() => {});
    res.json({ request: doc });
  } catch (err) {
    console.error("❌ stock return:", err.message);
    res.status(500).json({ message: "รับคืนไม่สำเร็จ" });
  }
});

module.exports = router;
