/**
 * /api/purchase — ใบขอซื้อสินค้า (PR) · ดู models/PurchaseRequest.js
 *
 * ✅ ผู้ใช้สั่ง (2 ต.ค. 2569): "เพิ่มระบบออกใบขอซื้อสินค้า PR ให้รายละเอียดครบถ้วน และมืออาชีพ สมบูรณ์"
 *
 * สิทธิ์ (ชุดเดียวกับระบบเบิก):
 *   ยื่น PR        = requestExpense / viewAllExpenses
 *   ตรวจสอบ        = reviewExpense · อนุมัติ = approveExpense (ห้ามตรวจ/อนุมัติใบตัวเอง เว้น approveOwnExpense)
 *   สั่งซื้อ (จัดซื้อ) = viewAllExpenses
 *   รับของ          = ผู้ขอ/คนออกใบ หรือ viewAllExpenses (คนหน้างานรับของเองได้)
 * ⚠️ ลำดับ route: path ตายตัวทั้งหมดต้องมาก่อน /:id
 */
const express = require("express");
const moment = require("moment");
const multer = require("multer");
const streamifier = require("streamifier");

const PurchaseRequest = require("../models/PurchaseRequest");
const User = require("../models/User");
const CalendarEvent = require("../models/Events");
const DocCounter = require("../models/DocCounter");
const verifyToken = require("../middleware/auth");
const { can, titleOf, rankFilter, effectiveCapabilities, CAPABILITIES } = require("../config/roles");
const { cloudinary } = require("../config/cloudinary");
const { fileFilter, limits } = require("../config/upload");
const { sendPushToUsers } = require("../services/PushNotify");
const { sealFor, imagesFor } = require("../services/signatureSeal");

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), fileFilter, limits });

// ══ ตัวช่วย ══════════════════════════════════════════════════════════════════
const money = (n) => Math.round((Number(n) || 0) * 100) / 100;
const fullBaht = (n) => `${money(n).toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} บาท`;
const personName = (u) => String(u?.fname || "").trim() || u?.username || "ไม่ทราบชื่อ";
const fullNameOf = (u) => [u?.fname, u?.lname].map((x) => String(x || "").trim()).filter(Boolean).join(" ") || personName(u);
const actor = (req) => ({ userId: String(req.user?._id || req.userId || ""), name: personName(req.user) });
const isId = (v) => /^[a-f0-9]{24}$/i.test(String(v || ""));
const parseDay = (raw) => {
  const s = String(raw || "").trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
};
const todayNoonUtc = () => parseDay(moment().utcOffset(7).format("YYYY-MM-DD"));
const parseJson = (raw) => {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw !== "string") return raw;
  try { return JSON.parse(raw); } catch { return undefined; }
};
const str = (v, max) => String(v ?? "").trim().slice(0, max);
const PRIORITY_TH = { normal: "ปกติ", urgent: "ด่วน", critical: "ด่วนมาก" };

/** ทำความสะอาดรายการ + คำนวณยอดใหม่ (แถวที่ไม่มีชื่อสินค้าถูกทิ้ง) */
const sanitizeItems = (raw, prev = []) => (Array.isArray(parseJson(raw)) ? parseJson(raw) : [])
  .slice(0, 80)
  .map((it) => {
    const qty = Math.min(Math.max(Number(it?.qty) || 0, 0), 1_000_000);
    const estUnitPrice = money(Math.min(Math.max(Number(it?.estUnitPrice) || 0, 0), 100_000_000));
    const old = prev.find((p) => String(p._id) === String(it?._id || ""));
    return {
      ...(old ? { _id: old._id } : {}),
      description: str(it?.description, 300),
      spec: str(it?.spec, 500),
      qty,
      unit: str(it?.unit, 30),
      estUnitPrice,
      estAmount: money(qty * estUnitPrice),
      note: str(it?.note, 300),
      receivedQty: old?.receivedQty || 0,
      actualUnitPrice: old?.actualUnitPrice ?? null,
      actualAmount: old?.actualAmount ?? null,
    };
  })
  .filter((it) => it.description);

const applyTotals = (doc) => {
  const vat = [0, 7].includes(Number(doc.vatRate)) ? Number(doc.vatRate) : 0;
  doc.vatRate = vat;
  doc.estSubtotal = money(doc.items.reduce((s, it) => s + (it.estAmount || 0), 0));
  doc.estTotal = money(doc.estSubtotal * (1 + vat / 100));
  const actualSub = doc.items.reduce((s, it) => s + (it.actualAmount ?? 0), 0);
  doc.actualTotal = doc.items.some((it) => it.actualAmount !== null && it.actualAmount !== undefined) ? money(actualSub * (1 + vat / 100)) : 0;
};

const resolveJob = async (eventId) => {
  const id = String(eventId || "").trim();
  if (!id) return { eventId: "", job: { title: "", system: "", site: "", company: "", docNo: "" } };
  if (!isId(id)) return null;
  const ev = await CalendarEvent.findById(id).select("title system site company docNo").lean();
  if (!ev) return null;
  return { eventId: id, job: { title: ev.title || "", system: ev.system || "", site: ev.site || "", company: ev.company || "", docNo: ev.docNo || "" } };
};

