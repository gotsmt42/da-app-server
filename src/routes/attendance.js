/**
 * /api/attendance — เช็คอินเข้างานของช่าง (10 ต.ค. 2569)
 *
 *   GET  /event/:eventId              บันทึกเช็คอินของงานนี้ (?group=1 = ทั้งงานหลายวัน · ?site=1 = พิกัดหน้างานด้วย)
 *   GET  /                            รายการ (แอดมินเห็นทุกคน · คนอื่นเห็นของตัวเอง) ?from&to&userId&pending=1
 *   POST /check-in                    เช็คอิน { eventId, gps, lat, lng, accuracy, note, photoIds[] }
 *   POST /:id/corrections             ขอแก้เวลา { field, toAt, reason } (แอดมินยื่น = อนุมัติทันที)
 *   PUT  /:id/corrections/:cid        แอดมินอนุมัติ/ไม่อนุมัติ { decision, note }
 *
 * 🧹 (11 ต.ค. 2569 ผู้ใช้: "ตัดระบบเช็คเอาต์ออก ช่างต้องวิ่งหลายงาน ทำงานได้ยาก")
 *    ตัดเช็คเอาต์ออกทั้งหมด (route /mine/active และ /:id/check-out) — เช็คอิน = บันทึกการมาถึงหน้างาน 1 ครั้ง/งาน/วัน
 *    ไม่มีสถานะ "ค้างเช็คอิน" ช่างไปงานถัดไปได้เลย · สรุปงาน/Service Report ทำที่ "เอกสารประจำงาน" ตามขั้นตอนเดิม
 *    ⚠️ ข้อมูลเช็คเอาต์ของรายการเก่า (checkOut.*) ยังอยู่ หน้าจอแสดงให้ถ้ามี
 *
 * 🔒 เวลาเช็คอิน = เวลา server ตอนรับคำขอเสมอ — ไม่มีช่องรับเวลาจากเครื่องช่าง
 *    แก้เวลาได้ทางเดียวคือคำขอแก้เวลา → แอดมินอนุมัติ (เก็บประวัติทุกครั้งใน corrections)
 * 🔗 เชื่อมกับระบบเดิม: Events.checkedInAt · สถานะ → "กำลังดำเนินการ" · activityLog (check_in/time_corrected)
 *    · รูปหน้างานเข้า "ไฟล์แนบ" (sitePhotoFiles) ของงาน · เช็คอิน = รับทราบงานไปในตัว
 */
const express = require("express");
const Attendance = require("../models/Attendance");
const CalendarEvent = require("../models/Events");
const Customer = require("../models/Customer");
const verifyToken = require("../middleware/auth");
const { can, SUPERVISOR_ROLES, effectiveCapabilities } = require("../config/roles");
const { sendPushToUsers, sendPushToRoles } = require("../services/PushNotify");
const { resolveMapUrl } = require("../services/mapEmbed");

const router = express.Router();

const CLOSED = "ดำเนินการเสร็จสิ้น";

const personName = (u) => [u?.fname, u?.lname].filter(Boolean).join(" ") || u?.username || "ผู้ใช้";
const jobLabelOf = (ev) => `${ev.title || "งาน"} · ${ev.site || ev.company || "-"}`;
const groupFilter = (ev) => (ev.jobGroupId ? { jobGroupId: ev.jobGroupId } : { _id: ev._id });
const canApprove = (user) => can(user, "approveJobs");
const approverRanks = () => effectiveCapabilities().approveJobs || SUPERVISOR_ROLES;

/** ช่างที่ได้รับมอบหมายงานนี้ (หัวหน้าทีม · ลูกทีม · ผู้รับผิดชอบ) — ตรงกับ isParticipant ใน jobflow.js */
const isParticipant = (ev, user, userId) => {
  const uid = String(userId || "");
  const fname = user?.fname || "";
  return Boolean(
    (ev.resPerson && String(ev.resPerson) === uid) ||
    (ev.responsiblePersonId && String(ev.responsiblePersonId) === uid) ||
    (fname && (ev.team === fname || ev.responsiblePerson === fname)) ||
    (ev.teamMembers || []).some((m) => (m?.userId && String(m.userId) === uid) || (fname && m?.name === fname))
  );
};

/**
 * ✅ (10 ต.ค. 2569 ผู้ใช้: "เช็คอินให้ยึดหัวหน้าทีมเป็นหลัก แสดงชื่อลูกทีมด้วย ต้องสอดคล้องกับงานใน event ไม่ใช่กดก่อนได้ ต้องตามขั้นตอน")
 *    คนที่เช็คอิน/เช็คเอาต์ได้ = "หัวหน้าทีมเข้างาน" ของวันนั้น (resPerson / team) เท่านั้น — 1 บันทึกต่อทีมต่อวัน
 */
const isTeamHead = (ev, user, userId) =>
  Boolean(
    (ev.resPerson && String(ev.resPerson) === String(userId)) ||
    (user?.fname && ev.team === user.fname) ||
    (!ev.team && !ev.resPerson && (
      (ev.responsiblePersonId && String(ev.responsiblePersonId) === String(userId)) ||
      (user?.fname && ev.responsiblePerson === user.fname)
    ))
  );
