/**
 * jobAudit — บันทึกประวัติ "ผู้ดำเนินการ" ของทุกขั้นตอนงาน + แจ้งเตือนคนที่ถูกมอบหมาย (11 ต.ค. 2569)
 *
 * ✅ ผู้ใช้: "ทุกๆ ขั้นตอนให้มีบันทึกประวัติของผู้ดำเนินการด้วย"
 *    เดิมประวัติบางขั้นถูกเขียนจากหน้าจอเท่านั้น (เช่น ฟอร์ม EditEvent) — มอบหมาย/เปลี่ยนสถานะจากหน้าอื่น
 *    (การดำเนินงาน · ภาพรวมงาน · งานใหม่) ไม่มีบันทึกเลย → ย้ายมาบันทึกที่ server ทุกเส้นทาง
 *    ⚠️ ถ้าหน้าจอส่งบันทึกประเภทเดียวกันมาในคำขอเดียวกันแล้ว (EditEvent) จะไม่บันทึกซ้ำ
 *
 * ✅ ผู้ใช้: "ระบบแจ้งเตือนเมื่อคนที่ได้รับมอบหมายให้เป็นผู้รับผิดชอบ มีลิงก์กดเข้าหน้างาน มากดรับทราบ"
 *    มอบหมายหัวหน้าทีมเข้างาน / ผู้รับผิดชอบ ใหม่จากทุกหน้า → แจ้งเตือนคนนั้น ลิงก์ไปการ์ดงาน (มีปุ่มรับทราบ/ปฏิเสธ)
 */
const CalendarEvent = require("../models/Events");
const User = require("../models/User");
const { sendPushToUsers } = require("./PushNotify");
const { can } = require("../config/roles");

/**
 * ✅ (11 ต.ค. 2569 ผู้ใช้: "งานที่ได้รับมอบหมายคือเด้งไปในงานของฉัน")
 * ลิงก์แจ้งเตือนงาน: ช่าง (สิทธิ์ receiveDispatch) → หน้า "งานของฉัน" · คนอื่น → การ์ดในหน้าการดำเนินงาน
 */
async function jobUrlFor(userId, eventId) {
  try {
    const u = await User.findById(userId).select("role rank").lean();
    if (u && can(u, "receiveDispatch")) return `/technician/jobs?job=${eventId}`;
  } catch { /* ใช้ลิงก์มาตรฐาน */ }
  return `/operation/${eventId}`;
}

const s = (v) => (v === undefined || v === null ? "" : String(v));
const dayText = (d) => (d ? new Date(d).toLocaleDateString("th-TH", { timeZone: "Asia/Bangkok", day: "numeric", month: "short", year: "2-digit" }) : "-");

/**
 * เทียบก่อน/หลัง แล้วคืนรายการประวัติที่ต้องเพิ่ม
 * @param before  เอกสารเดิม (หรือ object ที่มีฟิลด์เดิม)
 * @param after   ค่าหลังแก้
 * @param actor   { userId, name }
 * @param incomingActions  ประเภทบันทึกที่หน้าจอส่งมาเองในคำขอนี้แล้ว (กันซ้ำ)
 */
function auditEntries(before, after, actor, incomingActions = new Set()) {
  const at = new Date();
  const base = { userId: s(actor.userId), userName: actor.name || "ผู้ใช้", timestamp: at };
  const out = [];
  const add = (action, detail) => { if (!incomingActions.has(action)) out.push({ ...base, action, detail }); };

  if (after.status !== undefined && s(after.status) !== s(before.status)) {
    if (after.status === "ยืนยันแล้ว") add("job_confirmed", `ยืนยันนัดแล้ว (จาก "${s(before.status) || "-"}")`);
    else add("status_changed", `เปลี่ยนสถานะจาก "${s(before.status) || "-"}" เป็น "${s(after.status)}"`);
  }
  if (after.team !== undefined && s(after.team) !== s(before.team)) {
    add("team_changed", `หัวหน้าทีมเข้างาน: ${s(before.team) || "-"} → ${s(after.team) || "ยังไม่ระบุ"}`);
  }
  if (after.responsiblePerson !== undefined && s(after.responsiblePerson) !== s(before.responsiblePerson)) {
    add("responsible_assigned", `ผู้รับผิดชอบ: ${s(before.responsiblePerson) || "-"} → ${s(after.responsiblePerson) || "ยังไม่มอบหมาย"}`);
  }
  if (after.start !== undefined && after.start && before.start && dayText(after.start) !== dayText(before.start)) {
    add("schedule_changed", `วันเข้างาน: ${dayText(before.start)} → ${dayText(after.start)}`);
  }
  return out;
}