const nextDocNo = async () => {
  const year = new Date().getFullYear() + 543;
  const c = await DocCounter.findOneAndUpdate({ key: `pr:${year}` }, { $inc: { seq: 1 } }, { new: true, upsert: true, setDefaultsOnInsert: true });
  return `PR-${String(c.seq).padStart(5, "0")}/${year}`;
};
const saveWithDocNo = async (doc) => {
  for (let i = 0; i < 20; i += 1) {
    try { return await doc.save(); } catch (err) {
      if (err?.code !== 11000 || !err?.keyPattern?.docNo) throw err;
      doc.docNo = await nextDocNo();
    }
  }
  throw new Error("ออกเลขที่เอกสารไม่สำเร็จ");
};
const log = (doc, action, detail, me) => doc.activityLog.push({ action, detail, userId: me.userId, userName: me.name, timestamp: new Date() });

const uploadToCloud = async (file, folder, uploadedBy, kind) => {
  const originalName = Buffer.from(file.originalname, "latin1").toString("utf8");
  const sanitized = originalName.replace(/[^\w\-.]/g, "_");
  const isImage = ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"].includes(file.mimetype);
  const result = await new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { resource_type: isImage ? "image" : "raw", folder, public_id: `${Date.now()}_${isImage ? sanitized.replace(/\.[^.]+$/, "") : sanitized}`, use_filename: false, unique_filename: false, overwrite: true },
      (err, out) => (err ? reject(err) : resolve(out)),
    );
    streamifier.createReadStream(file.buffer).pipe(stream);
  });
  return {
    kind: PurchaseRequest.FILE_KINDS.includes(kind) ? kind : "other",
    fileName: originalName, fileUrl: result.secure_url, fileType: file.mimetype, uploadedAt: new Date(), uploadedBy,
  };
};
/** ชนิดไฟล์รายไฟล์ส่งมาเป็น fileKinds[] เรียงตรงกับ files[] */
const attachUploads = async (req, doc, me, fallback) => {
  const raw = req.body?.fileKinds;
  const kinds = Array.isArray(raw) ? raw : (typeof raw === "string" && raw ? [raw] : []);
  for (const [i, f] of (req.files || []).entries()) {
    // eslint-disable-next-line no-await-in-loop -- อัปทีละไฟล์ ไม่ให้กิน RAM พร้อมกัน
    doc.attachments.push(await uploadToCloud(f, `purchase/${doc._id}`, me.name, kinds[i] || fallback));
  }
};

/** ผู้กดติ๊กใช้ลายเซ็นไหม (ไม่ส่งมา = ใช้) */
const wantsSignature = (req) => {
  const v = req.body?.useSignature;
  return !(v === false || v === "false" || v === "0" || v === 0);
};
/** ผนึกลายเซ็นของ "ผู้กดเอง" ลงช่องที่กำหนด — ⚠️ ห้ามผนึกให้คนอื่น */
const sealSlot = async (req, doc, slot) => {
  if (!wantsSignature(req)) return;
  const seal = await sealFor(req.userId, { name: fullNameOf(req.user), position: titleOf(req.user) });
  if (seal) doc.set(`signatures.${slot}`, seal);
};
const EMPTY_SEAL = { userId: "", name: "", position: "", signedAt: null, hash: "" };

// ── ขอบเขต/สิทธิ์ ──────────────────────────────────────────────────────
const canUse = (req) => can(req.user, "requestExpense") || can(req.user, "viewAllExpenses");
const canPurchase = (req) => can(req.user, "viewAllExpenses");
const scopeFor = (req) => {
  if (can(req.user, "viewAllExpenses")) return {};
  const uid = String(req.userId || "");
  return { $or: [{ "requester.userId": uid }, { "createdBy.userId": uid }] };
};
const isOwner = (req, doc) => {
  const uid = String(req.userId || "");
  return doc.requester?.userId === uid || doc.createdBy?.userId === uid;
};
const selfBlocked = (req, doc) => doc.requester?.userId === String(req.userId || "") && !can(req.user, "approveOwnExpense");

// ── แจ้งเตือน ─────────────────────────────────────────────────────────
const notifyUsers = (ids, me, payload) => {
  const targets = [...new Set((ids || []).filter(Boolean).map(String))].filter((id) => id !== me.userId);
  if (targets.length) sendPushToUsers(targets, payload).catch((e) => console.error("push pr:", e.message));
};
const notifyCap = async (cap, me, payload) => {
  try {
    const ranks = effectiveCapabilities()[cap] || CAPABILITIES[cap] || [];
    const users = await User.find(rankFilter(ranks)).select("_id").lean();
    notifyUsers(users.map((u) => String(u._id)), me, payload);
  } catch (e) {
    console.error(`push pr ${cap}:`, e.message);
  }
};
const urlOf = (doc) => `/purchase/${doc._id}`;
const line1 = (doc) => `${doc.docNo} · ${doc.subject}${doc.priority !== "normal" ? ` · ${PRIORITY_TH[doc.priority]}` : ""}`;