const membersOf = (ev) => [...new Set((ev.teamMembers || []).map((m) => m?.name).filter((n) => n && n !== ev.team))];

/**
 * บันทึกเก่า (ก่อนเก็บทีมไว้ในรายการ) — เติมหัวหน้าทีม/ลูกทีมจากงานตอนอ่าน ให้หน้าจอแสดงทีมได้ทุกรายการ
 * ⚠️ แค่เติมในคำตอบ ไม่เขียนกลับฐานข้อมูล
 */
async function withTeam(rows) {
  const need = rows.filter((r) => !r.team?.head);
  if (!need.length) return rows;
  const evs = await CalendarEvent.find({ _id: { $in: [...new Set(need.map((r) => String(r.eventId)))] } }).select("team teamMembers").lean();
  const byId = new Map(evs.map((e) => [String(e._id), e]));
  need.forEach((r) => {
    const ev = byId.get(String(r.eventId));
    r.team = { head: ev?.team || "", members: ev ? membersOf(ev) : [] };
  });
  return rows;
}

/** วันที่ตามเวลาไทย "YYYY-MM-DD" */
const bkkDay = (d) => new Date(new Date(d).getTime() + 7 * 3600 * 1000).toISOString().slice(0, 10);
const addDays = (day, n) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const thTime = (d) => new Date(d).toLocaleString("th-TH", { timeZone: "Asia/Bangkok", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/** ระยะทางบนผิวโลก (เมตร) */
function haversineM(a, b) {
  const R = 6371000;
  const toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(s)));
}

/** พิกัดหน้างานจากลิงก์ Google Maps ในทะเบียนลูกค้า — หาไม่ได้/ช้าเกิน 4 วิ = null (ไม่บล็อกการเช็คอิน) */
async function siteCoordsOf(ev) {
  try {
    const cust = await Customer.findOne({ cCompany: ev.company || "", cSite: ev.site || "" }).select("mapUrl").lean()
      || await Customer.findOne({ cSite: ev.site || "" }).select("mapUrl").lean();
    if (!cust?.mapUrl) return null;
    const r = await Promise.race([
      resolveMapUrl(cust.mapUrl),
      new Promise((resolve) => setTimeout(() => resolve(null), 4000)),
    ]);
    return r && Number.isFinite(r.lat) && Number.isFinite(r.lng) ? { lat: r.lat, lng: r.lng } : null;
  } catch {
    return null;
  }
}

/** อ่านตำแหน่งจากคำขอ — ค่าพิกัดผิดรูปแบบถือว่าไม่มี */
function readStamp(body = {}, site) {
  const lat = Number(body.lat);
  const lng = Number(body.lng);
  const ok = body.gps === "ok" && Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
  const stamp = {
    at: new Date(), // 🔒 เวลา server เท่านั้น
    gps: ok ? "ok" : body.gps === "denied" ? "denied" : "unavailable",
  };
  if (ok) {
    stamp.lat = lat;
    stamp.lng = lng;
    const acc = Number(body.accuracy);
    if (Number.isFinite(acc) && acc >= 0) stamp.accuracy = Math.round(acc);
    if (site) stamp.distanceM = haversineM(site, { lat, lng });
  }
  return stamp;
}

/**
 * ไฟล์ที่ส่งมา (fileId) ต้องเป็นไฟล์ในงานนี้จริง
 * @param list  รายการไฟล์ของงาน (sitePhotoFiles = รูป/ไฟล์หน้างาน · reportFiles = Service Report)
 * @param stage ติดป้าย "before"/"after" ให้หน้ารูปหน้างานแสดงได้ (เฉพาะรูปหน้างาน)
 */
function takeFiles(list, ids, stage) {
  const want = new Set((Array.isArray(ids) ? ids : []).map(String).slice(0, 20));
  const out = [];
  (list || []).forEach((f) => {
    if (!want.has(String(f._id))) return;
    if (stage) f.stage = stage;
    out.push({ fileId: String(f._id), fileUrl: f.fileUrl, fileName: f.fileName, fileType: f.fileType });
  });
  return out;
}

const minutesBetween = (a, b) => Math.max(0, Math.round((new Date(b) - new Date(a)) / 60000));
const distText = (m) => (m == null ? "" : m >= 1000 ? `${(m / 1000).toFixed(1)} กม.` : `${m} ม.`);

/** ให้ checkedInAt/checkedOutAt ของงานตรงกับบันทึกจริง (เช็คอินแรกสุด · เช็คเอาต์ล่าสุด) */
async function syncEventTimes(eventId) {
  const rows = await Attendance.find({ eventId }).select("checkIn.at checkOut.at status").lean();
  const ins = rows.map((r) => r.checkIn?.at).filter(Boolean).map((d) => new Date(d).getTime());
  const outs = rows.filter((r) => r.status === "checked_out").map((r) => r.checkOut?.at).filter(Boolean).map((d) => new Date(d).getTime());
  await CalendarEvent.updateOne({ _id: eventId }, {
    $set: {
      checkedInAt: ins.length ? new Date(Math.min(...ins)) : null,
      checkedOutAt: outs.length ? new Date(Math.max(...outs)) : null,
    },
  });
}

