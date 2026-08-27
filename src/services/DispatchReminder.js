/**
 * แจ้งเตือนประจำวันเรื่อง "คำขอแจ้งงานที่ยังไม่ได้มอบหมาย"
 *
 * ⚠️ ทำตามแบบแผนเดียวกับ services/OverdueReminder.js ทุกประการ:
 *   • ต้องผ่าน NotifyLog.claimOncePerDay ก่อนส่งเสมอ — ไม่งั้น deploy/รีสตาร์ทวันละหลายรอบ
 *     จะยิงแจ้งเตือนเรื่องเดิมซ้ำทั้งวัน จนผู้ใช้เลิกสนใจการแจ้งเตือนไปเลย (อันตรายกว่าไม่แจ้ง)
 *   • ตั้งเวลาผ่าน scheduleDaily ใน src/scheduler.js ไม่ใช่ setInterval นับจากเวลาที่โปรเซสเริ่ม
 *   • ห้ามโยน error ออกไป — ตัวเตือนตัวหนึ่งพังต้องไม่ล้มตัวอื่นที่รันชุดเดียวกัน
 *
 * 🧹 เดิมไฟล์นี้ชื่อ SalesReminder.js และมีตัวเตือนของระบบ CRM (ดีลนิ่ง/นัดหมายพรุ่งนี้/ดีลใกล้ครบ
 * กำหนดปิด) รวมอยู่ด้วย — ระบบนั้นถูกตัดออกตามที่ผู้ใช้สั่ง ("ไม่ต้องทำอะไรมากมายให้ยุ่งยากแบบนั้น")
 * เหลือเฉพาะตัวนี้ซึ่งเป็นเรื่องคิวแจ้งงานล้วนๆ จึงเปลี่ยนชื่อไฟล์ให้ตรงกับสิ่งที่มันทำจริง
 */
const moment = require("moment");
const Dispatch = require("../models/Dispatch");
const NotifyLog = require("../models/NotifyLog");
const { sendPushToRoles } = require("./PushNotify");
const { SUPERVISOR_ROLES } = require("../config/roles");

const UNASSIGNED_HOURS = 24; // คำขอค้างไม่ได้มอบหมายเกินเท่านี้ = หัวหน้าต้องรู้

/**
 * คำขอแจ้งงานที่ค้างเกินกำหนดโดยยังไม่มีใครถูกมอบหมาย
 * ⚠️ ส่งถึงแอดมิน/ผู้จัดการเป็นกลุ่ม (ไม่ใช่รายคน) เพราะการมอบหมายงานเป็นหน้าที่ของกลุ่มนี้ร่วมกัน
 * ใครว่างก่อนจัดการก่อนได้ ต่างจากงานที่มีเจ้าของชัดเจนซึ่งต้องส่งเจาะรายคน
 */
async function checkAndNotifyUnassignedDispatch() {
  try {
    const cutoff = moment().subtract(UNASSIGNED_HOURS, "hours").toDate();
    const rows = await Dispatch.find({
      status: "requested",
      requestedAt: { $lt: cutoff },
    }).select("dispatchNo title customer priority requestedAt").lean();
    if (rows.length === 0) return;

    if (!(await NotifyLog.claimOncePerDay("unassigned-dispatch", "broadcast", "admin+manager"))) return;
    const urgent = rows.filter((r) => r.priority === "urgent").length;
    await sendPushToRoles(SUPERVISOR_ROLES, {
      title: "📋 มีคำขอแจ้งงานที่ยังไม่ได้มอบหมาย",
      body: `ค้างอยู่ ${rows.length} ใบเกิน ${UNASSIGNED_HOURS} ชั่วโมง${urgent ? ` (ด่วน ${urgent} ใบ)` : ""} กรุณาเลือกผู้รับงาน`,
      url: "/dispatch",
      tag: "unassigned-dispatch",
      renotify: true,
    });
  } catch (err) {
    console.error("❌ ตรวจคำขอแจ้งงานค้างไม่สำเร็จ:", err);
  }
}

module.exports = { checkAndNotifyUnassignedDispatch, UNASSIGNED_HOURS };
