/**
 * /api/ot — ใบขออนุมัติทำงานล่วงเวลา (OT) · ดู models/OtRequest.js
 *
 * ✅ ผู้ใช้สั่ง (28 ก.ย. 2569): "ทำระบบเบิกโอทีด้วย ให้มืออาชีพ และสมบูรณ์"
 *   ตัวคูณตั้งค่าได้ · ยื่นเองหรือหัวหน้ายื่นให้ทีม · ผูกงาน + เวลาเริ่ม-เลิก · อนุมัติแล้วรวมจ่ายกับเงินเดือน
 *
 * สายอนุมัติ = สิทธิ์ชุดเดียวกับระบบเบิก: ตรวจสอบ (reviewExpense) → อนุมัติ (approveExpense)
 *   → ปิดรอบจ่ายพร้อมเงินเดือน (disburseExpense) · ดู/ตั้งค่าจ้างต่อชั่วโมง = viewAllExpenses
 *
 * 🔒 ค่าจ้างต่อชั่วโมงเป็นข้อมูลลับ — คนที่ไม่มี viewAllExpenses เห็นยอดเงินเฉพาะบรรทัดของตัวเอง
 *    (หัวหน้างานที่ยื่นให้ลูกทีมเห็นชั่วโมงของทุกคน แต่ไม่เห็นเงินของคนอื่น) — ตัดที่ server (redact)
 * ⚠️ ลำดับ route: path ตายตัวทั้งหมดต้องมาก่อน /:id
 */
const express = require("express");
const moment = require("moment");

const OtRequest = require("../models/OtRequest");
const OtWage = require("../models/OtWage");
const User = require("../models/User");
const OrgSetting = require("../models/OrgSetting");
const CalendarEvent = require("../models/Events");
const DocCounter = require("../models/DocCounter");
const verifyToken = require("../middleware/auth");
const { can, titleOf, rankFilter, effectiveCapabilities, CAPABILITIES } = require("../config/roles");
const { sendPushToUsers } = require("../services/PushNotify");
const holidaysData = require("../../data/thai-holidays-2026-2028.json");

const router = express.Router();

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
const dayKey = (d) => moment(d).utcOffset(7).format("YYYY-MM-DD");
const todayNoonUtc = () => parseDay(moment().utcOffset(7).format("YYYY-MM-DD"));

const TYPE_LABEL = { workdayOT: "OT วันทำงาน", holidayWork: "ทำงานวันหยุด", holidayOT: "OT วันหยุด" };

/** ค่าตั้งต้นของ OT จากตั้งค่าองค์กร (มีค่าสำรองเสมอ) */
const otConfig = async () => {
  const D = OrgSetting.DEFAULTS;
  try {
    const s = await OrgSetting.current();
    const m = s?.otMultipliers?.toObject?.() || s?.otMultipliers || {};
    return {
      multipliers: { ...D.otMultipliers, ...Object.fromEntries(Object.entries(m).filter(([, v]) => Number(v) > 0)) },
      hoursPerDay: Number(s?.otHoursPerDay) || D.otHoursPerDay,
      restDays: Array.isArray(s?.otRestDays) ? s.otRestDays : D.otRestDays,
    };
  } catch {
    return { multipliers: D.otMultipliers, hoursPerDay: D.otHoursPerDay, restDays: D.otRestDays };
  }
};

/** วันหยุดนักขัตฤกษ์ { "YYYY-MM-DD": ชื่อ } */
const HOLIDAYS = Object.fromEntries(Object.values(holidaysData).flat().map((h) => [h.date, h.name]));