// ── บันทึกเข้างานของหลายงานในคำขอเดียว ────────────────────────────────────────
// ✅ (11 ต.ค. 2569 แก้แอพช้า) การ์ดงานแต่ละใบ (งานของฉัน/การดำเนินงาน) เคยยิง /event/:id ของตัวเอง
//    หน้าเดียวจึงยิงหลายสิบคำขอพร้อมกัน — หน้าเว็บรวมเป็นคำขอเดียวผ่านเส้นนี้ (ดู AttendanceService.ofEvent)
//    ⚠️ ต้องอยู่ก่อน "/event/:eventId" · งานที่ไม่มีสิทธิ์ดู = ไม่ส่งกลับ (หน้าจอแสดงว่ายังไม่มีบันทึก)
router.get("/events", verifyToken, async (req, res) => {
  try {
    const ids = [...new Set(String(req.query.ids || "").split(",").filter((x) => /^[a-f0-9]{24}$/i.test(x)))].slice(0, 300);
    if (!ids.length) return res.json({ byEvent: {}, serverNow: new Date() });
    const evs = await CalendarEvent.find({ _id: { $in: ids } }).select("resPerson responsiblePersonId team responsiblePerson teamMembers userId").lean();
    const all = can(req.user, "viewAllJobs");
    const allowed = evs.filter((ev) => all || isParticipant(ev, req.user, req.userId) || String(ev.userId) === String(req.userId)).map((ev) => ev._id);
    const rows = allowed.length ? await withTeam(await Attendance.find({ eventId: { $in: allowed } }).sort({ "checkIn.at": -1 }).lean()) : [];
    const byEvent = {};
    allowed.forEach((id) => { byEvent[String(id)] = []; });
    rows.forEach((r) => { (byEvent[String(r.eventId)] ||= []).push(r); });
    res.json({ byEvent, serverNow: new Date() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "โหลดข้อมูลไม่สำเร็จ" });
  }
});

// ── บันทึกเข้า-ออกของงาน ────────────────────────────────────────────────────
router.get("/event/:eventId", verifyToken, async (req, res) => {
  try {
    const ev = await CalendarEvent.findById(req.params.eventId).select("jobGroupId resPerson responsiblePersonId team responsiblePerson teamMembers userId company site").lean();
    if (!ev) return res.status(404).json({ message: "ไม่พบงาน" });
    if (!can(req.user, "viewAllJobs") && !isParticipant(ev, req.user, req.userId) && String(ev.userId) !== String(req.userId)) {
      return res.status(403).json({ message: "ไม่มีสิทธิ์ดูข้อมูลงานนี้" });
    }
    const filter = req.query.group === "1" && ev.jobGroupId ? { jobGroupId: ev.jobGroupId } : { eventId: ev._id };
    const rows = await withTeam(await Attendance.find(filter).sort({ "checkIn.at": -1 }).lean());
    // ?site=1 — พิกัดหน้างาน ให้หน้าเช็คอินบอกระยะห่างได้ก่อนกดยืนยัน (ไม่ส่งมา = ไม่เสียเวลาแปลงลิงก์)
    const site = req.query.site === "1" ? await siteCoordsOf(ev) : undefined;
    res.json({ attendance: rows, site, serverNow: new Date() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "โหลดข้อมูลไม่สำเร็จ" });
  }
});

