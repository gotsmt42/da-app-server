/**
 * /api/expenses — ใบเบิกเงินล่วงหน้า (Advance) และใบเคลียร์ค่าใช้จ่าย (Claim)
 *
 * สายงาน (ตามที่ผู้ใช้เลือก):
 *   ช่างออกใบ Advance ของตัวเอง (หรือแอดมิน/ผู้จัดการออกแทน) → หัวหน้าอนุมัติ → บันทึกจ่ายเงิน →
 *   ผู้เบิกออกใบเคลมอ้างใบ Advance พร้อมใบเสร็จ → หัวหน้าอนุมัติ → ชำระส่วนต่าง (คืน/จ่ายเพิ่ม) → จบ
 *
 * ⚠️ **ลำดับ route ห้ามสลับ** — path ตายตัว (/summary, /report, /people, /jobs, /suggest,
 * /advances, /claims) ต้องมาก่อน /:id ทั้งหมด ไม่งั้นจะถูกกลืนเงียบๆ กลายเป็นการหาใบที่ id ชื่อ
 * "summary" (ตรวจด้วย `npm run check:routes`)
 *
 * ⚠️ ยอดเงินทุกตัวคำนวณที่ server เสมอ (qty × ราคาต่อหน่วย → รวม → ส่วนต่าง) ไม่เชื่อค่าที่ client ส่งมา —
 * นี่คือเอกสารการเงิน ถ้าเชื่อยอดจากหน้าจอ ใครแก้ request เองก็เบิกเกินรายการได้ทันที
 */
const crypto = require("crypto");
const express = require("express");
const moment = require("moment");
const multer = require("multer");
const streamifier = require("streamifier");

const Expense = require("../models/Expense");
const User = require("../models/User");
const CalendarEvent = require("../models/Events");
const DocCounter = require("../models/DocCounter");
const verifyToken = require("../middleware/auth");
const { can, ROLE_LABEL, SUPERVISOR_ROLES, DEPARTMENT } = require("../config/roles");
const { cloudinary } = require("../config/cloudinary");
const { fileFilter, limits } = require("../config/upload");
const { sendPushToUsers } = require("../services/PushNotify");
const { thaiDate } = require("../utils/thaiDate");
const { effectiveResponsibleOrClauses } = require("./calendarEvent/shared");

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), fileFilter, limits });

// ══ ตัวช่วย ══════════════════════════════════════════════════════════════════

/**
 * ชื่อที่ใช้อ้างถึงคน = ชื่อต้นอย่างเดียว ตามแบบแผนทั้งระบบ (ดูเหตุผลเต็มที่ personName ใน routes/dispatch.js)
 * ⚠️ การจับคู่คนในระบบนี้ใช้ userId เสมอ ชื่อมีไว้แสดงผลเท่านั้น
 */
const personName = (u) => String(u?.fname || "").trim() || u?.username || "ไม่ทราบชื่อ";

const actor = (req) => ({
  userId: String(req.user?._id || req.userId || ""),
  name: personName(req.user),
  role: String(req.user?.role || ""),
});

/** ตำแหน่งเริ่มต้น = ตำแหน่งในทะเบียนพนักงาน (rank) ถ้าไม่มีใช้ชื่อบทบาทภาษาไทย */
const positionOf = (u) =>
  String(u?.rank || "").trim() || ROLE_LABEL[String(u?.role || "").toLowerCase()] || "";

const buddhistYear = () => new Date().getFullYear() + 543;

/**
 * ชุดเลขที่เอกสาร — คนละชุดกันทั้งสามแบบ (ฝ่ายบัญชีต้องแยกออกจากกันตั้งแต่เลขที่ใบ)
 * ⚠️ "reimburse" ไม่ใช่ kind ในฐานข้อมูล แต่เป็นชนิดย่อยของ claim (claimType) — ทุกที่ที่ต้องรู้ว่า
 * ใบนี้อยู่ชุดไหนให้เรียก seriesOf(doc) ห้ามอ่าน doc.kind ตรงๆ ไม่งั้นใบสำรองจ่ายจะไปกินเลขชุด CLM
 */
const DOC_PREFIX = { advance: "ADV", claim: "CLM", reimburse: "RMB" };
const KIND_LABEL = { advance: "ใบเบิก Advance", claim: "ใบเคลม", reimburse: "ใบเบิกค่าใช้จ่าย (สำรองจ่าย)" };

const seriesOf = (doc) => (doc?.kind === "claim" && doc?.claimType === "reimburse" ? "reimburse" : doc?.kind);
const labelOf = (doc) => KIND_LABEL[seriesOf(doc)] || "ใบเบิก";
/** ใบที่ผู้เบิกสำรองจ่ายเอง (ไม่มี Advance) — บริษัทต้องจ่ายคืนเต็มยอด */
const isReimburse = (doc) => seriesOf(doc) === "reimburse";

const nextDocNo = async (series) => {
  const year = buddhistYear();
  const c = await DocCounter.findOneAndUpdate(
    { key: `${series}:${year}` },
    { $inc: { seq: 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
  return `${DOC_PREFIX[series]}-${String(c.seq).padStart(5, "0")}/${year}`;
};

/**
 * บันทึกใบใหม่ พร้อมกันเลขที่ชน
 * 🐛 เคยเกิดจริงระหว่างพัฒนา: ตัวนับ (DocCounter) ถูกรีเซ็ตทั้งที่มีใบเลข 00001 อยู่แล้ว → ใบถัดไปได้เลขซ้ำ
 * ชน unique index แล้วผู้ใช้เจอ "ออกใบเบิกไม่สำเร็จ" ทุกครั้งโดยแก้เองไม่ได้
 * ✅ ชนเลขเมื่อไร ขอเลขถัดไปแล้วลองใหม่ (ตัวนับเดินหน้าเองจนพ้นเลขที่มีอยู่) — ไม่มีทางได้เลขซ้ำเพราะ index กันไว้
 */
const saveWithDocNo = async (doc, series) => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      return await doc.save();
    } catch (err) {
      if (err?.code !== 11000 || !err?.keyPattern?.docNo) throw err;
      doc.docNo = await nextDocNo(series);
    }
  }
  throw new Error("ออกเลขที่เอกสารไม่สำเร็จ");
};

/** ปัดเป็นทศนิยม 2 ตำแหน่ง — กันเศษทศนิยมลอยตัว (0.1 + 0.2) โผล่ในเอกสารการเงิน */
const money = (n) => Math.round((Number(n) || 0) * 100) / 100;

const fullBaht = (n) =>
  `${money(n).toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} บาท`;

const MAX_QTY = 100000;
const MAX_UNIT_PRICE = 10_000_000;
const MAX_ITEMS = 60;

/**
 * รับวันที่แบบ "YYYY-MM-DD" แล้วเก็บเป็น 12:00 UTC ของวันนั้น
 * ⚠️ ไม่ใช้เที่ยงคืน — เที่ยงคืน UTC คือ 07:00 น. ไทย ส่วนเที่ยงคืนไทยคือวันก่อนหน้าในเวลา UTC
 * (เซิร์ฟเวอร์บน Render รันเป็น UTC) เวลาเที่ยงวันอยู่วันเดียวกันทั้งสองโซน เอกสาร/รายงาน/แจ้งเตือน
 * จึงเห็นวันที่ตรงกันเสมอ
 */
const parseDay = (raw) => {
  const s = String(raw || "").trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
};

const todayNoonUtc = () => parseDay(moment().utcOffset(7).format("YYYY-MM-DD"));