// ══ path ตายตัว ══════════════════════════════════════════════════════════════

router.get("/summary", verifyToken, async (req, res) => {
  try {
    if (!canUse(req)) return res.status(403).json({ message: "คุณไม่มีสิทธิ์ใช้งานระบบขอซื้อ" });
    const scope = scopeFor(req);
    const uid = String(req.userId || "");
    const notMine = can(req.user, "approveOwnExpense") ? {} : { "requester.userId": { $ne: uid } };
    const mine = { $or: [{ "requester.userId": uid }, { "createdBy.userId": uid }] };
    const [pending, reviewing, toOrder, toReceive, rejectedMine, inboxReview, inboxApprove] = await Promise.all([
      PurchaseRequest.countDocuments({ ...scope, status: "pending" }),
      PurchaseRequest.countDocuments({ ...scope, status: "reviewed" }),
      PurchaseRequest.countDocuments({ ...scope, status: "approved" }),
      PurchaseRequest.countDocuments({ ...scope, status: { $in: ["ordered", "partial"] } }),
      PurchaseRequest.countDocuments({ ...mine, status: "rejected" }),
      can(req.user, "reviewExpense") ? PurchaseRequest.countDocuments({ ...notMine, status: "pending" }) : 0,
      can(req.user, "approveExpense")
        ? PurchaseRequest.countDocuments({ ...notMine, status: "reviewed", ...(can(req.user, "approveOwnReview") ? {} : { "reviewedBy.userId": { $ne: uid } }) })
        : 0,
    ]);
    const inboxOrder = canPurchase(req) ? toOrder : 0;
    res.json({ pending, reviewing, toOrder, toReceive, rejectedMine, inbox: inboxReview + inboxApprove + inboxOrder });
  } catch (err) {
    console.error("❌ สรุป PR ไม่สำเร็จ:", err);
    res.status(500).json({ message: "ดึงสรุปไม่สำเร็จ" });
  }
});

/** ค่าที่เคยใช้ — ร้านค้า · หน่วย · สถานที่ส่ง · รายการสินค้าที่เคยขอ (พร้อมราคาล่าสุด) */
router.get("/suggest", verifyToken, async (req, res) => {
  try {
    if (!canUse(req)) return res.status(403).json({ message: "คุณไม่มีสิทธิ์ใช้งานระบบขอซื้อ" });
    const recent = await PurchaseRequest.find({ status: { $ne: "cancelled" } })
      .select("suggestedSupplier order.supplier deliverTo items.description items.spec items.unit items.estUnitPrice items.actualUnitPrice")
      .sort({ createdAt: -1 }).limit(300).lean();
    const uniq = (arr) => [...new Set(arr.map((x) => String(x || "").trim()).filter(Boolean))];
    const products = new Map();
    recent.forEach((d) => d.items.forEach((it) => {
      const key = it.description.toLowerCase();
      if (!products.has(key)) products.set(key, { description: it.description, spec: it.spec, unit: it.unit, lastPrice: it.actualUnitPrice ?? it.estUnitPrice ?? 0 });
    }));
    res.json({
      suppliers: uniq(recent.flatMap((d) => [d.order?.supplier, d.suggestedSupplier])).slice(0, 50),
      deliverTo: uniq(recent.map((d) => d.deliverTo)).slice(0, 20),
      units: uniq(["ชิ้น", "ตัว", "เครื่อง", "ชุด", "อัน", "ม้วน", "เมตร", "กล่อง", "แพ็ค", "ถุง", "เส้น", "ลูก", ...recent.flatMap((d) => d.items.map((i) => i.unit))]).slice(0, 40),
      products: [...products.values()].slice(0, 300),
    });
  } catch (err) {
    console.error("❌ ดึงค่าแนะนำ PR ไม่สำเร็จ:", err);
    res.status(500).json({ message: "ดึงค่าแนะนำไม่สำเร็จ" });
  }
});

router.get("/", verifyToken, async (req, res) => {
  try {
    if (!canUse(req)) return res.status(403).json({ message: "คุณไม่มีสิทธิ์ใช้งานระบบขอซื้อ" });
    const query = { ...scopeFor(req) };
    const statuses = String(req.query.status || "").split(",").filter((s) => PurchaseRequest.STATUS.includes(s));
    if (statuses.length) query.status = { $in: statuses };
    if (req.query.eventId && isId(req.query.eventId)) query.eventId = String(req.query.eventId);
    const docs = await PurchaseRequest.find(query).select("-activityLog").sort({ createdAt: -1 }).limit(1000).lean();
    res.json({ requests: docs });
  } catch (err) {
    console.error("❌ ดึงรายการ PR ไม่สำเร็จ:", err);
    res.status(500).json({ message: "ดึงรายการไม่สำเร็จ" });
  }
});