// ── รายการ (รายงาน/คำขอแก้เวลา) ────────────────────────────────────────────
router.get("/", verifyToken, async (req, res) => {
  try {
    const all = can(req.user, "viewAllJobs") || canApprove(req.user);
    const q = {};
    if (!all) q.userId = req.userId;
    else if (req.query.userId) q.userId = req.query.userId;
    if (req.query.pending === "1") q.hasPendingCorrection = true;
    const day = /^\d{4}-\d{2}-\d{2}$/;
    if (day.test(req.query.from || "") || day.test(req.query.to || "")) {
      q["checkIn.at"] = {};
      // ช่วงวันที่ตามเวลาไทย (00:00 ไทย = 17:00 UTC ของวันก่อนหน้า)
      if (day.test(req.query.from || "")) q["checkIn.at"].$gte = new Date(`${req.query.from}T00:00:00+07:00`);
      if (day.test(req.query.to || "")) q["checkIn.at"].$lt = new Date(`${addDays(req.query.to, 1)}T00:00:00+07:00`);
    }
    let rows = await withTeam(await Attendance.find(q).sort({ "checkIn.at": -1 }).limit(1000).lean());
    // ✅ (11 ต.ค. 2569 ผู้ใช้: "งานไหนเสร็จแล้วให้ดีดออกจากหน้านี้ ไปเก็บในการดำเนินงาน" → เลือก "งานปิดแล้วเท่านั้น")
    //    รายการของงานที่ปิดแล้ว (ดำเนินการเสร็จสิ้น) ไม่แสดงในหน้าเข้า-ออกงาน — ดูได้ในการ์ดงานหน้าการดำเนินงาน
    //    ⚠️ แท็บคำขอแก้เวลา (pending=1) ยังแสดงครบ ไม่งั้นคำขอของงานที่ปิดแล้วจะค้างโดยไม่มีใครเห็น
    let closedHidden = 0;
    if (req.query.pending !== "1" && rows.length) {
      const closed = new Set((await CalendarEvent.find({ _id: { $in: [...new Set(rows.map((r) => String(r.eventId)))] }, status: CLOSED })
        .select("_id").lean()).map((e) => String(e._id)));
      const before = rows.length;
      rows = rows.filter((r) => !closed.has(String(r.eventId)));
      closedHidden = before - rows.length;
    }
    // ✅ (15 ต.ค. 2569 ผู้ใช้: "ให้แสดงรายละเอียดงานด้วย") — แนบข้อมูลงานปัจจุบัน (ประเภท · ระบบ · โครงการ · รายละเอียด)
    //    ⚠️ แค่แนบในคำตอบ · งานที่ถูกลบไปแล้วยังมี jobLabel/jobNo ที่จดไว้ตอนบันทึก
    if (rows.length) {
      const evs = await CalendarEvent.find({ _id: { $in: [...new Set(rows.map((r) => String(r.eventId)))] } })
        .select("title system site company description start end allDay status").lean();
      const byId = new Map(evs.map((e) => [String(e._id), e]));
      rows.forEach((r) => {
        const e = byId.get(String(r.eventId));
        if (e) r.job = { title: e.title || "", system: e.system || "", site: e.site || "", company: e.company || "", description: String(e.description || "").slice(0, 300), start: e.start, end: e.end, allDay: e.allDay, status: e.status || "" };
      });
    }
    const pendingCount = all ? await Attendance.countDocuments({ hasPendingCorrection: true }) : 0;
    res.json({ attendance: rows, pendingCount, closedHidden, serverNow: new Date() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "โหลดข้อมูลไม่สำเร็จ" });
  }
});

