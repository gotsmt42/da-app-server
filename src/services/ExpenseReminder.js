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
const { SUPERVISOR_ROLES } = require("../config/roles");
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

/** ใบเบิก/ใบเคลมที่รออนุมัติค้างนาน */
async function checkAndNotifyPendingExpenses() {
  try {
    const cutoff = moment().subtract(PENDING_HOURS, "hours").toDate();
    const rows = await Expense.find({ status: "pending", submittedAt: { $lt: cutoff } })
      .select("kind total").lean();
    if (rows.length === 0) return;
    if (!(await NotifyLog.claimOncePerDay("expense-pending", "broadcast", "admin+manager"))) return;
    const adv = rows.filter((r) => r.kind === "advance").length;
    const clm = rows.length - adv;
    await sendPushToRoles(SUPERVISOR_ROLES, {
      title: "📝 มีใบเบิกรออนุมัติค้างอยู่",
      body: [adv ? `Advance ${adv} ใบ` : "", clm ? `ใบเคลม ${clm} ใบ` : ""].filter(Boolean).join(" · ") + ` เกิน ${PENDING_HOURS} ชั่วโมง`,
      url: "/expenses/approvals",
      tag: "expense-pending",
      renotify: true,
    });
  } catch (err) {
    console.error("❌ ตรวจใบเบิกรออนุมัติค้างไม่สำเร็จ:", err);
  }
}

module.exports = { checkAndNotifyOverdueAdvances, checkAndNotifyPendingExpenses, PENDING_HOURS };