const parseJsonArray = (raw) => {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

/**
 * ทำความสะอาดรายการ + คำนวณยอดใหม่ทั้งหมด
 * ⚠️ แถวที่ไม่มีคำอธิบายถูกทิ้งเงียบๆ (แถวว่างที่ผู้ใช้กดเพิ่มแล้วไม่ได้กรอก) ไม่ใช่ error
 */
const sanitizeItems = (raw, kind) =>
  (parseJsonArray(raw) || [])
    .slice(0, MAX_ITEMS)
    .map((it) => {
      const qty = Math.min(Math.max(Number(it?.qty) || 0, 0), MAX_QTY);
      const unitPrice = Math.min(Math.max(Number(it?.unitPrice) || 0, 0), MAX_UNIT_PRICE);
      const idx = Number(it?.advanceItemIndex);
      return {
        category: Expense.CATEGORIES.includes(it?.category) ? it.category : "other",
        description: String(it?.description || "").trim().slice(0, 300),
        detail: String(it?.detail || "").trim().slice(0, 300),
        qty,
        unit: String(it?.unit || "").trim().slice(0, 30),
        unitPrice: money(unitPrice),
        amount: money(qty * unitPrice),
        advanceItemIndex: kind === "claim" && Number.isInteger(idx) && idx >= 0 ? idx : null,
        receiptNo: kind === "claim" ? String(it?.receiptNo || "").trim().slice(0, 60) : "",
      };
    })
    .filter((it) => it.description);

const sumItems = (items) => money(items.reduce((s, it) => s + (Number(it.amount) || 0), 0));

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * ✅ ขอบเขตข้อมูล — จุดเดียวที่ตัดสินว่าใครเห็นใบไหน
 *   • หัวหน้า (viewAllExpenses) เห็นทั้งหมด
 *   • คนอื่นเห็นเฉพาะใบที่ตัวเองเป็น "ผู้เบิก" หรือเป็น "คนออกใบ"
 * ⚠️ fail closed — ไม่เข้าเงื่อนไขไหนเลยต้องได้ผลว่าง ไม่ใช่เห็นทุกใบ
 */
const scopeFor = (req) => {
  if (can(req.user, "viewAllExpenses")) return {};
  const uid = String(req.userId || "");
  return { $or: [{ "requester.userId": uid }, { "createdBy.userId": uid }] };
};

const isOwner = (req, doc) => {
  const uid = String(req.userId || "");
  return String(doc?.requester?.userId || "") === uid || String(doc?.createdBy?.userId || "") === uid;
};

const canSee = (req, doc) => can(req.user, "viewAllExpenses") || isOwner(req, doc);

const EDITABLE = ["pending", "rejected"];
const canEdit = (req, doc) =>
  EDITABLE.includes(doc.status) && (isOwner(req, doc) || can(req.user, "viewAllExpenses"));

/**
 * ⚠️ อนุมัติใบของตัวเองไม่ได้ — หลักควบคุมภายในพื้นฐานของเอกสารการเงิน
 * ยกเว้นแอดมิน (manageAll) ซึ่งเป็นระดับสูงสุดของบริษัท ไม่มีใครเหนือกว่าให้อนุมัติแทนได้
 */
const blockSelfApproval = (req, doc) =>
  String(doc?.requester?.userId || "") === String(req.userId || "") && !can(req.user, "manageAll");

const log = (doc, action, detail, me) => {
  doc.activityLog = doc.activityLog || [];
  doc.activityLog.push({ action, detail, userId: me.userId, userName: me.name, timestamp: new Date() });
};

const uploadToCloud = async (file, folder, uploadedBy = "", kind = "other") => {
  const originalName = Buffer.from(file.originalname, "latin1").toString("utf8");
  const sanitized = originalName.replace(/[^\w\-.]/g, "_");
  const isImage = ["image/jpeg", "image/png", "image/webp"].includes(file.mimetype);
  const result = await new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        resource_type: isImage ? "image" : "raw",
        folder,
        public_id: `${Date.now()}_${isImage ? sanitized.replace(/\.[^.]+$/, "") : sanitized}`,
        use_filename: false, unique_filename: false, overwrite: true,
      },
      (err, uploaded) => (err ? reject(err) : resolve(uploaded))
    );
    streamifier.createReadStream(file.buffer).pipe(stream);
  });
  return {
    kind: Expense.FILE_KINDS.includes(kind) ? kind : "other",
    fileName: originalName,
    fileUrl: result.secure_url,
    fileType: file.mimetype,
    uploadedAt: new Date(),
    uploadedBy,
  };
};

/** ชนิดไฟล์ลำดับที่ i — ฝั่งจอส่งมาเป็น fileKinds[] เรียงตรงกับ files[] (multipart แนบ metadata รายไฟล์ไม่ได้) */
const fileKindAt = (req, i, fallback) => {
  const raw = req.body?.fileKinds;
  const arr = Array.isArray(raw) ? raw : (typeof raw === "string" && raw ? [raw] : []);
  return arr[i] || fallback;
};

const attachUploads = async (req, doc, me, fallbackKind) => {
  for (const [i, f] of (req.files || []).entries()) {
    doc.attachments.push(await uploadToCloud(f, `expenses/${doc._id}`, me.name, fileKindAt(req, i, fallbackKind)));
  }
};

/** snapshot งานที่ผูก — ตรวจกับของจริงเสมอ ห้ามเชื่อชื่องานที่ client ส่งมา */
const resolveJob = async (eventId) => {
  const id = String(eventId || "").trim();
  if (!id) return { eventId: "", job: { title: "", company: "", site: "", docNo: "", start: null } };
  if (!/^[a-f0-9]{24}$/i.test(id)) return null;
  const ev = await CalendarEvent.findById(id).select("title company site docNo start").lean();
  if (!ev) return null;
  return {
    eventId: id,
    job: { title: ev.title || "", company: ev.company || "", site: ev.site || "", docNo: ev.docNo || "", start: ev.start || null },
  };
};

const jobLabel = (doc) => [doc.job?.title, doc.job?.site].filter(Boolean).join(" · ");

/** แจ้งเตือนเฉพาะคน (ตัดคนที่เป็นผู้กระทำออกเสมอ — ไม่ต้องแจ้งตัวเองว่าตัวเองเพิ่งกดอะไร) */
const notifyUsers = (ids, me, payload) => {
  const targets = [...new Set((ids || []).filter(Boolean).map(String))].filter((id) => id !== me.userId);
  if (!targets.length) return;
  sendPushToUsers(targets, payload).catch((e) => console.error("push expense:", e.message));
};

/** แจ้งหัวหน้าทุกคน ยกเว้นคนที่เพิ่งกดเอง */
const notifySupervisors = async (me, payload) => {
  try {
    const users = await User.find({ role: { $in: SUPERVISOR_ROLES } }).select("_id").lean();
    notifyUsers(users.map((u) => String(u._id)), me, payload);
  } catch (e) {
    console.error("push expense supervisors:", e.message);
  }
};

const ownersOf = (doc) => [doc.requester?.userId, doc.createdBy?.userId];
const urlOf = (doc) => `/expenses/${doc._id}`;

const DEFAULT_CLEAR_DAYS = 7;

// ══ path ตายตัว (ต้องมาก่อน /:id) ══════════════════════════════════════════

/** ตัวเลขสรุปบนหัวหน้า — ใช้ทำ badge และการ์ดสรุป */
router.get("/summary", verifyToken, async (req, res) => {
  try {
    const scope = scopeFor(req);
    const now = new Date();
    // ✅ ใบของฉันที่ถูกตีกลับ — ใช้ทำป้ายตัวเลขบนเมนู "ใบ Advance"/"ใบเคลม" (งานที่ "ฉัน" ต้องแก้)
    // ⚠️ ต้องอิงตัวผู้ใช้เสมอ ไม่ใช่ scope ตามสิทธิ์ — หัวหน้าเห็นใบตีกลับของทุกคนใน scope แต่ใบที่
    // *เขา* ต้องแก้มีแค่ของตัวเอง ป้ายที่นับของคนอื่นด้วยจะกดเข้าไปแล้วไม่มีอะไรให้ทำ
    const mine = { $or: [{ "requester.userId": String(req.userId || "") }, { "createdBy.userId": String(req.userId || "") }] };
    const [pending, toPay, awaitingClaim, overdueClear, toSettle, outstanding, advanceRejectedMine, claimRejectedMine] = await Promise.all([
      Expense.countDocuments({ ...scope, status: "pending" }),
      Expense.countDocuments({ ...scope, kind: "advance", status: "approved" }),
      Expense.countDocuments({ ...scope, kind: "advance", status: "paid" }),
      Expense.countDocuments({ ...scope, kind: "advance", status: "paid", dueClearAt: { $lt: now } }),
      Expense.countDocuments({ ...scope, kind: "claim", status: "approved" }),
      Expense.aggregate([
        { $match: { ...scope, kind: "advance", status: { $in: ["paid", "clearing"] } } },
        { $group: { _id: null, total: { $sum: "$total" } } },
      ]),
      Expense.countDocuments({ ...mine, kind: "advance", status: "rejected" }),
      Expense.countDocuments({ ...mine, kind: "claim", status: "rejected" }),
    ]);
    res.json({
      pending, toPay, awaitingClaim, overdueClear, toSettle,
      advanceRejectedMine, claimRejectedMine,
      outstandingAmount: money(outstanding[0]?.total || 0),
    });
  } catch (err) {
    console.error("❌ สรุปใบเบิกไม่สำเร็จ:", err);
    res.status(500).json({ message: "ดึงสรุปไม่สำเร็จ" });
  }
});