// ── เช็คอิน ────────────────────────────────────────────────────────────────
router.post("/check-in", verifyToken, async (req, res) => {
  try {
    const ev = await CalendarEvent.findById(req.body.eventId);
    if (!ev) return res.status(404).json({ message: "ไม่พบงาน" });
    if (ev.department === "sales") return res.status(400).json({ message: "นัดหมายฝ่ายขายไม่ใช้การกดเข้างาน" });
    if (ev.unscheduled || ev.cancelledAt) return res.status(400).json({ message: "งานนี้ยังไม่ได้ลงตาราง" });
    if (ev.status === CLOSED) return res.status(400).json({ message: "งานนี้ปิดแล้ว" });
    if (ev.approvalStatus === "pending" || ev.approvalStatus === "rejected") {
      return res.status(400).json({ message: "งานนี้ยังไม่ได้รับอนุมัติ — กดเข้างานได้หลังแอดมินอนุมัติ" });
    }
    // ✅ ตามขั้นตอน: มอบหมายหัวหน้าทีมแล้ว → หัวหน้าทีมกดเช็คอิน → ถึงวันเข้างานแล้วเท่านั้น
    if (!ev.team && !ev.resPerson && !ev.responsiblePersonId && !ev.responsiblePerson) {
      return res.status(400).json({ message: "งานนี้ยังไม่มีหัวหน้าทีมเข้างาน — รอแอดมินมอบหมายก่อน" });
    }
    if (!isTeamHead(ev, req.user, req.userId)) {
      return res.status(403).json({ message: `กดเข้างานได้เฉพาะหัวหน้าทีมเข้างาน${ev.team ? ` (${ev.team})` : ""}` });
    }
    {
      const today0 = bkkDay(new Date());
      const start0 = bkkDay(ev.start || ev.date);
      if (today0 < start0) {
        return res.status(400).json({ message: `ยังไม่ถึงวันเข้างาน — กดเข้างานได้ตั้งแต่ ${new Date(`${start0}T00:00:00+07:00`).toLocaleDateString("th-TH", { timeZone: "Asia/Bangkok", day: "numeric", month: "short", year: "numeric" })}` });
      }
    }

    // ✅ (11 ต.ค. 2569 ผู้ใช้: "หัวหน้าทีมช่าง หลังจากผู้รับผิดชอบยืนยันนัดหมาย กดบันทึกเข้างาน")
    //    ต้องยืนยันนัดหมายก่อน — ยกเว้นงานเก่าที่มีอยู่ก่อนเปิดใช้ขั้นตอนนี้และเลยวันเข้างานแล้ว (ตรงกับ isLegacyPreconfirmed ฝั่งหน้าจอ)
    {
      const FLOW_SINCE = new Date("2026-10-11T03:00:00.000Z");
      const legacy = ev.createdAt && ev.createdAt < FLOW_SINCE && bkkDay(ev.start) < bkkDay(new Date());
      if (ev.status === "กำลังรอยืนยัน" && !legacy) {
        return res.status(400).json({ message: "ผู้รับผิดชอบยังไม่ยืนยันนัดหมาย — ยืนยันนัดหมายก่อน จึงบันทึกเข้างานได้" });
      }
    }
    const site = await siteCoordsOf(ev);
    const stamp = readStamp(req.body, site);
    // ใช้เวลาจากเซิร์ฟเวอร์แปลงเป็นวันไทยเป็นค่าหลัก ไม่เชื่อวันจากเครื่องผู้ใช้
    const today = bkkDay(stamp.at);
    const dayStart = new Date(`${today}T00:00:00+07:00`);
    const dayEnd = new Date(`${addDays(today, 1)}T00:00:00+07:00`);

    // ซ่อมป้าย workDay ที่ข้อมูลรุ่นก่อนอาจผูกกับวันไม่ตรงกับเวลาเช็คอินจริง
    // ถ้าไม่แก้ ค่าเก่าของเมื่อวานอาจบล็อกการเช็คอินวันนี้ผ่าน unique index (eventId, workDay)
    const labeledToday = await Attendance.find({ eventId: ev._id, workDay: today, "checkIn.at": { $exists: true } })
      .select("_id checkIn.at").lean();
    const staleLabels = labeledToday.filter((r) => r.checkIn?.at && bkkDay(r.checkIn.at) !== today);
    if (staleLabels.length) {
      await Attendance.updateMany({ _id: { $in: staleLabels.map((r) => r._id) }, workDay: today }, { $unset: { workDay: 1 } });
    }

    // กันซ้ำจากเวลาเข้างานจริงในวันไทยนั้น; รองรับข้อมูลเก่าที่ไม่มี workDay
    // workDay เป็นตัวสำรองเฉพาะข้อมูลเก่าที่ไม่มี checkIn.at เท่านั้น
    const already = await Attendance.findOne({
      eventId: ev._id,
      $or: [
        { "checkIn.at": { $gte: dayStart, $lt: dayEnd } },
        { workDay: today, "checkIn.at": { $exists: false } },
        { workDay: today, "checkIn.at": null },
      ],
    }).sort({ "checkIn.at": -1 }).lean();
    if (already) {
      return res.status(409).json({ message: `งานนี้บันทึกเข้างานวันที่ ${today} แล้ว (${thTime(already.checkIn?.at)} โดย ${already.userName})`, attendance: already });
    }

    // 🐛 (15 ต.ค. 2569 ผู้ใช้: "การบันทึกเข้างาน เด้งมาให้กดซ้ำทั้งที่งานเข้าวันเดียว")
    //    งานนัดไว้ N วัน = บันทึกเข้างานได้ N วัน — เข้าช้ากว่านัด (นอกวันนัด) ก็นับเป็นวันของงานนั้น
    //    บันทึกครบจำนวนวันแล้ว ไม่ให้บันทึกเพิ่มในวันที่ไม่ได้นัด (วันที่นัดไว้จริงยังบันทึกได้เสมอ)
    {
      const firstDay = bkkDay(ev.start);
      const endRaw = ev.end ? new Date(new Date(ev.end).getTime() - (ev.allDay ? 86400000 : 0)) : ev.start;
      const lastDay = bkkDay(endRaw) < firstDay ? firstDay : bkkDay(endRaw);
      const planned = Math.min(366, Math.round((new Date(`${lastDay}T00:00:00Z`) - new Date(`${firstDay}T00:00:00Z`)) / 86400000) + 1);
      const isPlannedToday = today >= firstDay && today <= lastDay;
      if (!isPlannedToday) {
        const rows = await Attendance.find({ eventId: ev._id }).select("checkIn.at workDay").lean();
        const days = new Set(rows.map((r) => (r.checkIn?.at ? bkkDay(r.checkIn.at) : r.workDay)).filter(Boolean));
        if (days.size >= planned) {
          return res.status(409).json({ message: `งานนี้บันทึกเข้างานครบ ${planned} วันตามที่นัดไว้แล้ว — ไม่ต้องบันทึกซ้ำ` });
        }
      }
    }

    const note = String(req.body.note || "").trim().slice(0, 500);
    const photos = takeFiles(ev.sitePhotoFiles, req.body.photoIds, "before");
    // ✅ (10 ต.ค. 2569 ผู้ใช้: "การเช็คอินต้องอัปรูปภาพหน้างานก่อนถึงจะกดได้")
    if (!photos.length) return res.status(400).json({ message: "กรุณาถ่ายรูปหน้างานก่อนเริ่มงานอย่างน้อย 1 รูป" });

    // นอกวันนัด: วันนี้ (เวลาไทย) ไม่อยู่ในช่วงวันเข้างานของงานนี้
    const startDay = bkkDay(ev.start || ev.date);
    // 🐛 (20 ต.ค. 2569 ผู้ใช้: "งานหลายช่วงวันยังมีผิด") เดิม allDay ไม่ระบุก็ถอย 1 วัน — ไม่ตรงกับการนับวันนัดด้านบน/หน้าจอ
    const lastDay = ev.end ? addDays(bkkDay(ev.end), ev.allDay ? -1 : 0) : startDay;
    const offSchedule = today < startDay || today > (lastDay < startDay ? startDay : lastDay);

    const name = personName(req.user);
    let row;
    try {
      row = await Attendance.create({
        eventId: ev._id,
        workDay: today,
        jobGroupId: ev.jobGroupId || undefined,
        jobLabel: jobLabelOf(ev),
        jobNo: ev.jobNo || "",
        userId: req.userId,
        userName: name,
        team: { head: ev.team || name, members: membersOf(ev) },
        site: site || undefined,
        offSchedule,
        checkIn: { ...stamp, note, photos },
      });
    } catch (err) {
      // index เฉพาะวันป้องกันการกดซ้ำพร้อมกันจากหลายหน้าจอ
      if (err?.code === 11000) {
        const duplicate = await Attendance.findOne({
          eventId: ev._id,
          $or: [
            { "checkIn.at": { $gte: dayStart, $lt: dayEnd } },
            { workDay: today, "checkIn.at": { $exists: false } },
            { workDay: today, "checkIn.at": null },
          ],
        }).lean();
        return res.status(409).json({
          message: `งานนี้บันทึกเข้างานวันที่ ${today} แล้ว${duplicate?.checkIn?.at ? ` (${thTime(duplicate.checkIn.at)} โดย ${duplicate.userName})` : ""}`,
          ...(duplicate ? { attendance: duplicate } : {}),
        });
      }
      throw err;
    }

    // 🔗 งาน: เวลาเข้างานจริง · ประวัติ · สถานะทั้งงาน → กำลังดำเนินการ
    if (!ev.checkedInAt) ev.checkedInAt = stamp.at;
    const where = stamp.distanceM != null ? ` · ห่างหน้างาน ${distText(stamp.distanceM)}` : stamp.gps === "ok" ? "" : " · ไม่มีพิกัด GPS";
    ev.activityLog.push({
      userId: String(req.userId), userName: name, action: "check_in", timestamp: stamp.at,
      detail: `เข้างาน${where}${note ? ` — ${note}` : ""}`,
    });
    await ev.save();
    await CalendarEvent.updateMany(
      { ...groupFilter(ev), status: { $in: ["กำลังรอยืนยัน", "ยืนยันแล้ว"] } },
      { $set: { status: "กำลังดำเนินการ" } },
    );
    // ✅ เช็คอิน = รับทราบงานไปในตัว (ผู้ใช้: "ปุ่มรับทราบกับเช็คอินคล้ายกัน งง") — ยังไม่เคยกดรับทราบ บันทึกให้ทั้งงาน
    const uid = String(req.userId);
    const groupDocs = await CalendarEvent.find({ ...groupFilter(ev), "acks.userId": { $ne: uid } });
    await Promise.all(groupDocs.map((d) => {
      d.acks.push({ userId: uid, name, at: stamp.at });
      d.activityLog.push({ userId: uid, userName: name, action: "job_ack", timestamp: stamp.at, detail: "รับทราบงาน (จากการกดเข้างาน)" });
      return d.save();
    }));

    const responsibleId = ev.responsiblePersonId ? String(ev.responsiblePersonId) : "";
    const pushRecipients = new Set([responsibleId, uid].filter(Boolean));
    // ✅ (20 ต.ค. 2569 ผู้ใช้: "การแจ้งเตือนให้ชัดเจน · งานหลายช่วงวัน") งานหลายวันบอกว่าเป็นวันที่เท่าไรจากทั้งหมด
    let dayInfo = "";
    {
      const firstDay = bkkDay(ev.start);
      const lastDayP = ev.end ? addDays(bkkDay(ev.end), ev.allDay ? -1 : 0) : firstDay;
      const planned = Math.max(1, Math.round((new Date(`${lastDayP < firstDay ? firstDay : lastDayP}T00:00:00Z`) - new Date(`${firstDay}T00:00:00Z`)) / 86400000) + 1);
      if (planned > 1) {
        const done = new Set((await Attendance.find({ eventId: ev._id }).select("checkIn.at workDay").lean())
          .map((r) => (r.checkIn?.at ? bkkDay(r.checkIn.at) : r.workDay)).filter(Boolean)).size;
        dayInfo = ` · วันที่ ${Math.min(done, planned)}/${planned}${done >= planned ? " (ครบ)" : ""}`;
      }
    }
    const attendancePush = {
      title: `📍 ${name} บันทึกเข้างานแล้ว${dayInfo}`,
      body: `${jobLabelOf(ev)} · ${thTime(stamp.at)}${offSchedule ? " · นอกวันนัด" : ""}${where}`,
      url: `/operation/${ev._id}`,
      // แยก tag ตามวัน เพื่อให้การเข้างานคนละวันไม่ทับแจ้งเตือนเดิมของงานเดียวกัน
      tag: `attendance-${ev._id}-${today}`,
    };
    const directRecipients = [...pushRecipients].filter((id) => id !== uid);
    if (directRecipients.length) sendPushToUsers(directRecipients, attendancePush).catch(() => {});
    // แจ้งแอดมิน/ผู้จัดการ/กรรมการผู้จัดการให้ติดตามด้วย และตัดผู้รับผิดชอบที่รับแจ้งตรงออกเพื่อไม่ให้ซ้ำ
    sendPushToRoles(SUPERVISOR_ROLES, attendancePush, [...pushRecipients]).catch(() => {});

    // ✅ (11 ต.ค. 2569 ผู้ใช้: "เมื่อกดเข้างาน สถานะงานต้องเปลี่ยนเป็นกำลังดำเนินการ")
    //    คืนงานทั้งกลุ่ม (สถานะใหม่ + acks) ให้หน้าจอแก้ข้อมูลในที่ทันที — ฟอร์ม EditEvent จะได้ไม่บันทึกสถานะเก่าทับ
    const events = await CalendarEvent.find(groupFilter(ev)).lean();
    res.status(201).json({ attendance: row.toObject(), events, serverNow: new Date() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "บันทึกเข้างานไม่สำเร็จ ลองใหม่อีกครั้ง" });
  }
});