/** ออกใบขอซื้อ */
router.post("/", verifyToken, upload.array("files", 15), async (req, res) => {
  try {
    if (!canUse(req)) return res.status(403).json({ message: "คุณไม่มีสิทธิ์ออกใบขอซื้อ" });
    const me = actor(req);
    const subject = str(req.body.subject, 300);
    if (!subject) return res.status(400).json({ message: "กรุณาระบุเรื่องที่ขอซื้อ" });
    const items = sanitizeItems(req.body.items);
    if (!items.length) return res.status(400).json({ message: "กรุณาเพิ่มรายการสินค้าอย่างน้อย 1 รายการ" });
    if (items.some((it) => it.qty <= 0)) return res.status(400).json({ message: "จำนวนสินค้าต้องมากกว่า 0 ทุกรายการ" });
    const linked = await resolveJob(req.body.eventId);
    if (!linked) return res.status(400).json({ message: "ไม่พบงานที่เลือกผูก — อาจถูกลบไปแล้ว" });
    const doc = new PurchaseRequest({
      docNo: await nextDocNo(),
      status: "pending",
      docDate: parseDay(req.body.docDate) || todayNoonUtc(),
      subject,
      purpose: str(req.body.purpose, 1000),
      priority: PurchaseRequest.PRIORITIES.includes(req.body.priority) ? req.body.priority : "normal",
      neededBy: parseDay(req.body.neededBy),
      deliverTo: str(req.body.deliverTo, 300),
      suggestedSupplier: str(req.body.suggestedSupplier, 200),
      note: str(req.body.note, 1000),
      requester: { userId: me.userId, name: me.name, position: titleOf(req.user) },
      createdBy: me,
      ...linked,
      items,
      vatRate: Number(req.body.vatRate) === 7 ? 7 : 0,
      submittedAt: new Date(),
    });
    applyTotals(doc);
    await sealSlot(req, doc, "requester");
    await attachUploads(req, doc, me, "quotation");
    log(doc, "created", `ออกใบขอซื้อ ${items.length} รายการ · ประมาณการ ${fullBaht(doc.estTotal)}`, me);
    await saveWithDocNo(doc);
    notifyCap("reviewExpense", me, {
      title: `📝 รอตรวจสอบ · ใบขอซื้อ${doc.priority !== "normal" ? ` (${PRIORITY_TH[doc.priority]})` : ""}`,
      body: `${line1(doc)}\n${items.length} รายการ · ประมาณการ ${fullBaht(doc.estTotal)}\nขอโดย ${fullNameOf(req.user)}`,
      url: urlOf(doc), tag: `pr-${doc._id}`, renotify: true,
    });
    res.status(201).json({ request: doc.toObject() });
  } catch (err) {
    console.error("❌ ออกใบขอซื้อไม่สำเร็จ:", err);
    res.status(500).json({ message: "ออกใบขอซื้อไม่สำเร็จ" });
  }
});

// ══ /:id ══════════════════════════════════════════════════════════════════
const loadVisible = async (req, res) => {
  if (!isId(req.params.id)) { res.status(404).json({ message: "ไม่พบใบขอซื้อนี้" }); return null; }
  const doc = await PurchaseRequest.findById(req.params.id);
  if (!doc) { res.status(404).json({ message: "ไม่พบใบขอซื้อนี้" }); return null; }
  if (!can(req.user, "viewAllExpenses") && !isOwner(req, doc)) { res.status(403).json({ message: "คุณไม่มีสิทธิ์ดูใบขอซื้อนี้" }); return null; }
  return doc;
};

router.get("/:id", verifyToken, async (req, res) => {
  try {
    const doc = await loadVisible(req, res);
    if (doc) res.json({ request: doc.toObject() });
  } catch (err) {
    console.error("❌ ดึงใบขอซื้อไม่สำเร็จ:", err);
    res.status(500).json({ message: "ดึงใบขอซื้อไม่สำเร็จ" });
  }
});

/**
 * รูปลายเซ็นที่ผนึกไว้ในใบนี้ — ใช้ตอนสร้าง PDF
 * 🔒 คืนเฉพาะลายเซ็นที่ผนึกในใบนี้จริง และเฉพาะผู้ที่มีสิทธิ์เห็นใบ (เหมือน /api/expenses/:id/signatures)
 */
router.get("/:id/signatures", verifyToken, async (req, res) => {
  try {
    const doc = await loadVisible(req, res);
    if (!doc) return;
    const seals = { requester: doc.signatures?.requester, reviewer: doc.signatures?.reviewer, approver: doc.signatures?.approver, purchaser: doc.signatures?.purchaser };
    const images = await imagesFor(Object.values(seals));
    const out = {};
    Object.entries(seals).forEach(([role, seal]) => {
      const img = seal?.hash ? images.get(seal.hash) : null;
      if (img) out[role] = { image: img.image, width: img.width, height: img.height, name: seal.name, position: seal.position, signedAt: seal.signedAt };
    });
    res.json({ signatures: out });
  } catch (err) {
    console.error("❌ ดึงลายเซ็นใบขอซื้อไม่สำเร็จ:", err);
    res.status(500).json({ message: "ดึงลายเซ็นไม่สำเร็จ" });
  }
});