/**
 * ข้อมูลรายงานย้อนหลัง — ใบ Advance ในช่วงเวลา พร้อมใบเคลมที่ผูกอยู่
 * ✅ รายงานยึด "ใบ Advance" เป็นแกน: ตั้งเบิก → จ่ายจริง → ใช้จริง → ส่วนต่าง อยู่แถวเดียวกันเสมอ
 * ถ้ากรองใบเคลมด้วยวันที่ของใบเคลมเอง ใบ Advance ปลายเดือนที่เคลียร์ต้นเดือนถัดไปจะถูกนับคนละช่วง
 * แล้วยอดคงค้างของทั้งสองเดือนผิดทั้งคู่
 * ⚠️ การสรุปยอดทำฝั่งหน้าจอ (buildExpenseReport) เพื่อให้เปลี่ยนตัวกรองได้ทันทีโดยไม่ต้องยิงใหม่
 */
router.get("/report", verifyToken, async (req, res) => {
  try {
    const query = { ...scopeFor(req), kind: "advance", status: { $ne: "cancelled" } };
    const from = parseDay(req.query.from);
    const to = parseDay(req.query.to);
    if (from || to) {
      query.docDate = {};
      if (from) query.docDate.$gte = new Date(from.getTime() - 12 * 3600 * 1000);
      if (to) query.docDate.$lte = new Date(to.getTime() + 12 * 3600 * 1000 - 1);
    }
    if (req.query.userId && can(req.user, "viewAllExpenses")) query["requester.userId"] = String(req.query.userId);
    // ✅ ใบสำรองจ่าย (ไม่มี Advance) เป็นเงินที่บริษัทจ่ายจริงเหมือนกัน ต้องอยู่ในรายงานด้วย ไม่งั้นยอด
    // ค่าใช้จ่ายรวมของเดือนจะขาดไปเงียบๆ — แยกเป็นคนละก้อนเพราะไม่มี "ตั้งเบิก/ส่วนต่าง" ให้เทียบ
    // ⚠️ ก้อนนี้กรองด้วยวันที่ของใบตัวเอง (ต่างจากใบเคลมที่ยึดวันของใบ Advance) เพราะเป็นใบตั้งต้นในตัวเอง

    const advances = await Expense.find(query)
      .select("-activityLog -attachments")
      .sort({ docDate: -1, createdAt: -1 })
      .lean();
    const ids = advances.map((a) => String(a._id));
    const claims = ids.length
      ? await Expense.find({ kind: "claim", advanceId: { $in: ids }, status: { $nin: ["cancelled"] } })
          .select("-activityLog -attachments")
          .sort({ createdAt: -1 })
          .lean()
      : [];
    // ใบเคลมที่ยังมีผลต่อใบ Advance = ใบล่าสุดที่ไม่ถูกยกเลิก (ใบที่ถูกตีกลับยังนับเป็น "กำลังเคลียร์")
    const claimByAdvance = new Map();
    claims.forEach((c) => { if (!claimByAdvance.has(c.advanceId)) claimByAdvance.set(c.advanceId, c); });
    const reimbursements = await Expense.find({ ...query, kind: "claim", claimType: "reimburse" })
      .select("-activityLog -attachments")
      .sort({ docDate: -1, createdAt: -1 })
      .lean();
    res.json({
      advances: advances.map((a) => ({ ...a, claim: claimByAdvance.get(String(a._id)) || null })),
      reimbursements,
    });
  } catch (err) {
    console.error("❌ ดึงรายงานการเบิกไม่สำเร็จ:", err);
    res.status(500).json({ message: "ดึงรายงานไม่สำเร็จ" });
  }
});

/** รายชื่อคนที่เบิกแทนได้ — เฉพาะหัวหน้า */
router.get("/people", verifyToken, async (req, res) => {
  try {
    if (!can(req.user, "viewAllExpenses")) {
      return res.status(403).json({ message: "เฉพาะแอดมิน/ผู้จัดการเท่านั้นที่เบิกแทนคนอื่นได้" });
    }
    const users = await User.find({}).select("fname lname username role rank imageUrl").sort({ fname: 1 }).lean();
    res.json({
      users: users.map((u) => ({
        userId: String(u._id),
        name: personName(u),
        fullName: [u.fname, u.lname].filter(Boolean).join(" ") || u.username,
        role: u.role || "",
        position: positionOf(u),
        imageUrl: u.imageUrl || "",
      })),
    });
  } catch (err) {
    console.error("❌ ดึงรายชื่อผู้เบิกไม่สำเร็จ:", err);
    res.status(500).json({ message: "ดึงรายชื่อไม่สำเร็จ" });
  }
});

/**
 * ค้นหางานเพื่อผูกกับใบเบิก
 * ⚠️ ขอบเขตเดียวกับหน้า "การดำเนินงาน" — ช่างผูกได้เฉพาะงานที่ตัวเองเกี่ยวข้อง ไม่ใช่ค้นทั้งบริษัท
 */
router.get("/jobs", verifyToken, async (req, res) => {
  try {
    const uid = String(req.userId || "");
    const fname = req.user?.fname || "";
    const base = { unscheduled: { $ne: true }, department: { $in: [DEPARTMENT.SERVICE, null] } };
    const and = [];
    if (!can(req.user, "viewAllJobs")) {
      and.push({ $or: [
        { userId: uid },
        ...effectiveResponsibleOrClauses(uid, fname),
        { team: fname }, { resPerson: uid }, { "teamMembers.userId": uid }, { "teamMembers.name": fname },
      ] });
    }
    const q = String(req.query.q || "").trim().slice(0, 80);
    if (q) {
      const rx = new RegExp(escapeRegex(q), "i");
      and.push({ $or: [{ title: rx }, { company: rx }, { site: rx }, { docNo: rx }, { system: rx }] });
    }
    const query = and.length ? { ...base, $and: and } : base;
    const jobs = await CalendarEvent.find(query)
      .select("title company site docNo system start end status")
      .sort({ start: -1 })
      .limit(40)
      .lean();
    res.json({ jobs });
  } catch (err) {
    console.error("❌ ค้นหางานไม่สำเร็จ:", err);
    res.status(500).json({ message: "ค้นหางานไม่สำเร็จ" });
  }
});

/** ค่าที่เคยกรอก — ช่อง "ถึง" ใช้ชื่อผู้มีอำนาจคนเดิมซ้ำเกือบทุกใบ ไม่ควรต้องพิมพ์ใหม่ทุกครั้ง */
router.get("/suggest", verifyToken, async (req, res) => {
  try {
    const recent = await Expense.find({ to: { $ne: "" } }).select("to").sort({ createdAt: -1 }).limit(200).lean();
    const to = [...new Set(recent.map((r) => r.to).filter(Boolean))].slice(0, 10);
    res.json({ to, position: positionOf(req.user), name: personName(req.user) });
  } catch (err) {
    console.error("❌ ดึงค่าแนะนำไม่สำเร็จ:", err);
    res.status(500).json({ message: "ดึงค่าแนะนำไม่สำเร็จ" });
  }
});

/** รายการใบ (กรองตามสิทธิ์) */
router.get("/", verifyToken, async (req, res) => {
  try {
    const query = { ...scopeFor(req) };
    if (Expense.KINDS.includes(req.query.kind)) query.kind = req.query.kind;
    // ✅ แยก "เคลียร์ Advance" ออกจาก "สำรองจ่ายเอง" ได้ที่หน้าใบเคลม
    // ⚠️ ใบเก่าที่ออกก่อนมีฟีเจอร์นี้ไม่มีฟิลด์ claimType เลย ต้องนับเป็น clear ด้วย ($ne: reimburse)
    // ไม่ใช่ {claimType: "clear"} ซึ่งจะทำให้ใบเก่าหายไปจากรายการทั้งหมด
    if (req.query.claimType === "reimburse") query.claimType = "reimburse";
    else if (req.query.claimType === "clear") query.claimType = { $ne: "reimburse" };
    const statuses = String(req.query.status || "").split(",").map((s) => s.trim()).filter((s) => Expense.STATUS.includes(s));
    if (statuses.length) query.status = { $in: statuses };
    if (req.query.userId && can(req.user, "viewAllExpenses")) query["requester.userId"] = String(req.query.userId);
    if (req.query.eventId) query.eventId = String(req.query.eventId);
    if (req.query.advanceId) query.advanceId = String(req.query.advanceId);
    const from = parseDay(req.query.from);
    const to = parseDay(req.query.to);
    if (from || to) {
      query.docDate = {};
      if (from) query.docDate.$gte = new Date(from.getTime() - 12 * 3600 * 1000);
      if (to) query.docDate.$lte = new Date(to.getTime() + 12 * 3600 * 1000 - 1);
    }
    const q = String(req.query.q || "").trim().slice(0, 80);
    const and = [];
    if (query.$or) { and.push({ $or: query.$or }); delete query.$or; }
    if (q) {
      const rx = new RegExp(escapeRegex(q), "i");
      and.push({ $or: [
        { docNo: rx }, { subject: rx }, { "requester.name": rx }, { "job.title": rx },
        { "job.site": rx }, { "job.company": rx }, { "advance.docNo": rx }, { "items.description": rx },
      ] });
    }
    if (and.length) query.$and = and;

    const limit = Math.min(Math.max(Number(req.query.limit) || 300, 1), 1000);
    const expenses = await Expense.find(query)
      .select("-activityLog")
      .sort({ docDate: -1, createdAt: -1 })
      .limit(limit)
      .lean();
    res.json({ expenses });
  } catch (err) {
    console.error("❌ ดึงรายการใบเบิกไม่สำเร็จ:", err);
    res.status(500).json({ message: "ดึงรายการไม่สำเร็จ" });
  }
});