/** ใช้คำขอแก้เวลาที่อนุมัติแล้ว: เปลี่ยนเวลา · คำนวณชั่วโมงใหม่ · บันทึกประวัติในงาน */
async function applyCorrection(row, c, byName, byUserId) {
  if (c.field === "checkIn") {
    const workDay = bkkDay(c.toAt);
    const dayStart = new Date(`${workDay}T00:00:00+07:00`);
    const dayEnd = new Date(`${addDays(workDay, 1)}T00:00:00+07:00`);
    const duplicate = await Attendance.findOne({
      eventId: row.eventId,
      _id: { $ne: row._id },
      $or: [
        { workDay },
        { workDay: { $exists: false }, "checkIn.at": { $gte: dayStart, $lt: dayEnd } },
      ],
    }).lean();
    if (duplicate) {
      const err = new Error(`แก้เวลาไม่ได้ — งานนี้มีบันทึกเข้างานวันที่ ${workDay} อยู่แล้ว`);
      err.status = 409;
      throw err;
    }
    row.checkIn.at = c.toAt;
    row.workDay = workDay;
  } else row.checkOut.at = c.toAt;
  if (row.status === "checked_out" && row.checkOut?.at) row.durationMin = minutesBetween(row.checkIn.at, row.checkOut.at);
  const label = c.field === "checkIn" ? "เวลาเข้างาน" : "เวลาออกงาน";
  await CalendarEvent.updateOne({ _id: row.eventId }, {
    $push: {
      activityLog: {
        userId: String(byUserId), userName: byName, action: "time_corrected", timestamp: new Date(),
        detail: `แก้${label}ของ ${row.userName}: ${c.fromAt ? thTime(c.fromAt) : "-"} → ${thTime(c.toAt)} (เหตุผล: ${c.reason})`,
      },
    },
  });
}

