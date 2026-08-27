const {
  checkAndNotifyOverdueJobs,
  checkAndNotifyStaleQuotations,
  checkAndNotifyOverdueContracts,
  checkAndNotifyExpiringContracts,
  checkAndNotifyOverdueInvoices,
} = require("./services/OverdueReminder");
const { checkAndNotifyUnassignedDispatch } = require("./services/DispatchReminder");
const { scheduleDaily } = require("./services/DailySchedule");

// ── แจ้งเตือนประจำวัน ────────────────────────────────────────────────────────
// ✅ ทุกตัวยิงเวลาเดียวกันคือ 12:00 น. ตามเวลาไทย ทุกวัน ไม่ว่าจะ deploy/รีสตาร์ทกี่ครั้งก็ตาม
//
// 🐛 ปัญหาเดิม (ผู้ใช้แจ้งว่า "แจ้งมั่วสะเปะสะปะ"): ใช้ setTimeout(2 นาที) + setInterval(24 ชม.)
// ซึ่งนับจากเวลาที่โปรเซสเริ่มทำงาน — deploy ตอนไหนก็ได้แจ้งเวลานั้นไปตลอด แล้วพอ deploy ใหม่เวลาก็
// ย้ายอีก ผู้ใช้จึงไม่มีทางรู้เลยว่าจะได้รับแจ้งตอนไหน
//
// ✅ ทำไมเลือก 12:00: เป็นเวลาพักกลางวัน คนเปิดดูมือถืออยู่แล้ว และยังเหลือครึ่งวันให้ตามงานต่อได้ทัน
// ต่างจากตอนเช้าตรู่/ดึกที่แจ้งไปก็ไม่มีใครทำอะไรต่อได้
//
// ⚠️ ถ้าจะเปลี่ยนเวลา แก้ที่ NOTIFY_HOUR ตัวเดียว มีผลกับทุกตัวพร้อมกัน — อย่าไปแก้ทีละตัว เพราะการ
// ให้แต่ละเรื่องแจ้งคนละเวลาจะทำให้ผู้ใช้โดนรบกวนกระจายทั้งวันแทนที่จะจบในครั้งเดียว
const NOTIFY_HOUR = 12;

const DAILY_TASKS = [
  { name: "งานค้าง", task: checkAndNotifyOverdueJobs },
  { name: "ใบเสนอราคาค้าง", task: checkAndNotifyStaleQuotations },
  { name: "สัญญาเลยกำหนดรอบ", task: checkAndNotifyOverdueContracts },
  { name: "สัญญาใกล้หมดอายุ", task: checkAndNotifyExpiringContracts },
  { name: "ใบวางบิลเลยกำหนด", task: checkAndNotifyOverdueInvoices },
  { name: "คำขอแจ้งงานค้าง", task: checkAndNotifyUnassignedDispatch },
];

function startSchedulers() {
  DAILY_TASKS.forEach(({ name, task }) => scheduleDaily({ hour: NOTIFY_HOUR, name, task }));
}

module.exports = { startSchedulers, NOTIFY_HOUR };