router.put("/:id", verifyToken, upload.array("files", 15), async (req, res) => {
  try {
    const doc = await loadVisible(req, res);
    if (!doc) return;
    if (!["pending", "rejected"].includes(doc.status) || !(isOwner(req, doc) || can(req.user, "viewAllExpenses"))) {
      return res.status(409).json({ message: "แก้ไขได้เฉพาะใบที่รอตรวจสอบหรือถูกตีกลับ" });
    }
    const me = actor(req);
    const wasRejected = doc.status === "rejected";
    if (req.body.subject !== undefined) {
      const s = str(req.body.subject, 300);
      if (!s) return res.status(400).json({ message: "กรุณาระบุเรื่องที่ขอซื้อ" });
      doc.subject = s;
    }
    ["purpose", "deliverTo", "suggestedSupplier", "note"].forEach((f) => { if (req.body[f] !== undefined) doc[f] = str(req.body[f], f === "purpose" || f === "note" ? 1000 : 300); });
    if (req.body.priority !== undefined && PurchaseRequest.PRIORITIES.includes(req.body.priority)) doc.priority = req.body.priority;
    if (req.body.neededBy !== undefined) doc.neededBy = parseDay(req.body.neededBy);
    if (req.body.docDate !== undefined) doc.docDate = parseDay(req.body.docDate) || doc.docDate;
    if (req.body.vatRate !== undefined) doc.vatRate = Number(req.body.vatRate) === 7 ? 7 : 0;
    if (req.body.eventId !== undefined) {
      const linked = await resolveJob(req.body.eventId);
      if (!linked) return res.status(400).json({ message: "ไม่พบงานที่เลือกผูก" });
      doc.eventId = linked.eventId; doc.job = linked.job;
    }
    if (req.body.items !== undefined) {
      const items = sanitizeItems(req.body.items, doc.items);
      if (!items.length) return res.status(400).json({ message: "กรุณาเพิ่มรายการสินค้าอย่างน้อย 1 รายการ" });
      if (items.some((it) => it.qty <= 0)) return res.status(400).json({ message: "จำนวนสินค้าต้องมากกว่า 0 ทุกรายการ" });
      doc.items = items;
    }
    applyTotals(doc);
    await attachUploads(req, doc, me, "quotation");
    // ลายเซ็นผู้ขอ: ติ๊กไม่ใช้ = ถอดออก · ส่งใหม่หลังตีกลับ = ผนึกใหม่ (เนื้อหาเปลี่ยน)
    if (doc.requester?.userId === me.userId && req.body.useSignature !== undefined) {
      if (!wantsSignature(req)) doc.set("signatures.requester", EMPTY_SEAL);
      else if (wasRejected || !doc.signatures?.requester?.hash) await sealSlot(req, doc, "requester");
    }
    if (wasRejected) {
      doc.status = "pending"; doc.submittedAt = new Date(); doc.rejectReason = "";
      log(doc, "resubmitted", `แก้ไขและส่งใหม่ · ประมาณการ ${fullBaht(doc.estTotal)}`, me);
    } else {
      log(doc, "updated", `แก้ไขใบ · ประมาณการ ${fullBaht(doc.estTotal)}`, me);
    }
    await doc.save();
    if (wasRejected) notifyCap("reviewExpense", me, { title: "📝 รอตรวจสอบ · ใบขอซื้อ (ส่งใหม่)", body: line1(doc), url: urlOf(doc), tag: `pr-${doc._id}`, renotify: true });
    res.json({ request: doc.toObject() });
  } catch (err) {
    console.error("❌ แก้ไขใบขอซื้อไม่สำเร็จ:", err);
    res.status(500).json({ message: "แก้ไขไม่สำเร็จ" });
  }
});

router.post("/:id/review", verifyToken, async (req, res) => {
  try {
    if (!can(req.user, "reviewExpense")) return res.status(403).json({ message: "คุณไม่มีสิทธิ์ตรวจสอบใบขอซื้อ" });
    const doc = await loadVisible(req, res);
    if (!doc) return;
    if (doc.status !== "pending") return res.status(409).json({ message: "ตรวจสอบได้เฉพาะใบที่รอตรวจสอบ" });
    if (selfBlocked(req, doc)) return res.status(403).json({ message: "ตรวจสอบใบของตัวเองไม่ได้" });
    const me = actor(req);
    const note = str(req.body?.note, 500);
    doc.status = "reviewed"; doc.reviewedBy = me; doc.reviewedAt = new Date();
    await sealSlot(req, doc, "reviewer");
    log(doc, "reviewed", `ตรวจสอบแล้ว${note ? ` · ${note}` : ""}`, me);
    await doc.save();
    notifyCap("approveExpense", me, { title: "🔎 รออนุมัติ · ใบขอซื้อ", body: `${line1(doc)}\nประมาณการ ${fullBaht(doc.estTotal)}\nตรวจสอบโดย ${fullNameOf(req.user)}`, url: urlOf(doc), tag: `pr-${doc._id}`, renotify: true });
    res.json({ request: doc.toObject() });
  } catch (err) {
    console.error("❌ ตรวจสอบใบขอซื้อไม่สำเร็จ:", err);
    res.status(500).json({ message: "ตรวจสอบไม่สำเร็จ" });
  }
});