/**
 * ออกใบ Advance
 * ✅ ช่างออกของตัวเอง · หัวหน้าเลือก "ผู้เบิก" เป็นคนอื่นได้ (requesterId)
 */
router.post("/advances", verifyToken, upload.array("files", 10), async (req, res) => {
  try {
    if (!can(req.user, "requestExpense")) {
      return res.status(403).json({ message: "คุณไม่มีสิทธิ์ออกใบเบิก" });
    }
    const me = actor(req);
    const subject = String(req.body.subject || "").trim().slice(0, 300);
    if (!subject) return res.status(400).json({ message: "กรุณาระบุเรื่องที่ขอเบิก" });

    const items = sanitizeItems(req.body.items, "advance");
    if (!items.length) return res.status(400).json({ message: "กรุณาเพิ่มรายการที่ขอเบิกอย่างน้อย 1 รายการ" });
    const total = sumItems(items);
    if (total <= 0) return res.status(400).json({ message: "ยอดขอเบิกต้องมากกว่า 0 บาท" });

    // ── ผู้เบิก ─────────────────────────────────────────────────────────
    let requesterUser = req.user;
    const requesterId = String(req.body.requesterId || "").trim();
    if (requesterId && requesterId !== me.userId) {
      if (!can(req.user, "viewAllExpenses")) {
        return res.status(403).json({ message: "เฉพาะแอดมิน/ผู้จัดการเท่านั้นที่เบิกแทนคนอื่นได้" });
      }
      requesterUser = /^[a-f0-9]{24}$/i.test(requesterId) ? await User.findById(requesterId).lean() : null;
      if (!requesterUser) return res.status(400).json({ message: "ไม่พบผู้เบิกที่เลือก" });
    }

    const linked = await resolveJob(req.body.eventId);
    if (!linked) return res.status(400).json({ message: "ไม่พบงานที่เลือกผูก — อาจถูกลบไปแล้ว" });

    const expense = new Expense({
      kind: "advance",
      docNo: await nextDocNo("advance"),
      status: "pending",
      docDate: parseDay(req.body.docDate) || todayNoonUtc(),
      to: String(req.body.to || "").trim().slice(0, 120),
      subject,
      note: String(req.body.note || "").trim().slice(0, 1000),
      requester: {
        userId: String(requesterUser._id),
        name: personName(requesterUser),
        position: String(req.body.position || "").trim().slice(0, 80) || positionOf(requesterUser),
      },
      createdBy: me,
      ...linked,
      items,
      total,
      dueClearAt: parseDay(req.body.dueClearAt),
      submittedAt: new Date(),
    });

    await attachUploads(req, expense, me, "other");
    const onBehalf = String(requesterUser._id) !== me.userId;
    log(expense, "created", `ออกใบเบิก Advance ${fullBaht(total)}${onBehalf ? ` แทน ${expense.requester.name}` : ""}`, me);
    await saveWithDocNo(expense, "advance");

    notifySupervisors(me, {
      title: `💵 ขออนุมัติเบิก Advance · ${expense.requester.name}`,
      body: [expense.docNo, subject, jobLabel(expense), fullBaht(total)].filter(Boolean).join(" · "),
      url: urlOf(expense),
      tag: `expense-${expense._id}`,
    });
    if (onBehalf) {
      notifyUsers([expense.requester.userId], me, {
        title: `💵 ${me.name} ออกใบเบิก Advance ให้คุณ`,
        body: `${expense.docNo} · ${subject} · ${fullBaht(total)}`,
        url: urlOf(expense),
        tag: `expense-${expense._id}`,
      });
    }

    res.status(201).json({ expense: expense.toObject() });
  } catch (err) {
    console.error("❌ ออกใบเบิก Advance ไม่สำเร็จ:", err);
    res.status(500).json({ message: "ออกใบเบิกไม่สำเร็จ" });
  }
});

/**
 * ออกใบเคลม — ต้องอ้างใบ Advance ที่ "จ่ายเงินแล้ว" เท่านั้น
 * ⚠️ 1 ใบ Advance มีใบเคลมที่ยังมีผลได้ใบเดียว — ถ้าถูกตีกลับให้แก้ใบเดิมแล้วส่งใหม่ ไม่ใช่ออกใบใหม่ซ้อน
 * (ไม่งั้นยอดใช้จริงจะถูกนับซ้ำในรายงาน)
 */
router.post("/claims", verifyToken, upload.array("files", 15), async (req, res) => {
  try {
    if (!can(req.user, "requestExpense") && !can(req.user, "viewAllExpenses")) {
      return res.status(403).json({ message: "คุณไม่มีสิทธิ์ออกใบเคลม" });
    }
    const me = actor(req);
    const advanceId = String(req.body.advanceId || "").trim();
    if (!/^[a-f0-9]{24}$/i.test(advanceId)) return res.status(400).json({ message: "กรุณาเลือกใบ Advance ที่ต้องการเคลียร์" });

    const advance = await Expense.findById(advanceId);
    if (!advance || advance.kind !== "advance") return res.status(404).json({ message: "ไม่พบใบ Advance ที่อ้างถึง" });
    if (!canSee(req, advance)) return res.status(403).json({ message: "คุณไม่มีสิทธิ์เคลียร์ใบ Advance นี้" });
    if (advance.status !== "paid") {
      const why = {
        pending: "ใบ Advance ยังไม่ได้รับอนุมัติ",
        rejected: "ใบ Advance ถูกตีกลับอยู่",
        approved: "ยังไม่ได้บันทึกการจ่ายเงิน Advance",
        clearing: `ใบ Advance นี้มีใบเคลม ${advance.claimDocNo || ""} อยู่แล้ว`,
        cleared: "ใบ Advance นี้เคลียร์เรียบร้อยแล้ว",
        cancelled: "ใบ Advance นี้ถูกยกเลิกแล้ว",
      }[advance.status];
      return res.status(409).json({ message: why || "ใบ Advance นี้ยังเคลียร์ไม่ได้" });
    }

    const items = sanitizeItems(req.body.items, "claim");
    const total = sumItems(items);
    const note = String(req.body.note || "").trim().slice(0, 1000);
    // ✅ ยอด 0 ได้ (ไม่ได้ใช้เงินเลย คืนทั้งก้อน) แต่ต้องมีคำอธิบาย ไม่งั้นผู้อนุมัติไม่รู้ว่าเกิดอะไรขึ้น
    if (!items.length && !note) {
      return res.status(400).json({ message: "กรุณาเพิ่มรายการที่ใช้จริง หรือระบุหมายเหตุหากไม่ได้ใช้เงินเลย" });
    }

    const claim = new Expense({
      kind: "claim",
      docNo: await nextDocNo("claim"),
      status: "pending",
      docDate: parseDay(req.body.docDate) || todayNoonUtc(),
      to: String(req.body.to || advance.to || "").trim().slice(0, 120),
      subject: String(req.body.subject || "").trim().slice(0, 300) || `เคลียร์ค่าใช้จ่าย ${advance.subject}`,
      note,
      // ⚠️ ผู้เบิกของใบเคลม = ผู้เบิกของใบ Advance เสมอ (คนที่รับเงินไปคือคนที่ต้องเคลียร์) เลือกเองไม่ได้
      requester: {
        userId: advance.requester.userId,
        name: advance.requester.name,
        position: String(req.body.position || "").trim().slice(0, 80) || advance.requester.position,
      },
      createdBy: me,
      eventId: advance.eventId,
      job: advance.job,
      items,
      total,
      advanceId: String(advance._id),
      advance: { docNo: advance.docNo, subject: advance.subject, total: advance.total, paidAt: advance.payment?.at || null },
      difference: money(total - advance.total),
      submittedAt: new Date(),
    });

    await attachUploads(req, claim, me, "receipt");
    log(claim, "created", `ออกใบเคลมอ้าง ${advance.docNo} · ใช้จริง ${fullBaht(total)}`, me);
    // ⚠️ บันทึกใบเคลมก่อน — เลขที่อาจถูกขยับตอนกันเลขชน ใบ Advance ต้องจำเลขที่ "ที่ได้จริง"
    await saveWithDocNo(claim, "claim");

    advance.status = "clearing";
    advance.claimId = String(claim._id);
    advance.claimDocNo = claim.docNo;
    log(advance, "claim_created", `ส่งใบเคลม ${claim.docNo} แล้ว`, me);
    await advance.save();

    const diff = claim.difference;
    notifySupervisors(me, {
      title: `🧾 ขออนุมัติใบเคลม · ${claim.requester.name}`,
      body: `${claim.docNo} อ้าง ${advance.docNo} · ใช้จริง ${fullBaht(total)}${diff ? ` · ${diff > 0 ? "จ่ายเพิ่ม" : "คืนเงิน"} ${fullBaht(Math.abs(diff))}` : ""}`,
      url: urlOf(claim),
      tag: `expense-${claim._id}`,
    });

    res.status(201).json({ expense: claim.toObject() });
  } catch (err) {
    console.error("❌ ออกใบเคลมไม่สำเร็จ:", err);
    res.status(500).json({ message: "ออกใบเคลมไม่สำเร็จ" });
  }
});