/** "HH:mm" → นาทีของวัน · ไม่ถูกต้อง = null */
const toMin = (t) => {
  const m = String(t || "").match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

/**
 * ชั่วโมง OT ของบรรทัด — เลิกก่อนเริ่ม = ข้ามเที่ยงคืน · หักเวลาพัก · ปัดทศนิยม 2 ตำแหน่ง
 * @returns {{hours:number, span:[number, number]}|{error:string}} span = ช่วงนาทีจริง (ใช้ตรวจเวลาชนกัน)
 */
const hoursOf = (start, end, breakMin) => {
  const a = toMin(start);
  const b = toMin(end);
  if (a === null || b === null) return { error: "รูปแบบเวลาไม่ถูกต้อง (ต้องเป็น ชช:นน)" };
  const dur = (b > a ? b - a : b + 1440 - a);
  if (dur <= 0 || a === b) return { error: "เวลาเลิกต้องไม่เท่ากับเวลาเริ่ม" };
  if (dur > 16 * 60) return { error: "ช่วงเวลา OT ยาวเกิน 16 ชั่วโมง — กรุณาตรวจสอบเวลา" };
  const brk = Math.min(Math.max(Math.round(Number(breakMin) || 0), 0), dur - 1);
  return { hours: Math.round(((dur - brk) / 60) * 100) / 100, span: [a, a + dur] };
};

/** ค่าจ้างต่อชั่วโมงของพนักงานหลายคน (Map userId → rate) */
const wagesOf = async (ids) => {
  const rows = ids.length ? await OtWage.find({ userId: { $in: ids } }).lean() : [];
  return new Map(rows.map((w) => [w.userId, Number(w.hourlyRate) || 0]));
};

/**
 * ทำความสะอาดบรรทัด + คำนวณชั่วโมง/เงินใหม่ทั้งหมด (ไม่เชื่อค่าจาก client)
 * @returns {Promise<{lines}|{error}>}
 */
const buildLines = async (raw, cfg) => {
  let arr = raw;
  if (typeof arr === "string") { try { arr = JSON.parse(arr); } catch { arr = []; } }
  arr = (Array.isArray(arr) ? arr : []).slice(0, 200);
  if (!arr.length) return { error: "กรุณาเพิ่มรายการ OT อย่างน้อย 1 รายการ" };

  const ids = [...new Set(arr.map((l) => String(l?.person?.userId || "")).filter(isId))];
  const users = ids.length ? await User.find({ _id: { $in: ids } }).select("fname lname username").lean() : [];
  const userById = new Map(users.map((u) => [String(u._id), u]));
  const wages = await wagesOf(ids);
  const eventIds = [...new Set(arr.map((l) => String(l?.eventId || "")).filter(isId))];
  const events = eventIds.length ? await CalendarEvent.find({ _id: { $in: eventIds } }).select("title site company system").lean() : [];
  const evById = new Map(events.map((ev) => [String(ev._id), ev]));

  const lines = [];
  for (const [i, l] of arr.entries()) {
    const no = `แถวที่ ${i + 1}`;
    const uid = String(l?.person?.userId || "");
    const u = userById.get(uid);
    if (!u) return { error: `${no}: กรุณาเลือกพนักงานจากรายชื่อในระบบ` };
    const date = parseDay(l?.date);
    if (!date) return { error: `${no}: กรุณาระบุวันที่ทำ OT` };
    if (date > new Date(Date.now() + 31 * 86400000)) return { error: `${no}: วันที่ทำ OT ล่วงหน้าเกิน 1 เดือน` };
    // ไม่ระบุประเภท = เดาจากวันที่ (วันหยุดนักขัตฤกษ์/วันหยุดประจำสัปดาห์ → ทำงานวันหยุด หรือ OT วันหยุดถ้าเริ่มหลัง 17:00)
    const isHoliday = Boolean(HOLIDAYS[dayKey(date)]) || cfg.restDays.includes(moment(date).utcOffset(7).day());
    const guessed = !isHoliday ? "workdayOT" : (toMin(l?.start) ?? 0) >= 17 * 60 ? "holidayOT" : "holidayWork";
    const type = OtRequest.OT_TYPES.includes(l?.type) ? l.type : guessed;
    const h = hoursOf(l?.start, l?.end, l?.breakMin);
    if (h.error) return { error: `${no}: ${h.error}` };
    const multiplier = Number(cfg.multipliers[type]) || 1;
    const hourlyRate = money(wages.get(uid) || 0);
    const ev = evById.get(String(l?.eventId || ""));
    lines.push({
      person: { userId: uid, name: fullNameOf(u) },
      date, type,
      start: String(l.start).padStart(5, "0"), end: String(l.end).padStart(5, "0"),
      breakMin: Math.max(Math.round(Number(l?.breakMin) || 0), 0),
      hours: h.hours, multiplier, hourlyRate,
      amount: money(h.hours * multiplier * hourlyRate),
      eventId: ev ? String(ev._id) : "",
      jobTitle: ev ? [ev.title, ev.system && !String(ev.title || "").includes(ev.system) ? ev.system : "", ev.site || ev.company].filter(Boolean).join(" · ") : "",
      task: String(l?.task || "").trim().slice(0, 300),
      _span: [date.getTime() / 60000 + h.span[0], date.getTime() / 60000 + h.span[1]],
    });
  }
  // 🔒 คนเดียวกันห้ามมีช่วงเวลา OT ซ้อนกันในใบเดียว (กันยื่นชั่วโมงซ้ำ)
  for (let i = 0; i < lines.length; i += 1) {
    for (let j = i + 1; j < lines.length; j += 1) {
      const a = lines[i]; const b = lines[j];
      if (a.person.userId === b.person.userId && a._span[0] < b._span[1] && b._span[0] < a._span[1]) {
        return { error: `${a.person.name}: ช่วงเวลา OT แถวที่ ${i + 1} กับ ${j + 1} ซ้อนกัน` };
      }
    }
  }
  return { lines };
};

/**
 * 🔒 ตรวจว่าช่วงเวลาไม่ซ้อนกับใบ OT อื่นที่ยังมีผลของคนเดียวกัน (กันยื่นซ้ำคนละใบ)
 * @returns {Promise<string>} ข้อความ error หรือ ""
 */
const crossDocOverlap = async (lines, excludeId) => {
  const ids = [...new Set(lines.map((l) => l.person.userId))];
  const dates = lines.map((l) => l.date.getTime());
  const q = {
    status: { $nin: ["cancelled"] },
    "lines.person.userId": { $in: ids },
    "lines.date": { $gte: new Date(Math.min(...dates) - 86400000), $lte: new Date(Math.max(...dates) + 86400000) },
  };
  if (excludeId) q._id = { $ne: excludeId };
  const others = await OtRequest.find(q).select("docNo lines").lean();
  for (const doc of others) {
    for (const o of doc.lines) {
      const r = hoursOf(o.start, o.end, 0);
      if (r.error) continue;
      const os = [new Date(o.date).getTime() / 60000 + r.span[0], new Date(o.date).getTime() / 60000 + r.span[1]];
      const hit = lines.find((l) => l.person.userId === o.person.userId && l._span[0] < os[1] && os[0] < l._span[1]);
      if (hit) return `${hit.person.name} มี OT ช่วงเวลานี้อยู่แล้วในใบ ${doc.docNo} (${dayKey(o.date)} ${o.start}–${o.end})`;
    }
  }
  return "";
};

const applyLines = (doc, lines) => {
  doc.lines = lines.map(({ _span, ...l }) => l);
  doc.memberIds = [...new Set(lines.map((l) => l.person.userId))];
  doc.totalHours = Math.round(lines.reduce((s, l) => s + l.hours, 0) * 100) / 100;
  doc.totalAmount = money(lines.reduce((s, l) => s + l.amount, 0));
  const last = lines.reduce((m, l) => (l.date > m ? l.date : m), lines[0].date);
  doc.period = moment(last).utcOffset(7).format("YYYY-MM");
};

const nextDocNo = async () => {
  const year = new Date().getFullYear() + 543;
  const c = await DocCounter.findOneAndUpdate({ key: `ot:${year}` }, { $inc: { seq: 1 } }, { new: true, upsert: true, setDefaultsOnInsert: true });
  return `OT-${String(c.seq).padStart(5, "0")}/${year}`;
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

const log = (doc, action, detail, me) => {
  doc.activityLog.push({ action, detail, userId: me.userId, userName: me.name, timestamp: new Date() });
};

// ── ขอบเขต/สิทธิ์ ──────────────────────────────────────────────────────
const canUseOt = (req) => can(req.user, "requestExpense") || can(req.user, "viewAllExpenses");
const scopeFor = (req) => {
  if (can(req.user, "viewAllExpenses")) return {};
  const uid = String(req.userId || "");
  return { $or: [{ "requester.userId": uid }, { "createdBy.userId": uid }, { memberIds: uid }] };
};
const isOwner = (req, doc) => {
  const uid = String(req.userId || "");
  return doc.requester?.userId === uid || doc.createdBy?.userId === uid;
};
const canSee = (req, doc) => can(req.user, "viewAllExpenses") || isOwner(req, doc) || (doc.memberIds || []).includes(String(req.userId || ""));
/** ตรวจ/อนุมัติใบที่ตัวเองมีชื่อทำ OT ไม่ได้ (เว้นผู้มีสิทธิ์อนุมัติของตัวเอง) — หลักควบคุมภายในเดียวกับระบบเบิก */
const selfInvolved = (req, doc) => {
  const uid = String(req.userId || "");
  return (doc.requester?.userId === uid || (doc.memberIds || []).includes(uid)) && !can(req.user, "approveOwnExpense");
};

/**
 * 🔒 ตัดยอดเงินที่ผู้ขอไม่มีสิทธิ์เห็น — ค่าจ้างของคนอื่นเป็นข้อมูลลับ
 * คนที่มี viewAllExpenses เห็นทุกบรรทัด · คนอื่นเห็นเงินเฉพาะบรรทัดของตัวเอง
 */
const redact = (req, doc) => {
  const o = typeof doc.toObject === "function" ? doc.toObject() : { ...doc };
  if (can(req.user, "viewAllExpenses")) return { ...o, moneyVisible: "all" };
  const uid = String(req.userId || "");
  o.lines = (o.lines || []).map((l) => (l.person?.userId === uid ? l : { ...l, hourlyRate: null, amount: null }));
  o.totalAmount = money(o.lines.reduce((s, l) => s + (Number(l.amount) || 0), 0));
  o.moneyVisible = "mine";
  return o;
};

// ── แจ้งเตือน ─────────────────────────────────────────────────────────
const notifyUsers = (ids, me, payload) => {
  const targets = [...new Set((ids || []).filter(Boolean).map(String))].filter((id) => id !== me.userId);
  if (targets.length) sendPushToUsers(targets, payload).catch((e) => console.error("push ot:", e.message));
};
const notifyCap = async (cap, me, payload) => {
  try {
    const ranks = effectiveCapabilities()[cap] || CAPABILITIES[cap] || [];
    const users = await User.find(rankFilter(ranks)).select("_id").lean();
    notifyUsers(users.map((u) => String(u._id)), me, payload);
  } catch (e) {
    console.error(`push ot ${cap}:`, e.message);
  }
};
const urlOf = (doc) => `/ot/${doc._id}`;
const summaryLine = (doc) => {
  const people = new Set(doc.lines.map((l) => l.person.userId)).size;
  return `${doc.docNo} · ${people} คน · ${doc.totalHours} ชม.`;
};

// ══ path ตายตัว (ต้องมาก่อน /:id) ══════════════════════════════════════════

/** ค่าตั้งต้นที่ฟอร์มต้องใช้ — ตัวคูณ · วันหยุดประจำสัปดาห์ · วันหยุดนักขัตฤกษ์ · ค่าจ้างของฉันตั้งแล้วหรือยัง */
router.get("/config", verifyToken, async (req, res) => {
  try {
    if (!canUseOt(req)) return res.status(403).json({ message: "คุณไม่มีสิทธิ์ใช้งานระบบ OT" });
    const cfg = await otConfig();
    const mine = await OtWage.findOne({ userId: String(req.userId) }).select("hourlyRate").lean();
    res.json({ ...cfg, holidays: HOLIDAYS, typeLabels: TYPE_LABEL, myRateSet: Boolean(mine?.hourlyRate) });
  } catch (err) {
    console.error("❌ ดึงค่าตั้งต้น OT ไม่สำเร็จ:", err);
    res.status(500).json({ message: "ดึงค่าตั้งต้นไม่สำเร็จ" });
  }
});

router.get("/summary", verifyToken, async (req, res) => {
  try {
    if (!canUseOt(req)) return res.status(403).json({ message: "คุณไม่มีสิทธิ์ใช้งานระบบ OT" });
    const scope = scopeFor(req);
    const uid = String(req.userId || "");
    const mine = { $or: [{ "requester.userId": uid }, { "createdBy.userId": uid }] };
    const notMine = can(req.user, "approveOwnExpense") ? {} : { memberIds: { $ne: uid }, "requester.userId": { $ne: uid } };
    const [pending, reviewing, approved, rejectedMine, inboxPending, inboxReviewing] = await Promise.all([
      OtRequest.countDocuments({ ...scope, status: "pending" }),
      OtRequest.countDocuments({ ...scope, status: "reviewed" }),
      OtRequest.countDocuments({ ...scope, status: "approved" }),
      OtRequest.countDocuments({ ...mine, status: "rejected" }),
      can(req.user, "reviewExpense") ? OtRequest.countDocuments({ ...notMine, status: "pending" }) : 0,
      can(req.user, "approveExpense")
        ? OtRequest.countDocuments({ ...notMine, status: "reviewed", ...(can(req.user, "approveOwnReview") ? {} : { "reviewedBy.userId": { $ne: uid } }) })
        : 0,
    ]);
    res.json({ pending, reviewing, approved, rejectedMine, inbox: inboxPending + inboxReviewing });
  } catch (err) {
    console.error("❌ สรุป OT ไม่สำเร็จ:", err);
    res.status(500).json({ message: "ดึงสรุปไม่สำเร็จ" });
  }
});

/** รายชื่อพนักงาน (ให้หัวหน้างานเลือกลูกทีม) — ไม่มีค่าจ้าง */
router.get("/people", verifyToken, async (req, res) => {
  try {
    if (!canUseOt(req)) return res.status(403).json({ message: "คุณไม่มีสิทธิ์ใช้งานระบบ OT" });
    const users = await User.find({}).select("fname lname username rank role jobTitle imageUrl").sort({ fname: 1 }).lean();
    res.json({ users: users.map((u) => ({ userId: String(u._id), name: personName(u), fullName: fullNameOf(u), position: titleOf(u), imageUrl: u.imageUrl || "" })) });
  } catch (err) {
    console.error("❌ ดึงรายชื่อไม่สำเร็จ:", err);
    res.status(500).json({ message: "ดึงรายชื่อไม่สำเร็จ" });
  }
});

// ── ทะเบียนค่าจ้างต่อชั่วโมง (ลับ) ───────────────────────────────────────
router.get("/wages", verifyToken, async (req, res) => {
  try {
    if (!can(req.user, "viewAllExpenses")) return res.status(403).json({ message: "เฉพาะผู้มีสิทธิ์ดูข้อมูลค่าจ้างเท่านั้น" });
    const [users, wages, cfg] = await Promise.all([
      User.find({}).select("fname lname username rank role jobTitle").sort({ fname: 1 }).lean(),
      OtWage.find({}).lean(),
      otConfig(),
    ]);
    const byId = new Map(wages.map((w) => [w.userId, w]));
    res.json({
      hoursPerDay: cfg.hoursPerDay,
      rows: users.map((u) => {
        const w = byId.get(String(u._id));
        return {
          userId: String(u._id), fullName: fullNameOf(u), position: titleOf(u),
          basis: w?.basis || "monthly", baseAmount: w?.baseAmount || 0, hourlyRate: w?.hourlyRate || 0,
          updatedAt: w?.updatedAt || null, updatedBy: w?.updatedBy?.name || "",
        };
      }),
    });
  } catch (err) {
    console.error("❌ ดึงค่าจ้าง OT ไม่สำเร็จ:", err);
    res.status(500).json({ message: "ดึงข้อมูลค่าจ้างไม่สำเร็จ" });
  }
});

/**
 * ตั้งค่าจ้างของพนักงาน — basis: monthly (เงินเดือน ÷ 30 ÷ ชั่วโมงต่อวัน) · daily (÷ ชั่วโมงต่อวัน) · hourly
 * ✅ สูตรเงินเดือน ÷ 30 ÷ 8 เป็นวิธีมาตรฐานตามกฎหมายแรงงานไทย (ม.68)
 * ⚠️ ใบ OT ที่บันทึกไปแล้วไม่เปลี่ยนตาม (เก็บสำเนาค่าจ้างต่อชั่วโมงไว้ในบรรทัด) — ใบที่ยังรอตรวจ/ถูกตีกลับ
 *    จะคิดใหม่เมื่อแก้ไขใบ หรือกด "คำนวณใหม่" ตอนตรวจสอบ
 */
router.put("/wages/:userId", verifyToken, async (req, res) => {
  try {
    if (!can(req.user, "viewAllExpenses")) return res.status(403).json({ message: "เฉพาะผู้มีสิทธิ์ดูข้อมูลค่าจ้างเท่านั้น" });
    const userId = String(req.params.userId || "");
    if (!isId(userId) || !(await User.exists({ _id: userId }))) return res.status(404).json({ message: "ไม่พบพนักงาน" });
    const basis = ["monthly", "daily", "hourly"].includes(req.body.basis) ? req.body.basis : "monthly";
    const baseAmount = money(req.body.baseAmount);
    if (baseAmount < 0 || baseAmount > 10_000_000) return res.status(400).json({ message: "จำนวนเงินไม่ถูกต้อง" });
    const { hoursPerDay } = await otConfig();
    const hourlyRate = money(basis === "monthly" ? baseAmount / 30 / hoursPerDay : basis === "daily" ? baseAmount / hoursPerDay : baseAmount);
    const me = actor(req);
    const w = await OtWage.findOneAndUpdate(
      { userId },
      { $set: { basis, baseAmount, hourlyRate, updatedBy: me } },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    ).lean();
    res.json({ wage: { userId, basis: w.basis, baseAmount: w.baseAmount, hourlyRate: w.hourlyRate, updatedAt: w.updatedAt, updatedBy: me.name } });
  } catch (err) {
    console.error("❌ บันทึกค่าจ้าง OT ไม่สำเร็จ:", err);
    res.status(500).json({ message: "บันทึกค่าจ้างไม่สำเร็จ" });
  }
});

/**
 * รายงาน OT รายเดือน (รอบเงินเดือน) — แยกรายคน รายประเภท · ใช้ทำเงินเดือน
 * 🔒 viewAllExpenses เท่านั้น (มียอดเงินของทุกคน)
 */
router.get("/report", verifyToken, async (req, res) => {
  try {
    if (!can(req.user, "viewAllExpenses")) return res.status(403).json({ message: "เฉพาะผู้มีสิทธิ์ดูรายงานค่าจ้างเท่านั้น" });
    const period = /^\d{4}-\d{2}$/.test(String(req.query.period || "")) ? String(req.query.period) : moment().utcOffset(7).format("YYYY-MM");
    const docs = await OtRequest.find({ period, status: { $nin: ["cancelled"] } }).select("-activityLog").sort({ docNo: 1 }).lean();
    const people = new Map();
    docs.forEach((d) => d.lines.forEach((l) => {
      const p = people.get(l.person.userId) || {
        userId: l.person.userId, name: l.person.name,
        approved: { hours: 0, amount: 0, byType: {} }, waiting: { hours: 0, amount: 0 }, paid: { hours: 0, amount: 0 },
      };
      const bucket = ["approved"].includes(d.status) ? "approved" : d.status === "paid" ? "paid" : "waiting";
      p[bucket].hours = Math.round((p[bucket].hours + l.hours) * 100) / 100;
      p[bucket].amount = money(p[bucket].amount + l.amount);
      if (bucket !== "waiting") {
        const t = p.approved.byType[l.type] || { hours: 0, amount: 0 };
        t.hours = Math.round((t.hours + l.hours) * 100) / 100;
        t.amount = money(t.amount + l.amount);
        p.approved.byType[l.type] = t;
      }
      people.set(l.person.userId, p);
    }));
    const missingRate = [...new Set(docs.flatMap((d) => d.lines.filter((l) => !l.hourlyRate).map((l) => l.person.name)))];
    res.json({
      period,
      people: [...people.values()].sort((a, b) => a.name.localeCompare(b.name, "th")),
      docs: docs.map((d) => ({ _id: d._id, docNo: d.docNo, status: d.status, requester: d.requester, totalHours: d.totalHours, totalAmount: d.totalAmount, payroll: d.payroll })),
      approvedCount: docs.filter((d) => d.status === "approved").length,
      missingRate,
    });
  } catch (err) {
    console.error("❌ รายงาน OT ไม่สำเร็จ:", err);
    res.status(500).json({ message: "ดึงรายงานไม่สำเร็จ" });
  }
});

/**
 * ปิดรอบจ่าย OT พร้อมเงินเดือน — ทุกใบที่ "อนุมัติแล้ว" ของรอบนั้น → จ่ายแล้ว
 * 🔒 disburseExpense (ผู้อนุมัติเบิกจ่าย) · ใบที่ยังไม่อนุมัติไม่ถูกแตะ (ไปรอบถัดไปเมื่ออนุมัติ)
 */
router.post("/payroll/close", verifyToken, async (req, res) => {
  try {
    if (!can(req.user, "disburseExpense")) return res.status(403).json({ message: "เฉพาะผู้อนุมัติเบิกจ่ายเท่านั้นที่ปิดรอบจ่ายได้" });
    const period = String(req.body?.period || "");
    if (!/^\d{4}-\d{2}$/.test(period)) return res.status(400).json({ message: "กรุณาระบุรอบเงินเดือน" });
    const me = actor(req);
    const note = String(req.body?.note || "").trim().slice(0, 300);
    const docs = await OtRequest.find({ period, status: "approved" });
    if (!docs.length) return res.status(409).json({ message: "ไม่มีใบ OT ที่อนุมัติแล้วรอจ่ายในรอบนี้" });
    const at = new Date();
    for (const d of docs) {
      d.status = "paid";
      d.payroll = { period, at, by: me, note };
      log(d, "paid", `จ่ายพร้อมเงินเดือนรอบ ${period}${note ? ` · ${note}` : ""}`, me);
      // eslint-disable-next-line no-await-in-loop -- จำนวนใบต่อเดือนไม่มาก และต้องบันทึกประวัติรายใบ
      await d.save();
      notifyUsers([...d.memberIds, d.requester.userId], me, {
        title: "💰 OT จ่ายพร้อมเงินเดือนแล้ว",
        body: `${summaryLine(d)} · รอบ ${period}`,
        url: urlOf(d), tag: `ot-${d._id}`,
      });
    }
    res.json({ closed: docs.length, amount: money(docs.reduce((s, d) => s + d.totalAmount, 0)) });
  } catch (err) {
    console.error("❌ ปิดรอบจ่าย OT ไม่สำเร็จ:", err);
    res.status(500).json({ message: "ปิดรอบจ่ายไม่สำเร็จ" });
  }
});

/** รายการใบ (ตามขอบเขต) */
router.get("/", verifyToken, async (req, res) => {
  try {
    if (!canUseOt(req)) return res.status(403).json({ message: "คุณไม่มีสิทธิ์ใช้งานระบบ OT" });
    const query = { ...scopeFor(req) };
    const statuses = String(req.query.status || "").split(",").filter((s) => OtRequest.STATUS.includes(s));
    if (statuses.length) query.status = { $in: statuses };
    if (/^\d{4}-\d{2}$/.test(String(req.query.period || ""))) query.period = String(req.query.period);
    const docs = await OtRequest.find(query).select("-activityLog").sort({ createdAt: -1 }).limit(500).lean();
    res.json({ requests: docs.map((d) => redact(req, d)) });
  } catch (err) {
    console.error("❌ ดึงรายการ OT ไม่สำเร็จ:", err);
    res.status(500).json({ message: "ดึงรายการไม่สำเร็จ" });
  }
});

/** ยื่นใบ OT */
router.post("/", verifyToken, async (req, res) => {
  try {
    if (!canUseOt(req)) return res.status(403).json({ message: "คุณไม่มีสิทธิ์ยื่น OT" });
    const cfg = await otConfig();
    const built = await buildLines(req.body.lines, cfg);
    if (built.error) return res.status(400).json({ message: built.error });
    const clash = await crossDocOverlap(built.lines);
    if (clash) return res.status(409).json({ message: clash });
    const me = actor(req);
    const doc = new OtRequest({
      docNo: await nextDocNo(),
      status: "pending",
      docDate: parseDay(req.body.docDate) || todayNoonUtc(),
      subject: String(req.body.subject || "").trim().slice(0, 300),
      note: String(req.body.note || "").trim().slice(0, 1000),
      requester: { userId: me.userId, name: me.name, position: titleOf(req.user) },
      createdBy: me,
      submittedAt: new Date(),
    });
    applyLines(doc, built.lines);
    if (!doc.subject) doc.subject = `ขออนุมัติ OT ${doc.lines.length > 1 ? `${new Set(doc.memberIds).size} คน ` : ""}รวม ${doc.totalHours} ชม.`;
    log(doc, "created", `ยื่นขอ OT ${doc.lines.length} รายการ รวม ${doc.totalHours} ชม.`, me);
    await saveWithDocNo(doc);

    notifyCap("reviewExpense", me, {
      title: "📝 รอตรวจสอบ · ใบขอ OT",
      body: `${summaryLine(doc)}\nยื่นโดย ${fullNameOf(req.user)}\nกรุณาตรวจสอบเวลาและงานที่ทำ`,
      url: urlOf(doc), tag: `ot-${doc._id}`, renotify: true,
    });
    const others = doc.memberIds.filter((id) => id !== me.userId);
    if (others.length) {
      notifyUsers(others, me, { title: `⏱️ ${me.name} ยื่น OT ให้คุณ`, body: summaryLine(doc), url: urlOf(doc), tag: `ot-${doc._id}` });
    }
    res.status(201).json({ request: redact(req, doc) });
  } catch (err) {
    console.error("❌ ยื่น OT ไม่สำเร็จ:", err);
    res.status(500).json({ message: "ยื่น OT ไม่สำเร็จ" });
  }
});

// ══ /:id ══════════════════════════════════════════════════════════════════

const loadVisible = async (req, res) => {
  if (!isId(req.params.id)) { res.status(404).json({ message: "ไม่พบใบ OT นี้" }); return null; }
  const doc = await OtRequest.findById(req.params.id);
  if (!doc) { res.status(404).json({ message: "ไม่พบใบ OT นี้" }); return null; }
  if (!canSee(req, doc)) { res.status(403).json({ message: "คุณไม่มีสิทธิ์ดูใบ OT นี้" }); return null; }
  return doc;
};

router.get("/:id", verifyToken, async (req, res) => {
  try {
    const doc = await loadVisible(req, res);
    if (!doc) return;
    res.json({ request: redact(req, doc) });
  } catch (err) {
    console.error("❌ ดึงใบ OT ไม่สำเร็จ:", err);
    res.status(500).json({ message: "ดึงใบ OT ไม่สำเร็จ" });
  }
});

/** แก้ไข (รอตรวจสอบ/ถูกตีกลับ) — ถูกตีกลับแล้วแก้ = ส่งใหม่ */
router.put("/:id", verifyToken, async (req, res) => {
  try {
    const doc = await loadVisible(req, res);
    if (!doc) return;
    if (!["pending", "rejected"].includes(doc.status) || !(isOwner(req, doc) || can(req.user, "viewAllExpenses"))) {
      return res.status(409).json({ message: "แก้ไขได้เฉพาะใบที่รอตรวจสอบหรือถูกตีกลับ โดยผู้ยื่นเท่านั้น" });
    }
    const me = actor(req);
    const wasRejected = doc.status === "rejected";
    if (req.body.lines !== undefined) {
      const built = await buildLines(req.body.lines, await otConfig());
      if (built.error) return res.status(400).json({ message: built.error });
      const clash = await crossDocOverlap(built.lines, doc._id);
      if (clash) return res.status(409).json({ message: clash });
      applyLines(doc, built.lines);
    }
    if (req.body.subject !== undefined) doc.subject = String(req.body.subject || "").trim().slice(0, 300) || doc.subject;
    if (req.body.note !== undefined) doc.note = String(req.body.note || "").trim().slice(0, 1000);
    if (req.body.docDate !== undefined) doc.docDate = parseDay(req.body.docDate) || doc.docDate;
    if (wasRejected) {
      doc.status = "pending";
      doc.submittedAt = new Date();
      doc.rejectReason = "";
      log(doc, "resubmitted", `แก้ไขและส่งใหม่ · รวม ${doc.totalHours} ชม.`, me);
    } else {
      log(doc, "updated", `แก้ไขใบ · รวม ${doc.totalHours} ชม.`, me);
    }
    await doc.save();
    if (wasRejected) {
      notifyCap("reviewExpense", me, { title: "📝 รอตรวจสอบ · ใบขอ OT (ส่งใหม่)", body: summaryLine(doc), url: urlOf(doc), tag: `ot-${doc._id}`, renotify: true });
    }
    res.json({ request: redact(req, doc) });
  } catch (err) {
    console.error("❌ แก้ไขใบ OT ไม่สำเร็จ:", err);
    res.status(500).json({ message: "แก้ไขไม่สำเร็จ" });
  }
});

/**
 * ตรวจสอบ — ✅ คำนวณเงินใหม่จากค่าจ้างปัจจุบัน (กรณีเพิ่งตั้งค่าจ้างให้พนักงานหลังยื่นใบ)
 * ⚠️ หลังขั้นนี้ยอดเงินถูกล็อก — แก้ค่าจ้างทีหลังไม่กระทบใบที่ตรวจแล้ว
 */
router.post("/:id/review", verifyToken, async (req, res) => {
  try {
    if (!can(req.user, "reviewExpense")) return res.status(403).json({ message: "คุณไม่มีสิทธิ์ตรวจสอบใบ OT" });
    const doc = await loadVisible(req, res);
    if (!doc) return;
    if (doc.status !== "pending") return res.status(409).json({ message: "ตรวจสอบได้เฉพาะใบที่รอตรวจสอบ" });
    if (selfInvolved(req, doc)) return res.status(403).json({ message: "ตรวจสอบใบ OT ที่ตัวเองมีชื่ออยู่ไม่ได้ — ให้หัวหน้าท่านอื่นตรวจ" });
    const me = actor(req);
    const wages = await wagesOf(doc.memberIds);
    doc.lines.forEach((l) => {
      const rate = money(wages.get(l.person.userId) || 0);
      l.hourlyRate = rate;
      l.amount = money(l.hours * l.multiplier * rate);
    });
    doc.totalAmount = money(doc.lines.reduce((s, l) => s + l.amount, 0));
    const missing = [...new Set(doc.lines.filter((l) => !l.hourlyRate).map((l) => l.person.name))];
    if (missing.length && !can(req.user, "viewAllExpenses")) {
      return res.status(409).json({ message: `ยังไม่ได้ตั้งค่าจ้างต่อชั่วโมงของ ${missing.join(", ")} — แจ้งผู้ดูแลค่าจ้างก่อนตรวจสอบ` });
    }
    if (missing.length) return res.status(409).json({ message: `ยังไม่ได้ตั้งค่าจ้างต่อชั่วโมงของ ${missing.join(", ")} — ตั้งที่เมนู "ค่าจ้างต่อชั่วโมง" ก่อน` });
    const note = String(req.body?.note || "").trim().slice(0, 500);
    doc.status = "reviewed";
    doc.reviewedBy = me;
    doc.reviewedAt = new Date();
    log(doc, "reviewed", `ตรวจสอบแล้ว ${doc.totalHours} ชม.${note ? ` · ${note}` : ""}`, me);
    await doc.save();
    notifyCap("approveExpense", me, { title: "🔎 รออนุมัติ · ใบขอ OT", body: `${summaryLine(doc)}\nตรวจสอบโดย ${fullNameOf(req.user)}`, url: urlOf(doc), tag: `ot-${doc._id}`, renotify: true });
    res.json({ request: redact(req, doc) });
  } catch (err) {
    console.error("❌ ตรวจสอบใบ OT ไม่สำเร็จ:", err);
    res.status(500).json({ message: "ตรวจสอบไม่สำเร็จ" });
  }
});

/** อนุมัติ → รอรวมจ่ายกับเงินเดือน */
router.post("/:id/approve", verifyToken, async (req, res) => {
  try {
    if (!can(req.user, "approveExpense")) return res.status(403).json({ message: "คุณไม่มีสิทธิ์อนุมัติใบ OT" });
    const doc = await loadVisible(req, res);
    if (!doc) return;
    if (doc.status !== "reviewed") return res.status(409).json({ message: doc.status === "pending" ? "ใบนี้ยังไม่ผ่านการตรวจสอบ" : "อนุมัติได้เฉพาะใบที่ตรวจสอบแล้ว" });
    if (selfInvolved(req, doc)) return res.status(403).json({ message: "อนุมัติใบ OT ที่ตัวเองมีชื่ออยู่ไม่ได้" });
    if (doc.reviewedBy?.userId === String(req.userId) && !can(req.user, "approveOwnReview")) {
      return res.status(403).json({ message: "คุณเป็นผู้ตรวจสอบใบนี้แล้ว — ให้หัวหน้าท่านอื่นอนุมัติ" });
    }
    const me = actor(req);
    const note = String(req.body?.note || "").trim().slice(0, 500);
    doc.status = "approved";
    doc.approvedBy = me;
    doc.approvedAt = new Date();
    log(doc, "approved", `อนุมัติ ${doc.totalHours} ชม. · ${fullBaht(doc.totalAmount)} รวมจ่ายกับเงินเดือนรอบ ${doc.period}${note ? ` · ${note}` : ""}`, me);
    await doc.save();
    notifyUsers([...doc.memberIds, doc.requester.userId], me, {
      title: "✅ OT ได้รับอนุมัติแล้ว",
      body: `${summaryLine(doc)}\nจ่ายพร้อมเงินเดือนรอบ ${doc.period}`,
      url: urlOf(doc), tag: `ot-${doc._id}`, renotify: true,
    });
    res.json({ request: redact(req, doc) });
  } catch (err) {
    console.error("❌ อนุมัติใบ OT ไม่สำเร็จ:", err);
    res.status(500).json({ message: "อนุมัติไม่สำเร็จ" });
  }
});

router.post("/:id/reject", verifyToken, async (req, res) => {
  try {
    const doc = await loadVisible(req, res);
    if (!doc) return;
    const capOf = { pending: "reviewExpense", reviewed: "approveExpense", approved: "disburseExpense" }[doc.status];
    if (!capOf || !can(req.user, capOf)) return res.status(403).json({ message: "คุณตีกลับใบนี้ในขั้นนี้ไม่ได้" });
    const reason = String(req.body?.reason || "").trim().slice(0, 500);
    if (!reason) return res.status(400).json({ message: "กรุณาระบุเหตุผลที่ตีกลับ" });
    const me = actor(req);
    const prior = [doc.reviewedBy?.userId, doc.approvedBy?.userId];
    doc.status = "rejected";
    doc.reviewedBy = { userId: "", name: "" }; doc.reviewedAt = null;
    doc.approvedBy = { userId: "", name: "" }; doc.approvedAt = null;
    doc.rejectedBy = me; doc.rejectedAt = new Date(); doc.rejectReason = reason;
    log(doc, "rejected", `ตีกลับ · ${reason}`, me);
    await doc.save();
    notifyUsers([doc.requester.userId, doc.createdBy.userId, ...prior], me, {
      title: "↩️ ใบขอ OT ถูกตีกลับ", body: `${doc.docNo}\nเหตุผล: ${reason}`, url: urlOf(doc), tag: `ot-${doc._id}`, renotify: true,
    });
    res.json({ request: redact(req, doc) });
  } catch (err) {
    console.error("❌ ตีกลับใบ OT ไม่สำเร็จ:", err);
    res.status(500).json({ message: "ตีกลับไม่สำเร็จ" });
  }
});

router.post("/:id/cancel", verifyToken, async (req, res) => {
  try {
    const doc = await loadVisible(req, res);
    if (!doc) return;
    const ownerCan = isOwner(req, doc) && ["pending", "rejected"].includes(doc.status);
    const approverCan = ["pending", "rejected", "reviewed", "approved"].includes(doc.status)
      && (can(req.user, "approveExpense") || can(req.user, "disburseExpense"));
    if (!ownerCan && !approverCan) return res.status(409).json({ message: doc.status === "paid" ? "ใบที่จ่ายพร้อมเงินเดือนแล้วยกเลิกไม่ได้" : "ใบนี้ยกเลิกไม่ได้แล้ว" });
    const me = actor(req);
    const reason = String(req.body?.reason || "").trim().slice(0, 500);
    doc.status = "cancelled";
    doc.cancelledBy = me; doc.cancelledAt = new Date(); doc.cancelReason = reason;
    log(doc, "cancelled", `ยกเลิก${reason ? ` · ${reason}` : ""}`, me);
    await doc.save();
    notifyUsers([doc.requester.userId, ...doc.memberIds], me, { title: "🚫 ใบขอ OT ถูกยกเลิก", body: `${doc.docNo}${reason ? ` · ${reason}` : ""}`, url: urlOf(doc), tag: `ot-${doc._id}` });
    res.json({ request: redact(req, doc) });
  } catch (err) {
    console.error("❌ ยกเลิกใบ OT ไม่สำเร็จ:", err);
    res.status(500).json({ message: "ยกเลิกไม่สำเร็จ" });
  }
});

module.exports = router;
module.exports.__test = { hoursOf, toMin };