router.post("/:id/approve", verifyToken, async (req, res) => {
  try {
    if (!can(req.user, "approveExpense")) return res.status(403).json({ message: "คุณไม่มีสิทธิ์อนุมัติใบขอซื้อ" });
    const doc = await loadVisible(req, res);
    if (!doc) return;
    if (doc.status !== "reviewed") return res.status(409).json({ message: doc.status === "pending" ? "ใบนี้ยังไม่ผ่านการตรวจสอบ" : "อนุมัติได้เฉพาะใบที่ตรวจสอบแล้ว" });
    if (selfBlocked(req, doc)) return res.status(403).json({ message: "อนุมัติใบของตัวเองไม่ได้" });
    if (doc.reviewedBy?.userId === String(req.userId) && !can(req.user, "approveOwnReview")) {
      return res.status(403).json({ message: "คุณเป็นผู้ตรวจสอบใบนี้แล้ว — ให้หัวหน้าท่านอื่นอนุมัติ" });
    }
    const me = actor(req);
    const note = str(req.body?.note, 500);
    doc.status = "approved"; doc.approvedBy = me; doc.approvedAt = new Date();
    await sealSlot(req, doc, "approver");
    log(doc, "approved", `อนุมัติ · ประมาณการ ${fullBaht(doc.estTotal)}${note ? ` · ${note}` : ""}`, me);
    await doc.save();
    notifyUsers([doc.requester.userId, doc.createdBy.userId], me, { title: "✅ ใบขอซื้อได้รับอนุมัติ", body: `${line1(doc)}\nรอฝ่ายจัดซื้อสั่งซื้อ`, url: urlOf(doc), tag: `pr-${doc._id}` });
    notifyCap("viewAllExpenses", me, { title: "🛒 รอสั่งซื้อ · ใบขอซื้ออนุมัติแล้ว", body: `${line1(doc)}\n${doc.items.length} รายการ${doc.neededBy ? ` · ต้องการภายใน ${moment(doc.neededBy).format("D/M/YYYY")}` : ""}`, url: urlOf(doc), tag: `pr-${doc._id}`, renotify: true });
    res.json({ request: doc.toObject() });
  } catch (err) {
    console.error("❌ อนุมัติใบขอซื้อไม่สำเร็จ:", err);
    res.status(500).json({ message: "อนุมัติไม่สำเร็จ" });
  }
});

router.post("/:id/reject", verifyToken, async (req, res) => {
  try {
    const doc = await loadVisible(req, res);
    if (!doc) return;
    const cap = { pending: "reviewExpense", reviewed: "approveExpense", approved: "viewAllExpenses" }[doc.status];
    if (!cap || !can(req.user, cap)) return res.status(403).json({ message: "คุณตีกลับใบนี้ในขั้นนี้ไม่ได้" });
    const reason = str(req.body?.reason, 500);
    if (!reason) return res.status(400).json({ message: "กรุณาระบุเหตุผลที่ตีกลับ" });
    const me = actor(req);
    doc.status = "rejected";
    doc.reviewedBy = { userId: "", name: "" }; doc.reviewedAt = null;
    doc.approvedBy = { userId: "", name: "" }; doc.approvedAt = null;
    doc.rejectedBy = me; doc.rejectedAt = new Date(); doc.rejectReason = reason;
    // ⚠️ ตีกลับ = เนื้อหาจะถูกแก้ ลายเซ็นผู้ตรวจสอบ/ผู้อนุมัติของเนื้อหาเดิมใช้ไม่ได้อีก
    doc.set("signatures.reviewer", EMPTY_SEAL);
    doc.set("signatures.approver", EMPTY_SEAL);
    log(doc, "rejected", `ตีกลับ · ${reason}`, me);
    await doc.save();
    notifyUsers([doc.requester.userId, doc.createdBy.userId], me, { title: "↩️ ใบขอซื้อถูกตีกลับ", body: `${doc.docNo}\nเหตุผล: ${reason}`, url: urlOf(doc), tag: `pr-${doc._id}`, renotify: true });
    res.json({ request: doc.toObject() });
  } catch (err) {
    console.error("❌ ตีกลับใบขอซื้อไม่สำเร็จ:", err);
    res.status(500).json({ message: "ตีกลับไม่สำเร็จ" });
  }
});