/**
 * ออกใบเบิกค่าใช้จ่ายแบบ "สำรองจ่ายเอง" (reimbursement) — ไม่มีใบ Advance อ้างอิง
 *
 * ✅ ผู้ใช้แจ้ง: "บางทีช่างออกค่าใช้จ่ายไปก่อนไม่ advance" — เดิมระบบบังคับว่าใบเคลมต้องอ้างใบ Advance
 * ที่จ่ายเงินแล้วเสมอ ช่างที่ควักเงินตัวเองไปก่อนจึงไม่มีทางเบิกคืนในระบบเลย ต้องไปตามเอกสารกระดาษ
 *
 * ⚠️ เก็บเป็น kind = "claim" (claimType = "reimburse") ไม่ใช่ kind ใหม่ — ใบนี้คือ "ขอเงินคืนตามที่ใช้
 * จริงพร้อมใบเสร็จ" เหมือนใบเคลมทุกประการ ต่างกันแค่ยอด Advance = 0 การอนุมัติ/จ่ายคืน/รายงาน/สิทธิ์
 * จึงใช้กลไกเดียวกันทั้งหมด (ถ้าแยก kind ใหม่ต้องเขียนขอบเขตสิทธิ์-ตัวกรอง-รายงานซ้ำอีกชุด)
 * ⚠️ difference = total − 0 = ยอดที่บริษัทต้องจ่ายคืน → เข้าขั้น "อนุมัติแล้ว → รอจ่ายคืน" (settle) เดิม
 * ⚠️ ต้องมีรายการและยอดมากกว่า 0 เสมอ (ต่างจากใบเคลมแบบเคลียร์ Advance ที่ยอด 0 ได้ = ไม่ได้ใช้เงินเลย)
 */
router.post("/reimbursements", verifyToken, upload.array("files", 15), async (req, res) => {
  try {
    if (!can(req.user, "requestExpense") && !can(req.user, "viewAllExpenses")) {
      return res.status(403).json({ message: "คุณไม่มีสิทธิ์ออกใบเบิกค่าใช้จ่าย" });
    }
    const me = actor(req);
    const subject = String(req.body.subject || "").trim().slice(0, 300);
    if (!subject) return res.status(400).json({ message: "กรุณาระบุเรื่องที่ขอเบิก" });

    const items = sanitizeItems(req.body.items, "claim");
    if (!items.length) return res.status(400).json({ message: "กรุณาเพิ่มรายการค่าใช้จ่ายที่สำรองจ่ายไปอย่างน้อย 1 รายการ" });
    const total = sumItems(items);
    if (total <= 0) return res.status(400).json({ message: "ยอดที่ขอเบิกคืนต้องมากกว่า 0 บาท" });

    // ── ผู้เบิก (= คนที่สำรองจ่ายและต้องได้เงินคืน) ────────────────────
    let requesterUser = req.user;
    const requesterId = String(req.body.requesterId || "").trim();
    if (requesterId && requesterId !== me.userId) {
      if (!can(req.user, "viewAllExpenses")) {
        return res.status(403).json({ message: "เฉพาะแอดมิน/ผู้จัดการเท่านั้นที่เบิกแทนคนอื่นได้" });
      }
      requesterUser = /^[a-f0-9]{24}$/i.test(requesterId) ? await User.findById(requesterId).lean() : null;
      if (!requesterUser) return res.status(400).json({ message: "ไม่พบผู้เบิกที่เลือก" });
    }

    const linked = await resolveJob(req.body.eventId);
    if (!linked) return res.status(400).json({ message: "ไม่พบงานที่เลือกผูก — อาจถูกลบไปแล้ว" });

    const claim = new Expense({
      kind: "claim",
      claimType: "reimburse",
      docNo: await nextDocNo("reimburse"),
      status: "pending",
      docDate: parseDay(req.body.docDate) || todayNoonUtc(),
      to: String(req.body.to || "").trim().slice(0, 120),
      subject,
      note: String(req.body.note || "").trim().slice(0, 1000),
      requester: {
        userId: String(requesterUser._id),
        name: personName(requesterUser),
        position: String(req.body.position || "").trim().slice(0, 80) || positionOf(requesterUser),
      },
      createdBy: me,
      ...linked,
      items,
      total,
      // ⚠️ ไม่มีใบ Advance — ต้องเคลียร์ค่า snapshot ให้เป็นศูนย์ชัดเจน ไม่ปล่อยค่าว่างคลุมเครือ
      advanceId: "",
      advance: { docNo: "", subject: "", total: 0, paidAt: null },
      difference: total,
      submittedAt: new Date(),
    });

    await attachUploads(req, claim, me, "receipt");
    const onBehalf = String(requesterUser._id) !== me.userId;
    log(claim, "created", `ออกใบเบิกค่าใช้จ่าย (สำรองจ่ายเอง) ${fullBaht(total)}${onBehalf ? ` แทน ${claim.requester.name}` : ""}`, me);
    await saveWithDocNo(claim, "reimburse");

    notifySupervisors(me, {
      title: `🧾 ขออนุมัติเบิกคืนค่าสำรองจ่าย · ${claim.requester.name}`,
      body: [claim.docNo, subject, jobLabel(claim), `จ่ายคืน ${fullBaht(total)}`].filter(Boolean).join(" · "),
      url: urlOf(claim),
      tag: `expense-${claim._id}`,
    });
    if (onBehalf) {
      notifyUsers([claim.requester.userId], me, {
        title: `🧾 ${me.name} ออกใบเบิกค่าสำรองจ่ายให้คุณ`,
        body: `${claim.docNo} · ${subject} · ${fullBaht(total)}`,
        url: urlOf(claim),
        tag: `expense-${claim._id}`,
      });
    }

    res.status(201).json({ expense: claim.toObject() });
  } catch (err) {
    console.error("❌ ออกใบเบิกค่าสำรองจ่ายไม่สำเร็จ:", err);
    res.status(500).json({ message: "ออกใบเบิกค่าใช้จ่ายไม่สำเร็จ" });
  }
});

// ══ /:id ══════════════════════════════════════════════════════════════════

const loadVisible = async (req, res) => {
  if (!/^[a-f0-9]{24}$/i.test(String(req.params.id || ""))) {
    res.status(404).json({ message: "ไม่พบใบเบิกนี้" });
    return null;
  }
  const doc = await Expense.findById(req.params.id);
  if (!doc) {
    res.status(404).json({ message: "ไม่พบใบเบิกนี้" });
    return null;
  }
  if (!canSee(req, doc)) {
    res.status(403).json({ message: "คุณไม่มีสิทธิ์ดูใบเบิกนี้" });
    return null;
  }
  return doc;
};

router.get("/:id", verifyToken, async (req, res) => {
  try {
    const doc = await loadVisible(req, res);
    if (!doc) return;
    const expense = doc.toObject();
    // ✅ แนบใบคู่มาให้ด้วย — หน้ารายละเอียดต้องโชว์ "ตั้งเบิก vs ใช้จริง" ได้โดยไม่ต้องยิงอีกรอบ
    if (expense.kind === "advance" && expense.claimId) {
      expense.claim = await Expense.findById(expense.claimId).select("-activityLog").lean();
    } else if (expense.kind === "claim" && expense.advanceId) {
      expense.advanceDoc = await Expense.findById(expense.advanceId).select("-activityLog").lean();
    }
    res.json({ expense });
  } catch (err) {
    console.error("❌ ดึงใบเบิกไม่สำเร็จ:", err);
    res.status(500).json({ message: "ดึงใบเบิกไม่สำเร็จ" });
  }
});