// ── ขอแก้เวลา ──────────────────────────────────────────────────────────────
router.post("/:id/corrections", verifyToken, async (req, res) => {
  try {
    const row = await Attendance.findById(req.params.id);
    if (!row) return res.status(404).json({ message: "ไม่พบรายการ" });
    const approver = canApprove(req.user);
    if (String(row.userId) !== String(req.userId) && !approver) {
      return res.status(403).json({ message: "ขอแก้เวลาได้เฉพาะรายการของตัวเอง" });
    }
    const field = req.body.field === "checkOut" ? "checkOut" : req.body.field === "checkIn" ? "checkIn" : "";
    if (!field) return res.status(400).json({ message: "กรุณาเลือกเวลาที่จะแก้" });
    if (field === "checkOut" && row.status !== "checked_out") return res.status(400).json({ message: "รายการนี้ไม่มีเวลาออกงาน" });
    const toAt = new Date(req.body.toAt);
    if (Number.isNaN(toAt.getTime())) return res.status(400).json({ message: "เวลาไม่ถูกต้อง" });
    if (toAt > new Date()) return res.status(400).json({ message: "ระบุเวลาในอนาคตไม่ได้" });
    const reason = String(req.body.reason || "").trim().slice(0, 500);
    if (!reason) return res.status(400).json({ message: "กรุณาระบุเหตุผล" });
    const otherIn = field === "checkOut" ? row.checkIn.at : toAt;
    const otherOut = field === "checkIn" ? row.checkOut?.at : toAt;
    if (row.status === "checked_out" && otherOut && otherIn && new Date(otherIn) >= new Date(otherOut)) {
      return res.status(400).json({ message: "เวลาเข้างานต้องอยู่ก่อนเวลาออกงาน" });
    }

    const name = personName(req.user);
    // คำขอเดิมของเวลาเดียวกันที่ยังรออยู่ → ถูกแทนด้วยคำขอใหม่ (เก็บไว้เป็นประวัติ)
    row.corrections.forEach((c) => { if (c.field === field && c.status === "pending") c.status = "superseded"; });
    const fromAt = field === "checkIn" ? row.checkIn.at : row.checkOut.at;
    // ✅ แอดมิน/ผู้จัดการยื่นเอง = อนุมัติทันที (ยังเก็บประวัติเหมือนกัน)
    const c = {
      field, fromAt, toAt, reason, requestedBy: name, requestedByUserId: String(req.userId), requestedAt: new Date(),
      status: approver ? "approved" : "pending",
      ...(approver ? { decidedBy: name, decidedAt: new Date(), decisionNote: "แก้โดยแอดมิน" } : {}),
    };
    row.corrections.push(c);
    const saved = row.corrections[row.corrections.length - 1];
    if (approver) await applyCorrection(row, saved, name, req.userId);
    row.hasPendingCorrection = row.corrections.some((x) => x.status === "pending");
    await row.save();
    if (approver) await syncEventTimes(row.eventId);
    else {
      sendPushToRoles(approverRanks(), {
        title: `🕒 ${name} ขอแก้${field === "checkIn" ? "เวลาเข้างาน" : "เวลาออกงาน"}`,
        body: `${row.jobLabel} · ${fromAt ? thTime(fromAt) : "-"} → ${thTime(toAt)} · ${reason}`,
        url: "/attendance?tab=pending",
        tag: `attendance-fix-${row._id}`,
      }).catch(() => {});
    }
    res.json({ attendance: row.toObject() });
  } catch (err) {
    console.error(err);
    res.status(err?.status || (err?.code === 11000 ? 409 : 500)).json({ message: err?.status ? err.message : err?.code === 11000 ? "แก้เวลาไม่ได้ — วันดังกล่าวมีบันทึกเข้างานแล้ว" : "บันทึกไม่สำเร็จ" });
  }
});