/**
 * ฝ่ายจัดซื้อบันทึก "สั่งซื้อแล้ว" — ร้านค้า · เลขที่ PO · ราคาจริงรายรายการ · กำหนดส่ง · แนบใบสั่งซื้อ/ใบเสนอราคา
 * ✅ แก้ข้อมูลการสั่งซื้อซ้ำได้จนกว่าจะรับของครบ (เช่น ได้เลข PO ทีหลัง)
 */
router.post("/:id/order", verifyToken, upload.array("files", 10), async (req, res) => {
  try {
    if (!canPurchase(req)) return res.status(403).json({ message: "เฉพาะฝ่ายจัดซื้อ/ผู้จัดการเท่านั้นที่บันทึกการสั่งซื้อได้" });
    const doc = await loadVisible(req, res);
    if (!doc) return;
    if (!["approved", "ordered", "partial"].includes(doc.status)) return res.status(409).json({ message: "บันทึกการสั่งซื้อได้เฉพาะใบที่อนุมัติแล้ว" });
    const supplier = str(req.body.supplier, 200);
    if (!supplier) return res.status(400).json({ message: "กรุณาระบุร้านค้า/ผู้ขาย" });
    const me = actor(req);
    const prices = parseJson(req.body.prices) || {};
    doc.items.forEach((it) => {
      const p = prices[String(it._id)];
      if (p === undefined || p === null || p === "") return;
      const v = money(Math.max(Number(p) || 0, 0));
      it.actualUnitPrice = v;
      it.actualAmount = money(v * it.qty);
    });
    if (req.body.vatRate !== undefined) doc.vatRate = Number(req.body.vatRate) === 7 ? 7 : 0;
    const first = !doc.order?.orderedAt;
    doc.order = {
      supplier, supplierContact: str(req.body.supplierContact, 200), poNo: str(req.body.poNo, 60),
      orderedAt: parseDay(req.body.orderedAt) || doc.order?.orderedAt || todayNoonUtc(),
      expectedAt: parseDay(req.body.expectedAt), by: me, note: str(req.body.note, 500),
    };
    if (doc.status === "approved") doc.status = "ordered";
    if (first || req.body.useSignature !== undefined) {
      if (wantsSignature(req)) await sealSlot(req, doc, "purchaser"); else doc.set("signatures.purchaser", EMPTY_SEAL);
    }
    applyTotals(doc);
    await attachUploads(req, doc, me, "po");
    log(doc, first ? "ordered" : "order_updated", `${first ? "สั่งซื้อแล้ว" : "แก้ข้อมูลการสั่งซื้อ"} · ${supplier}${doc.order.poNo ? ` · PO ${doc.order.poNo}` : ""}${doc.actualTotal ? ` · ${fullBaht(doc.actualTotal)}` : ""}`, me);
    await doc.save();
    if (first) {
      notifyUsers([doc.requester.userId, doc.createdBy.userId], me, {
        title: "🛒 สั่งซื้อแล้ว · รอรับของ",
        body: `${line1(doc)}\nร้าน ${supplier}${doc.order.expectedAt ? ` · กำหนดส่ง ${moment(doc.order.expectedAt).format("D/M/YYYY")}` : ""}`,
        url: urlOf(doc), tag: `pr-${doc._id}`,
      });
    }
    res.json({ request: doc.toObject() });
  } catch (err) {
    console.error("❌ บันทึกการสั่งซื้อไม่สำเร็จ:", err);
    res.status(500).json({ message: "บันทึกการสั่งซื้อไม่สำเร็จ" });
  }
});

/**
 * รับของ — รับได้ทีละส่วน · ครบทุกรายการ = รับครบ (ปิดใบ)
 * ⚠️ รับเกินจำนวนที่สั่งไม่ได้ (กันนับซ้ำ)
 */