/**
 * แก้ไขใบ (เฉพาะตอนรออนุมัติ/ถูกตีกลับ)
 * ✅ ใบที่ถูกตีกลับ เมื่อแก้แล้วจะกลับไปรออนุมัติทันที (= ส่งใหม่) พร้อมแจ้งหัวหน้า
 */
router.put("/:id", verifyToken, upload.array("files", 15), async (req, res) => {
  try {
    const doc = await loadVisible(req, res);
    if (!doc) return;
    if (!canEdit(req, doc)) {
      return res.status(409).json({ message: "แก้ไขได้เฉพาะใบที่รออนุมัติหรือถูกตีกลับเท่านั้น" });
    }
    const me = actor(req);
    const wasRejected = doc.status === "rejected";

    if (req.body.subject !== undefined) {
      const subject = String(req.body.subject || "").trim().slice(0, 300);
      if (!subject) return res.status(400).json({ message: "กรุณาระบุเรื่อง" });
      doc.subject = subject;
    }
    if (req.body.to !== undefined) doc.to = String(req.body.to || "").trim().slice(0, 120);
    if (req.body.note !== undefined) doc.note = String(req.body.note || "").trim().slice(0, 1000);
    if (req.body.position !== undefined) doc.requester.position = String(req.body.position || "").trim().slice(0, 80);
    if (req.body.docDate !== undefined) doc.docDate = parseDay(req.body.docDate) || doc.docDate;

    if (req.body.items !== undefined) {
      const items = sanitizeItems(req.body.items, doc.kind);
      // ⚠️ ใบสำรองจ่ายต้องมีรายการและยอด > 0 เหมือนใบ Advance — "ไม่ได้ใช้เงินเลย" ใช้ได้เฉพาะใบที่
      // เคลียร์ Advance (เงินออกไปแล้วจริง) ส่วนใบสำรองจ่ายยอด 0 ไม่มีอะไรให้จ่ายคืน = ไม่ควรมีใบ
      const needItems = doc.kind === "advance" || isReimburse(doc);
      if (needItems && !items.length) {
        return res.status(400).json({ message: "กรุณาเพิ่มรายการอย่างน้อย 1 รายการ" });
      }
      const total = sumItems(items);
      if (needItems && total <= 0) return res.status(400).json({ message: "ยอดที่ขอเบิกต้องมากกว่า 0 บาท" });
      if (doc.kind === "claim" && !needItems && !items.length && !doc.note) {
        return res.status(400).json({ message: "กรุณาเพิ่มรายการที่ใช้จริง หรือระบุหมายเหตุหากไม่ได้ใช้เงินเลย" });
      }
      doc.items = items;
      doc.total = total;
      if (doc.kind === "claim") doc.difference = money(total - (doc.advance?.total || 0));
    }

    // ✅ ใบ Advance และใบสำรองจ่าย เป็น "ใบที่ตั้งต้นเอง" — ผูกงาน/เปลี่ยนผู้เบิกได้
    // ⚠️ ใบเคลมที่เคลียร์ Advance ทำสองอย่างนี้ไม่ได้ ทั้งงานและผู้เบิกต้องตามใบ Advance เสมอ
    if (doc.kind === "advance" || isReimburse(doc)) {
      if (req.body.eventId !== undefined) {
        const linked = await resolveJob(req.body.eventId);
        if (!linked) return res.status(400).json({ message: "ไม่พบงานที่เลือกผูก — อาจถูกลบไปแล้ว" });
        doc.eventId = linked.eventId;
        doc.job = linked.job;
      }
      if (doc.kind === "advance" && req.body.dueClearAt !== undefined) doc.dueClearAt = parseDay(req.body.dueClearAt);
      const requesterId = String(req.body.requesterId || "").trim();
      if (requesterId && requesterId !== doc.requester.userId) {
        if (!can(req.user, "viewAllExpenses")) {
          return res.status(403).json({ message: "เฉพาะแอดมิน/ผู้จัดการเท่านั้นที่เปลี่ยนผู้เบิกได้" });
        }
        const u = /^[a-f0-9]{24}$/i.test(requesterId) ? await User.findById(requesterId).lean() : null;
        if (!u) return res.status(400).json({ message: "ไม่พบผู้เบิกที่เลือก" });
        doc.requester = { userId: String(u._id), name: personName(u), position: String(req.body.position || "").trim() || positionOf(u) };
      }
    }

    await attachUploads(req, doc, me, doc.kind === "claim" ? "receipt" : "other");

    if (wasRejected) {
      doc.status = "pending";
      doc.submittedAt = new Date();
      doc.rejectReason = "";
      log(doc, "resubmitted", `แก้ไขและส่งใหม่ · ${fullBaht(doc.total)}`, me);
    } else {
      log(doc, "updated", `แก้ไขใบ · ${fullBaht(doc.total)}`, me);
    }
    await doc.save();

    if (wasRejected) {
      notifySupervisors(me, {
        title: `🔁 ส่ง${labelOf(doc)}ใหม่หลังแก้ไข · ${doc.requester.name}`,
        body: `${doc.docNo} · ${doc.subject} · ${fullBaht(doc.total)}`,
        url: urlOf(doc),
        tag: `expense-${doc._id}`,
      });
    }
    res.json({ expense: doc.toObject() });
  } catch (err) {
    console.error("❌ แก้ไขใบเบิกไม่สำเร็จ:", err);
    res.status(500).json({ message: "แก้ไขไม่สำเร็จ" });
  }
});

router.post("/:id/approve", verifyToken, async (req, res) => {
  try {
    if (!can(req.user, "approveExpense")) return res.status(403).json({ message: "คุณไม่มีสิทธิ์อนุมัติใบเบิก" });
    const doc = await loadVisible(req, res);
    if (!doc) return;
    if (doc.status !== "pending") return res.status(409).json({ message: "อนุมัติได้เฉพาะใบที่รออนุมัติเท่านั้น" });
    if (blockSelfApproval(req, doc)) return res.status(403).json({ message: "ไม่สามารถอนุมัติใบของตัวเองได้ — ให้หัวหน้าท่านอื่นเป็นผู้อนุมัติ" });

    const me = actor(req);
    const note = String(req.body?.note || "").trim().slice(0, 500);
    doc.approvedBy = { userId: me.userId, name: me.name };
    doc.approvedAt = new Date();

    let advance = null;
    if (doc.kind === "advance") {
      doc.status = "approved";
      log(doc, "approved", `อนุมัติ ${fullBaht(doc.total)}${note ? ` · ${note}` : ""}`, me);
    } else {
      advance = doc.advanceId ? await Expense.findById(doc.advanceId) : null;
      // ⚠️ คำนวณส่วนต่างใหม่จากยอด snapshot ตอนอนุมัติเสมอ (กันกรณีแก้รายการแล้วค่าเก่าค้าง)
      doc.difference = money(doc.total - (doc.advance?.total || 0));
      if (doc.difference === 0) {
        // ✅ ไม่มีส่วนต่าง = จบในขั้นเดียว ไม่ต้องให้หัวหน้ากด "ชำระส่วนต่าง 0 บาท" อีกรอบ
        doc.status = "settled";
        doc.payment = { method: "other", ref: "", note: "ไม่มีส่วนต่าง", at: new Date(), by: { userId: me.userId, name: me.name } };
        log(doc, "approved", `อนุมัติ · ใช้จริงพอดีกับยอด Advance${note ? ` · ${note}` : ""}`, me);
        if (advance) {
          advance.status = "cleared";
          log(advance, "cleared", `เคลียร์เรียบร้อยด้วย ${doc.docNo}`, me);
        }
      } else {
        doc.status = "approved";
        const waitText = isReimburse(doc) ? "รอจ่ายคืน" : doc.difference > 0 ? "รอจ่ายเพิ่ม" : "รอรับคืน";
        log(doc, "approved", `อนุมัติ · ${waitText} ${fullBaht(Math.abs(doc.difference))}${note ? ` · ${note}` : ""}`, me);
      }
    }
    await doc.save();
    if (advance) await advance.save();

    const body = doc.kind === "advance"
      ? `${doc.docNo} · ${fullBaht(doc.total)} — รอฝ่ายบัญชีจ่ายเงิน`
      : isReimburse(doc)
        ? `${doc.docNo} · บริษัทจะจ่ายคืนให้ ${fullBaht(doc.difference)}`
        : doc.status === "settled"
          ? `${doc.docNo} · เคลียร์ ${doc.advance?.docNo} เรียบร้อย`
          : `${doc.docNo} · ${doc.difference > 0 ? `บริษัทจะจ่ายเพิ่มให้ ${fullBaht(doc.difference)}` : `กรุณาคืนเงิน ${fullBaht(-doc.difference)}`}`;
    notifyUsers(ownersOf(doc), me, {
      title: `✅ ${labelOf(doc)}ได้รับอนุมัติแล้ว`,
      body,
      url: urlOf(doc),
      tag: `expense-${doc._id}`,
    });
    res.json({ expense: doc.toObject() });
  } catch (err) {
    console.error("❌ อนุมัติใบเบิกไม่สำเร็จ:", err);
    res.status(500).json({ message: "อนุมัติไม่สำเร็จ" });
  }
});

