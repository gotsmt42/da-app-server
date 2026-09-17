/**
 * แจ้งเตือนประจำวันของระบบเบิก Advance / เคลม
 *
 * ⚠️ ทำตามแบบแผนเดียวกับ OverdueReminder.js / DispatchReminder.js ทุกประการ:
 *   • ต้องผ่าน NotifyLog.claimOncePerDay ก่อนส่งเสมอ (deploy/รีสตาร์ทวันละหลายรอบต้องไม่ยิงซ้ำ)
 *   • ตั้งเวลาผ่าน scheduleDaily ใน src/scheduler.js
 *   • ห้ามโยน error ออกไป — ตัวเตือนตัวหนึ่งพังต้องไม่ล้มตัวอื่นที่รันชุดเดียวกัน
 */
const moment = require("moment");
const Expense = require("../models/Expense");
const NotifyLog = require("../models/NotifyLog");
const { sendPushToUsers, sendPushToRoles } = require("./PushNotify");
const { SUPERVISOR_ROLES, CAPABILITIES } = require("../config/roles");
const { thaiDate } = require("../utils/thaiDate");

const PENDING_HOURS = 24; // ใบรออนุมัติค้างเกินเท่านี้ = หัวหน้าต้องรู้

const baht = (n) => `${(Math.round((Number(n) || 0) * 100) / 100).toLocaleString("th-TH")} บาท`;

/**
 * ใบ Advance ที่จ่ายเงินไปแล้วแต่เลยกำหนดเคลียร์
 * ✅ ผู้เบิกได้รับแจ้ง "รายใบ" (เป็นหน้าที่ของคนนั้นโดยตรง) · หัวหน้าได้ "สรุปรวมใบเดียว" (ไม่ท่วมมือถือ)
 */
async function checkAndNotifyOverdueAdvances() {
  try {
    const rows = await Expense.find({
      kind: "advance",
      status: "paid",
      dueClearAt: { $lt: new Date() },
    }).select("docNo subject total requester dueClearAt").lean();
    if (rows.length === 0) return;

    for (const r of rows) {
      const uid = r.requester?.userId;
      if (!uid) continue;
      if (!(await NotifyLog.claimOncePerDay("advance-overdue", String(r._id), uid))) continue;
      const days = Math.max(1, moment().diff(moment(r.dueClearAt), "days"));
      await sendPushToUsers([uid], {
        title: "⏰ ถึงเวลาเคลียร์ Advance แล้ว",
        body: `${r.docNo} · ${baht(r.total)} เลยกำหนด ${thaiDate(r.dueClearAt)} มา ${days} วัน — กรุณาส่งใบเคลม`,
        url: `/expenses/${r._id}`,
        tag: `expense-${r._id}`,
        renotify: true,
      });
    }

    if (!(await NotifyLog.claimOncePerDay("advance-overdue", "broadcast", "admin+manager"))) return;
    const sum = rows.reduce((s, r) => s + (Number(r.total) || 0), 0);
    await sendPushToRoles(SUPERVISOR_ROLES, {
      title: "⏰ มี Advance เลยกำหนดเคลียร์",
      body: `${rows.length} ใบ รวม ${baht(sum)} ยังไม่ส่งใบเคลม`,
      url: "/expenses/advances?status=overdue",
      tag: "advance-overdue",
      renotify: true,
    });
  } catch (err) {
    console.error("❌ ตรวจ Advance เลยกำหนดเคลียร์ไม่สำเร็จ:", err);
  }
}

/**
 * ใบเบิกที่ค้างอยู่ในสายอนุมัติ 4 ขั้นนานเกินกำหนด — ✅ เตือน "เฉพาะคนที่ต้องทำขั้นนั้น" (ผู้ใช้กำหนด)
 *   รอตรวจสอบ        → แอดมินช่าง + ผู้จัดการแผนกช่าง   (นับจากเวลาส่งใบ)
 *   รออนุมัติ         → ผู้จัดการแผนกช่าง               (นับจากเวลาตรวจสอบ)
 *   รออนุมัติเบิกจ่าย  → ผู้จัดการแผนกช่าง + กรรมการผู้จัดการ (นับจากเวลาอนุมัติ)
 * ⚠️ ผู้รับอ่านจาก CAPABILITIES ของขั้นนั้น — ตรงกับคนที่กดได้จริงเสมอ
 */
const STALE_STEPS = [
  { key: "expense-pending", status: "pending", since: "submittedAt", cap: "reviewExpense", head: "📝 ใบเบิกรอตรวจสอบค้างอยู่", step: "ขั้นที่ 2/4 ตรวจสอบ" },
  { key: "expense-reviewed", status: "reviewed", since: "reviewedAt", cap: "approveExpense", head: "🔎 ใบเบิกรออนุมัติค้างอยู่", step: "ขั้นที่ 3/4 อนุมัติ" },
  { key: "expense-approved", status: "approved", since: "approvedAt", cap: "disburseExpense", head: "✍️ ใบเบิกรออนุมัติเบิกจ่ายค้างอยู่", step: "ขั้นที่ 4/4 อนุมัติเบิกจ่าย" },
];

async function checkAndNotifyPendingExpenses() {
  const cutoff = moment().subtract(PENDING_HOURS, "hours").toDate();
  for (const s of STALE_STEPS) {
    try {
      // eslint-disable-next-line no-await-in-loop -- 3 ขั้นเท่านั้น และต้องไม่ให้ขั้นหนึ่งพังแล้วลากขั้นอื่นไปด้วย
      const rows = await Expense.find({ status: s.status, [s.since]: { $lt: cutoff } })
        .select("kind claimType total difference").lean();
      if (rows.length === 0) continue;
      // eslint-disable-next-line no-await-in-loop
      if (!(await NotifyLog.claimOncePerDay(s.key, "broadcast", s.cap))) continue;
      const adv = rows.filter((r) => r.kind === "advance");
      // ✅ แยกใบสำรองจ่ายออกจากใบเคลมในข้อความ — สองใบนี้คนละเรื่องกันสำหรับคนอนุมัติ (ใบหนึ่งเคลียร์เงิน
      // ที่จ่ายไปแล้ว อีกใบคือพนักงานควักเงินตัวเองรออยู่)
      const rmb = rows.filter((r) => r.kind === "claim" && r.claimType === "reimburse");
      const clm = rows.filter((r) => r.kind === "claim" && r.claimType !== "reimburse");
      const sum = (list) => list.reduce((t, r) => t + (Number(r.total) || 0), 0);
      const parts = [
        adv.length ? `Advance ${adv.length} ใบ (${baht(sum(adv))})` : "",
        clm.length ? `ใบเคลม ${clm.length} ใบ` : "",
        rmb.length ? `สำรองจ่าย ${rmb.length} ใบ (${baht(sum(rmb))})` : "",
      ].filter(Boolean).join(" · ");
      // eslint-disable-next-line no-await-in-loop
      await sendPushToRoles(CAPABILITIES[s.cap] || [], {
        title: s.head,
        body: `${parts}\n${s.step} · ค้างเกิน ${PENDING_HOURS} ชั่วโมง — กรุณาดำเนินการ`,
        url: "/expenses/approvals",
        tag: s.key,
        renotify: true,
      });
    } catch (err) {
      console.error(`❌ ตรวจใบเบิกค้าง (${s.status}) ไม่สำเร็จ:`, err);
    }
  }
}

module.exports = { checkAndNotifyOverdueAdvances, checkAndNotifyPendingExpenses, PENDING_HOURS };