// ── แอดมินอนุมัติ/ไม่อนุมัติคำขอแก้เวลา ──────────────────────────────────────
router.put("/:id/corrections/:cid", verifyToken, async (req, res) => {
  try {
    if (!canApprove(req.user)) return res.status(403).json({ message: "เฉพาะแอดมิน/ผู้จัดการ" });
    const row = await Attendance.findById(req.params.id);
    if (!row) return res.status(404).json({ message: "ไม่พบรายการ" });
    const c = row.corrections.id(req.params.cid);
    if (!c || c.status !== "pending") return res.status(400).json({ message: "คำขอนี้ถูกจัดการไปแล้ว" });
    const approve = req.body.decision === "approve";
    const note = String(req.body.note || "").trim().slice(0, 500);
    if (!approve && !note) return res.status(400).json({ message: "กรุณาระบุเหตุผลที่ไม่อนุมัติ" });
    if (approve) {
      const inAt = c.field === "checkIn" ? c.toAt : row.checkIn.at;
      const outAt = c.field === "checkOut" ? c.toAt : row.checkOut?.at;
      if (row.status === "checked_out" && outAt && new Date(inAt) >= new Date(outAt)) {
        return res.status(400).json({ message: "อนุมัติไม่ได้ — เวลาเข้างานจะอยู่หลังเวลาออกงาน" });
      }
    }
    const name = personName(req.user);
    c.status = approve ? "approved" : "rejected";
    c.decidedBy = name;
    c.decidedAt = new Date();
    c.decisionNote = note;
    if (approve) {
      c.fromAt = c.field === "checkIn" ? row.checkIn.at : row.checkOut?.at; // ค่าจริงก่อนแก้ ณ ตอนอนุมัติ
      await applyCorrection(row, c, name, req.userId);
    }
    row.hasPendingCorrection = row.corrections.some((x) => x.status === "pending");
    await row.save();
    if (approve) await syncEventTimes(row.eventId);
    if (c.requestedByUserId && c.requestedByUserId !== String(req.userId)) {
      sendPushToUsers(c.requestedByUserId, {
        title: approve ? "✅ อนุมัติแก้เวลาแล้ว" : "❌ ไม่อนุมัติคำขอแก้เวลา",
        body: `${row.jobLabel} · ${approve ? `เป็น ${thTime(c.toAt)}` : note}`,
        url: `/operation/${row.eventId}`,
        tag: `attendance-fix-${row._id}`,
      }).catch(() => {});
    }
    res.json({ attendance: row.toObject() });
  } catch (err) {
    console.error(err);
    res.status(err?.status || (err?.code === 11000 ? 409 : 500)).json({ message: err?.status ? err.message : err?.code === 11000 ? "แก้เวลาไม่ได้ — วันดังกล่าวมีบันทึกเข้างานแล้ว" : "บันทึกไม่สำเร็จ" });
  }
});

module.exports = router;