/** มีการเปลี่ยนคนที่ถูกมอบหมาย (หัวหน้าทีม/ผู้รับผิดชอบ) ไหม — ใช้ล้างป้าย "ปฏิเสธงาน" ที่ค้าง */
const assignmentChanged = (before, after) =>
  (after.team !== undefined && s(after.team) !== s(before.team)) ||
  (after.resPerson !== undefined && s(after.resPerson) !== s(before.resPerson)) ||
  (after.responsiblePersonId !== undefined && s(after.responsiblePersonId) !== s(before.responsiblePersonId));

/** ประเภทบันทึกที่หน้าจอส่งมาใหม่ในคำขอนี้ (เวลาไม่เกิน 2 นาที) */
function freshActions(incomingLogs) {
  const since = Date.now() - 2 * 60 * 1000;
  return new Set((Array.isArray(incomingLogs) ? incomingLogs : [])
    .filter((l) => l && new Date(l.timestamp || 0).getTime() >= since)
    .map((l) => l.action));
}

/** เขียนประวัติ + ล้างป้ายปฏิเสธ (ถ้ามอบหมายใหม่) ให้งานที่ระบุ */
async function applyAudit(ids, entries, { clearDecline = false } = {}) {
  if (!entries.length && !clearDecline) return;
  const update = {};
  if (entries.length) update.$push = { activityLog: { $each: entries } };
  if (clearDecline) update.$set = { ackDeclined: null };
  await CalendarEvent.updateMany({ _id: { $in: ids } }, update);
}

const jobLabel = (ev) => `${ev.title || "งาน"} · ${ev.site || ev.company || "-"}${ev.jobNo ? ` (${ev.jobNo})` : ""}`;

/**
 * แจ้งเตือนคนที่เพิ่งถูกมอบหมาย — ลิงก์ไปการ์ดงาน (กดรับทราบ/ปฏิเสธได้ที่นั่น)
 * @param role "head" = หัวหน้าทีมเข้างาน · "responsible" = ผู้รับผิดชอบงาน
 */
async function notifyAssigned(ev, userId, role, actorName, actorId) {
  if (!userId || s(userId) === s(actorId)) return;
  const when = ev.unscheduled ? "ยังไม่ลงวัน" : dayText(ev.start);
  const url = await jobUrlFor(userId, ev._id);
  sendPushToUsers(s(userId), {
    title: role === "head"
      ? `📋 ${actorName} มอบหมายให้คุณเป็นหัวหน้าทีมเข้างาน`
      : `📋 ${actorName} มอบหมายให้คุณเป็นผู้รับผิดชอบงาน`,
    body: `${jobLabel(ev)} · เข้างาน ${when} — แตะเพื่อเปิดงานและกดรับทราบ`,
    url,
    tag: `assign-${role}-${ev.jobGroupId || ev._id}`,
    renotify: true,
  }).catch((e) => console.error("❌ push assign:", e.message));
}

/**
 * ✅ (11 ต.ค. 2569 ผู้ใช้: "ป้องกันงานเก่าที่เลยวันไปแล้ว ให้ขั้นตอนรับทราบ และยืนยัน ครบแล้ว" + "สถานะต่างๆ ให้สอดคล้อง ไม่ซ้ำซ้อน")
 * งานที่มีอยู่ก่อนเปิดใช้ขั้นตอน (FLOW_SINCE) + เลยวันเข้างานแล้ว + ยังค้าง "กำลังรอยืนยัน"
 * → เปลี่ยนสถานะเป็น "ยืนยันแล้ว" ให้ตรงกับสายขั้นตอนบนการ์ด (บันทึกผู้ดำเนินการเป็น "ระบบ")
 * รันตอนเปิดเซิร์ฟเวอร์ และทุก 6 ชม. (งานเก่าที่ยังไม่ถึงวันจะถูกปรับเมื่อเลยวันแล้ว)
 */
const FLOW_SINCE = new Date("2026-10-11T03:00:00.000Z");
async function confirmLegacyPastJobs() {
  const today = new Date(new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10) + "T00:00:00+07:00");
  const at = new Date();
  const r = await CalendarEvent.updateMany(
    { createdAt: { $lt: FLOW_SINCE }, start: { $lt: today }, status: "กำลังรอยืนยัน", unscheduled: { $ne: true },
      approvalStatus: { $nin: ["pending", "rejected"] }, department: { $ne: "sales" } },
    { $set: { status: "ยืนยันแล้ว", confirmedAt: at },
      $push: { activityLog: { action: "job_confirmed", userId: "", userName: "ระบบ", timestamp: at, detail: "งานเดิมก่อนเปิดใช้ขั้นตอนรับทราบ/ยืนยันนัด และเลยวันเข้างานแล้ว — ถือว่ายืนยันแล้ว" } } },
  );
  if (r.modifiedCount) console.log(`✅ ปรับสถานะงานเก่าที่เลยวันแล้วเป็น "ยืนยันแล้ว" ${r.modifiedCount} งาน`);
  return r.modifiedCount;
}

module.exports = { confirmLegacyPastJobs, auditEntries, assignmentChanged, freshActions, applyAudit, notifyAssigned, jobUrlFor };