router.post("/:id/receive", verifyToken, upload.array("files", 10), async (req, res) => {
  try {
    const doc = await loadVisible(req, res);
    if (!doc) return;
    if (!(isOwner(req, doc) || canPurchase(req))) return res.status(403).json({ message: "คุณไม่มีสิทธิ์บันทึกรับของของใบนี้" });
    if (!["ordered", "partial"].includes(doc.status)) return res.status(409).json({ message: "บันทึกรับของได้หลังจากสั่งซื้อแล้วเท่านั้น" });
    const lines = (parseJson(req.body.lines) || []).map((l) => ({ itemId: String(l?.itemId || ""), qty: Math.max(Number(l?.qty) || 0, 0) })).filter((l) => l.qty > 0);
    if (!lines.length) return res.status(400).json({ message: "กรุณาระบุจำนวนที่รับอย่างน้อย 1 รายการ" });
    for (const l of lines) {
      const it = doc.items.id(l.itemId);
      if (!it) return res.status(400).json({ message: "ไม่พบรายการสินค้าที่ระบุ" });
      if (it.receivedQty + l.qty > it.qty + 1e-9) return res.status(400).json({ message: `${it.description}: รับเกินจำนวนที่ขอ (ขอ ${it.qty} · รับแล้ว ${it.receivedQty})` });
    }
    const me = actor(req);
    lines.forEach((l) => { const it = doc.items.id(l.itemId); it.receivedQty = Math.round((it.receivedQty + l.qty) * 1000) / 1000; });
    const note = str(req.body.note, 500);
    doc.receipts.push({ at: parseDay(req.body.receivedAt) || new Date(), by: me, note, lines: lines.map((l) => ({ ...l, description: doc.items.id(l.itemId).description })) });
    const done = doc.items.every((it) => it.receivedQty >= it.qty - 1e-9);
    doc.status = done ? "received" : "partial";
    if (done) doc.receivedAt = new Date();
    await attachUploads(req, doc, me, "delivery");
    log(doc, done ? "received" : "partial", `${done ? "รับของครบ · ปิดใบ" : "รับของบางส่วน"} (${lines.length} รายการ)${note ? ` · ${note}` : ""}`, me);
    await doc.save();
    notifyUsers([doc.requester.userId, doc.createdBy.userId, doc.order?.by?.userId], me, {
      title: done ? "📦 รับของครบแล้ว · ปิดใบขอซื้อ" : "📦 รับของบางส่วนแล้ว",
      body: line1(doc), url: urlOf(doc), tag: `pr-${doc._id}`,
    });
    res.json({ request: doc.toObject() });
  } catch (err) {
    console.error("❌ บันทึกรับของไม่สำเร็จ:", err);
    res.status(500).json({ message: "บันทึกรับของไม่สำเร็จ" });
  }
});

router.post("/:id/cancel", verifyToken, async (req, res) => {
  try {
    const doc = await loadVisible(req, res);
    if (!doc) return;
    const ownerCan = isOwner(req, doc) && ["pending", "rejected"].includes(doc.status);
    const mgrCan = ["pending", "rejected", "reviewed", "approved", "ordered"].includes(doc.status) && (can(req.user, "approveExpense") || canPurchase(req));
    if (!ownerCan && !mgrCan) return res.status(409).json({ message: "ใบนี้ยกเลิกไม่ได้แล้ว (รับของไปแล้ว)" });
    const me = actor(req);
    const reason = str(req.body?.reason, 500);
    doc.status = "cancelled"; doc.cancelledBy = me; doc.cancelledAt = new Date(); doc.cancelReason = reason;
    log(doc, "cancelled", `ยกเลิก${reason ? ` · ${reason}` : ""}`, me);
    await doc.save();
    notifyUsers([doc.requester.userId, doc.createdBy.userId], me, { title: "🚫 ใบขอซื้อถูกยกเลิก", body: `${doc.docNo}${reason ? ` · ${reason}` : ""}`, url: urlOf(doc), tag: `pr-${doc._id}` });
    res.json({ request: doc.toObject() });
  } catch (err) {
    console.error("❌ ยกเลิกใบขอซื้อไม่สำเร็จ:", err);
    res.status(500).json({ message: "ยกเลิกไม่สำเร็จ" });
  }
});

router.post("/:id/files", verifyToken, upload.array("files", 10), async (req, res) => {
  try {
    const doc = await loadVisible(req, res);
    if (!doc) return;
    if (doc.status === "cancelled") return res.status(409).json({ message: "ใบที่ยกเลิกแล้วแนบไฟล์ไม่ได้" });
    if (!req.files?.length) return res.status(400).json({ message: "กรุณาเลือกไฟล์" });
    const me = actor(req);
    await attachUploads(req, doc, me, "other");
    log(doc, "files_added", `แนบไฟล์ ${req.files.length} ไฟล์`, me);
    await doc.save();
    res.json({ request: doc.toObject() });
  } catch (err) {
    console.error("❌ แนบไฟล์ใบขอซื้อไม่สำเร็จ:", err);
    res.status(500).json({ message: "แนบไฟล์ไม่สำเร็จ" });
  }
});

router.delete("/:id/files/:fileId", verifyToken, async (req, res) => {
  try {
    const doc = await loadVisible(req, res);
    if (!doc) return;
    const allowed = canPurchase(req) ? doc.status !== "cancelled" : isOwner(req, doc) && ["pending", "rejected"].includes(doc.status);
    if (!allowed) return res.status(409).json({ message: "ลบไฟล์ในใบนี้ไม่ได้แล้ว" });
    const f = doc.attachments.id(req.params.fileId);
    if (!f) return res.status(404).json({ message: "ไม่พบไฟล์" });
    const me = actor(req);
    const name = f.fileName;
    f.deleteOne();
    log(doc, "file_removed", `ลบไฟล์ ${name}`, me);
    await doc.save();
    res.json({ request: doc.toObject() });
  } catch (err) {
    console.error("❌ ลบไฟล์ใบขอซื้อไม่สำเร็จ:", err);
    res.status(500).json({ message: "ลบไฟล์ไม่สำเร็จ" });
  }
});

module.exports = router;