router.post("/:id/reject", verifyToken, async (req, res) => {
  try {
    if (!can(req.user, "approveExpense")) return res.status(403).json({ message: "คุณไม่มีสิทธิ์ตีกลับใบเบิก" });
    const doc = await loadVisible(req, res);
    if (!doc) return;
    if (doc.status !== "pending") return res.status(409).json({ message: "ตีกลับได้เฉพาะใบที่รออนุมัติเท่านั้น" });
    const reason = String(req.body?.reason || "").trim().slice(0, 500);
    if (!reason) return res.status(400).json({ message: "กรุณาระบุเหตุผลที่ตีกลับ เพื่อให้ผู้เบิกแก้ได้ถูกจุด" });

    const me = actor(req);
    doc.status = "rejected";
    doc.rejectedBy = { userId: me.userId, name: me.name };
    doc.rejectedAt = new Date();
    doc.rejectReason = reason;
    log(doc, "rejected", `ตีกลับ · ${reason}`, me);
    await doc.save();

    notifyUsers(ownersOf(doc), me, {
      title: `↩️ ${labelOf(doc)}ถูกตีกลับให้แก้ไข`,
      body: `${doc.docNo} · ${reason}`,
      url: urlOf(doc),
      tag: `expense-${doc._id}`,
    });
    res.json({ expense: doc.toObject() });
  } catch (err) {
    console.error("❌ ตีกลับใบเบิกไม่สำเร็จ:", err);
    res.status(500).json({ message: "ตีกลับไม่สำเร็จ" });
  }
});

const PAYMENT_LABEL = { transfer: "โอนเงิน", cash: "เงินสด", cheque: "เช็ค", other: "อื่นๆ" };

const readPayment = (req, me) => ({
  method: Expense.PAYMENT_METHODS.includes(req.body?.method) ? req.body.method : "transfer",
  ref: String(req.body?.ref || "").trim().slice(0, 120),
  note: String(req.body?.note || "").trim().slice(0, 500),
  at: parseDay(req.body?.paidAt) || todayNoonUtc(),
  by: { userId: me.userId, name: me.name },
});

/** บันทึกจ่ายเงิน Advance (อนุมัติแล้ว → จ่ายแล้ว รอเคลียร์) */
router.post("/:id/pay", verifyToken, upload.array("files", 5), async (req, res) => {
  try {
    if (!can(req.user, "approveExpense")) return res.status(403).json({ message: "คุณไม่มีสิทธิ์บันทึกการจ่ายเงิน" });
    const doc = await loadVisible(req, res);
    if (!doc) return;
    if (doc.kind !== "advance") return res.status(400).json({ message: "บันทึกจ่ายเงินได้เฉพาะใบ Advance" });
    if (doc.status !== "approved") return res.status(409).json({ message: "จ่ายเงินได้เฉพาะใบที่อนุมัติแล้วเท่านั้น" });

    const me = actor(req);
    doc.payment = readPayment(req, me);
    doc.status = "paid";
    // ✅ กำหนดเคลียร์: ใช้ค่าที่ระบุ ถ้าไม่ระบุและใบยังไม่มี = วันจ่าย + 7 วัน (ใช้ยิงเตือนรายวัน)
    const due = parseDay(req.body?.dueClearAt);
    if (due) doc.dueClearAt = due;
    else if (!doc.dueClearAt) doc.dueClearAt = moment(doc.payment.at).add(DEFAULT_CLEAR_DAYS, "days").toDate();
    await attachUploads(req, doc, me, "transfer_slip");
    log(doc, "paid", `จ่ายเงิน ${fullBaht(doc.total)} (${PAYMENT_LABEL[doc.payment.method]}${doc.payment.ref ? ` ${doc.payment.ref}` : ""})`, me);
    await doc.save();

    notifyUsers(ownersOf(doc), me, {
      title: "💸 ได้รับเงิน Advance แล้ว",
      body: `${doc.docNo} · ${fullBaht(doc.total)} — กรุณาส่งใบเคลมภายใน ${thaiDate(doc.dueClearAt)}`,
      url: urlOf(doc),
      tag: `expense-${doc._id}`,
    });
    res.json({ expense: doc.toObject() });
  } catch (err) {
    console.error("❌ บันทึกจ่ายเงินไม่สำเร็จ:", err);
    res.status(500).json({ message: "บันทึกจ่ายเงินไม่สำเร็จ" });
  }
});

/** ปิดส่วนต่างของใบเคลม (รับคืน / จ่ายเพิ่ม) → ใบ Advance เคลียร์เรียบร้อย */
router.post("/:id/settle", verifyToken, upload.array("files", 5), async (req, res) => {
  try {
    if (!can(req.user, "approveExpense")) return res.status(403).json({ message: "คุณไม่มีสิทธิ์ปิดส่วนต่าง" });
    const doc = await loadVisible(req, res);
    if (!doc) return;
    if (doc.kind !== "claim") return res.status(400).json({ message: "ปิดส่วนต่างได้เฉพาะใบเคลม" });
    if (doc.status !== "approved") return res.status(409).json({ message: "ปิดส่วนต่างได้เฉพาะใบเคลมที่อนุมัติแล้ว" });

    const me = actor(req);
    doc.payment = readPayment(req, me);
    doc.status = "settled";
    await attachUploads(req, doc, me, "transfer_slip");
    const diffText = isReimburse(doc)
      ? `จ่ายคืนค่าสำรองจ่าย ${fullBaht(doc.difference)}`
      : doc.difference > 0 ? `จ่ายเพิ่ม ${fullBaht(doc.difference)}` : `รับคืน ${fullBaht(-doc.difference)}`;
    log(doc, "settled", `${diffText} (${PAYMENT_LABEL[doc.payment.method]}${doc.payment.ref ? ` ${doc.payment.ref}` : ""})`, me);

    const advance = doc.advanceId ? await Expense.findById(doc.advanceId) : null;
    if (advance) {
      advance.status = "cleared";
      log(advance, "cleared", `เคลียร์เรียบร้อยด้วย ${doc.docNo} · ${diffText}`, me);
    }
    await doc.save();
    if (advance) await advance.save();

    notifyUsers(ownersOf(doc), me, {
      title: isReimburse(doc) ? "🏁 ได้รับเงินคืนค่าสำรองจ่ายแล้ว" : "🏁 เคลียร์ Advance เรียบร้อย",
      body: `${doc.docNo} · ${diffText}`,
      url: urlOf(doc),
      tag: `expense-${doc._id}`,
    });
    res.json({ expense: doc.toObject() });
  } catch (err) {
    console.error("❌ ปิดส่วนต่างไม่สำเร็จ:", err);
    res.status(500).json({ message: "ปิดส่วนต่างไม่สำเร็จ" });
  }
});

/**
 * ยกเลิกใบ
 *   • ผู้เบิก/คนออกใบ ยกเลิกได้ตอนรออนุมัติ/ถูกตีกลับ
 *   • หัวหน้ายกเลิกได้จนถึงก่อน "มีเงินออกไปแล้ว" (Advance ที่จ่ายแล้วต้องเคลียร์ด้วยใบเคลม ไม่ใช่ยกเลิกทิ้ง)
 * ⚠️ ยกเลิกใบเคลม = ใบ Advance กลับไปเป็น "จ่ายแล้ว รอเคลียร์" เพื่อออกใบเคลมใหม่ได้
 */
router.post("/:id/cancel", verifyToken, async (req, res) => {
  try {
    const doc = await loadVisible(req, res);
    if (!doc) return;
    const approver = can(req.user, "approveExpense");
    const ownerCan = isOwner(req, doc) && EDITABLE.includes(doc.status);
    const approverCan = approver && [...EDITABLE, "approved"].includes(doc.status);
    if (!ownerCan && !approverCan) {
      const msg = doc.kind === "advance" && ["paid", "clearing"].includes(doc.status)
        ? "ใบ Advance ที่จ่ายเงินแล้วยกเลิกไม่ได้ — ต้องเคลียร์ด้วยใบเคลม (ถ้าไม่ได้ใช้เงิน ให้ออกใบเคลมยอด 0 เพื่อคืนเงินทั้งหมด)"
        : "ใบนี้ยกเลิกไม่ได้แล้ว";
      return res.status(409).json({ message: msg });
    }
    const me = actor(req);
    const reason = String(req.body?.reason || "").trim().slice(0, 500);
    doc.status = "cancelled";
    doc.cancelledBy = { userId: me.userId, name: me.name };
    doc.cancelledAt = new Date();
    doc.cancelReason = reason;
    log(doc, "cancelled", `ยกเลิก${reason ? ` · ${reason}` : ""}`, me);

    let advance = null;
    if (doc.kind === "claim" && doc.advanceId) {
      advance = await Expense.findById(doc.advanceId);
      if (advance && advance.claimId === String(doc._id) && advance.status === "clearing") {
        advance.status = "paid";
        advance.claimId = "";
        advance.claimDocNo = "";
        log(advance, "claim_cancelled", `ใบเคลม ${doc.docNo} ถูกยกเลิก — กลับไปรอเคลียร์`, me);
      } else {
        advance = null;
      }
    }
    await doc.save();
    if (advance) await advance.save();

    notifyUsers(ownersOf(doc), me, {
      title: `🚫 ${labelOf(doc)}ถูกยกเลิก`,
      body: `${doc.docNo}${reason ? ` · ${reason}` : ""}`,
      url: urlOf(doc),
      tag: `expense-${doc._id}`,
    });
    res.json({ expense: doc.toObject() });
  } catch (err) {
    console.error("❌ ยกเลิกใบเบิกไม่สำเร็จ:", err);
    res.status(500).json({ message: "ยกเลิกไม่สำเร็จ" });
  }
});

/**
 * ออก "รหัสฟอร์มเคลมเปล่า" สำหรับพิมพ์ไปกรอกด้วยลายมือ โดยผูกกับใบ Advance ที่รอเคลียร์
 *
 * ✅ ทำไมรหัสต้องออกจาก server (ไม่สุ่มที่หน้าจอ): รหัสที่สุ่มในเบราว์เซอร์ใครก็พิมพ์ขึ้นมาเองได้
 * ไม่มีทางรู้ว่าจริงหรือปลอม — รหัสจากที่นี่สุ่มด้วย crypto และถูกบันทึกลงประวัติของใบ Advance ทันที
 * ฝ่ายบัญชีที่รับกระดาษมาจึงเปิดใบ Advance แล้วเทียบได้เลยว่ารหัสบนกระดาษถูกออกจริง โดยใคร เมื่อไร
 * (กระดาษที่รหัสไม่อยู่ในประวัติ = ไม่ได้ออกจากระบบ ต้องตรวจสอบก่อนรับ)
 *
 * ⚠️ ออกได้เฉพาะใบที่ "จ่ายเงินแล้ว รอเคลียร์" — เงื่อนไขเดียวกับการออกใบเคลมในระบบ (POST /claims)
 * ไม่งั้นจะมีกระดาษเคลมของใบที่เคลียร์ไปแล้ว/ยกเลิกไปแล้วหลุดออกไปใช้ซ้ำได้
 * ⚠️ ใช้ $push แบบอะตอมมิก ไม่ใช่ doc.save() — แค่เพิ่มบรรทัดประวัติ ต้องไม่ไปเขียนทับฟิลด์อื่น
 * ที่คนอื่นอาจกำลังแก้อยู่พร้อมกัน (เช่น หัวหน้ากำลังบันทึกจ่ายเงิน)
 */
const FORM_CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"; // ตัด 0/O/1/I ที่อ่านสับสนบนกระดาษ
const newFormCode = () => {
  // 256 หารด้วย 32 ลงตัว → byte % 32 ได้การกระจายเท่ากันทุกตัว (ไม่มีอคติแบบ modulo)
  const rand = Array.from(crypto.randomBytes(6), (b) => FORM_CODE_ALPHABET[b % 32]).join("");
  return `FC-${moment().format("YYMMDD")}-${rand}`;
};

router.post("/:id/blank-claim-form", verifyToken, async (req, res) => {
  try {
    if (!can(req.user, "requestExpense") && !can(req.user, "viewAllExpenses")) {
      return res.status(403).json({ message: "คุณไม่มีสิทธิ์ออกฟอร์มใบเคลม" });
    }
    const doc = await loadVisible(req, res);
    if (!doc) return;
    if (doc.kind !== "advance") return res.status(400).json({ message: "ฟอร์มเคลมต้องอ้างถึงใบ Advance เท่านั้น" });
    if (doc.status !== "paid") {
      const why = {
        pending: "ใบ Advance ยังไม่ได้รับอนุมัติ",
        rejected: "ใบ Advance ถูกตีกลับอยู่",
        approved: "ยังไม่ได้บันทึกการจ่ายเงิน Advance",
        clearing: `ใบ Advance นี้มีใบเคลม ${doc.claimDocNo || ""} อยู่แล้ว`,
        cleared: "ใบ Advance นี้เคลียร์เรียบร้อยแล้ว",
        cancelled: "ใบ Advance นี้ถูกยกเลิกแล้ว",
      }[doc.status];
      return res.status(409).json({ message: why || "ใบ Advance นี้ยังเคลียร์ไม่ได้" });
    }

    const me = actor(req);
    const code = newFormCode();
    const issuedAt = new Date();
    await Expense.updateOne(
      { _id: doc._id },
      {
        $push: {
          activityLog: {
            action: "blank_claim_form",
            detail: `ออกฟอร์มเคลมเปล่า (กรอกด้วยลายมือ) รหัส ${code}`,
            userId: me.userId,
            userName: me.name,
            timestamp: issuedAt,
          },
        },
      }
    );
    res.json({ code, issuedAt, issuedBy: me.name });
  } catch (err) {
    console.error("❌ ออกฟอร์มเคลมเปล่าไม่สำเร็จ:", err);
    res.status(500).json({ message: "ออกฟอร์มเคลมเปล่าไม่สำเร็จ" });
  }
});

/** แนบไฟล์เพิ่ม (ใบเสร็จที่ตามมาทีหลัง ฯลฯ) — ใบที่ยกเลิกแล้วแนบไม่ได้ */
router.post("/:id/files", verifyToken, upload.array("files", 10), async (req, res) => {
  try {
    const doc = await loadVisible(req, res);
    if (!doc) return;
    if (doc.status === "cancelled") return res.status(409).json({ message: "ใบที่ยกเลิกแล้วแนบไฟล์ไม่ได้" });
    if (!isOwner(req, doc) && !can(req.user, "approveExpense")) {
      return res.status(403).json({ message: "คุณไม่มีสิทธิ์แนบไฟล์ในใบนี้" });
    }
    if (!req.files?.length) return res.status(400).json({ message: "กรุณาเลือกไฟล์" });
    const me = actor(req);
    await attachUploads(req, doc, me, doc.kind === "claim" ? "receipt" : "other");
    log(doc, "files_added", `แนบไฟล์ ${req.files.length} ไฟล์`, me);
    await doc.save();
    res.json({ expense: doc.toObject() });
  } catch (err) {
    console.error("❌ แนบไฟล์ไม่สำเร็จ:", err);
    res.status(500).json({ message: "แนบไฟล์ไม่สำเร็จ" });
  }
});

/** ลบไฟล์แนบ — ผู้เบิกลบได้ตอนยังแก้ใบได้ · หัวหน้าลบได้เสมอ (ยกเว้นใบที่ยกเลิกแล้ว เก็บไว้เป็นหลักฐาน) */
router.delete("/:id/files/:fileId", verifyToken, async (req, res) => {
  try {
    const doc = await loadVisible(req, res);
    if (!doc) return;
    const allowed = can(req.user, "approveExpense") ? doc.status !== "cancelled" : canEdit(req, doc);
    if (!allowed) return res.status(409).json({ message: "ลบไฟล์ในใบนี้ไม่ได้แล้ว" });
    const file = doc.attachments.id(req.params.fileId);
    if (!file) return res.status(404).json({ message: "ไม่พบไฟล์" });
    const me = actor(req);
    const name = file.fileName;
    file.deleteOne();
    log(doc, "file_removed", `ลบไฟล์ ${name}`, me);
    await doc.save();
    res.json({ expense: doc.toObject() });
  } catch (err) {
    console.error("❌ ลบไฟล์ไม่สำเร็จ:", err);
    res.status(500).json({ message: "ลบไฟล์ไม่สำเร็จ" });
  }
});

module.exports = router;
