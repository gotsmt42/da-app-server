const {
  checkAndNotifyOverdueJobs,
  checkAndNotifyStaleQuotations,
  checkAndNotifyOverdueContracts,
  checkAndNotifyExpiringContracts,
  checkAndNotifyOverdueInvoices,
  checkAndNotifyUnackedJobs,
} = require("./services/OverdueReminder");
const { checkAndNotifyUnassignedDispatch } = require("./services/DispatchReminder");
const { checkAndNotifyOverdueAdvances, checkAndNotifyPendingExpenses } = require("./services/ExpenseReminder");
const { scheduleDaily } = require("./services/DailySchedule");

// ── แจ้งเตือนประจำวัน ────────────────────────────────────────────────────────
// ✅ ยิงตาม "เวลาตามนาฬิกาไทย" เดิมทุกวัน ไม่ว่าจะ deploy/รีสตาร์ทกี่ครั้ง (ดู DailySchedule.js)
//
// 🔁 เปลี่ยนจาก "ทุกเรื่อง 12:00 พร้อมกัน" เป็น 3 รอบ เช้า · บ่าย · เย็น (ผู้ใช้ขอ — เดิมเที่ยงตรงเด้งรวด
// 8 เรื่องติดกัน อ่านไม่ทัน และเรื่องสำคัญจมอยู่ในกองแจ้งเตือน)
//   • จัดกลุ่มตาม "ใครต้องทำอะไรช่วงไหนของวัน":
//       เช้า  — งานภาคสนาม ต้องรู้ก่อนออกหน้างาน/จัดคิวของวันนี้
//       บ่าย — เอกสารการเงินที่ต้องตรวจ/อนุมัติ ยังมีเวลาทำให้เสร็จในวันทำการ
//       เย็น — ฝ่ายขาย/บัญชี สรุปเรื่องที่ต้องตามต่อพรุ่งนี้
//   • ในรอบเดียวกัน แต่ละหมวดห่างกัน 5 นาที — ไม่เด้งพร้อมกันเป็นพรืด แจ้งเตือนแต่ละอันอ่านแยกกันได้
//
// ⚠️ ไม่แจ้งซ้ำแม้ deploy หลายรอบ/ตามเก็บตอนบูต — ชั้นส่งกันซ้ำด้วย NotifyLog.claimOncePerDay
// (1 เรื่อง : 1 ผู้รับ : 1 วัน) อยู่แล้ว
const STAGGER_MIN = 5;

const NOTIFY_SLOTS = [
  {
    slot: "เช้า", hour: 8, minute: 30,
    tasks: [
      { name: "คำขอแจ้งงานค้าง", task: checkAndNotifyUnassignedDispatch },
      { name: "งานค้าง", task: checkAndNotifyOverdueJobs },
      { name: "สัญญาเลยกำหนดรอบ", task: checkAndNotifyOverdueContracts },
      { name: "งานพรุ่งนี้ยังไม่รับงาน", task: checkAndNotifyUnackedJobs },
    ],
  },
  {
    slot: "บ่าย", hour: 13, minute: 30,
    tasks: [
      { name: "ใบเบิกรออนุมัติค้าง", task: checkAndNotifyPendingExpenses },
      { name: "Advance เลยกำหนดเคลียร์", task: checkAndNotifyOverdueAdvances },
    ],
  },
  {
    slot: "เย็น", hour: 16, minute: 30,
    tasks: [
      { name: "ใบเสนอราคาค้าง", task: checkAndNotifyStaleQuotations },
      { name: "ใบวางบิลเลยกำหนด", task: checkAndNotifyOverdueInvoices },
      { name: "สัญญาใกล้หมดอายุ", task: checkAndNotifyExpiringContracts },
    ],
  },
];

/** ตารางเวลาแบบแบน: [{ name, task, hour, minute }] — แยกออกมาให้ทดสอบ/ตรวจได้โดยไม่ต้องตั้ง timer จริง */
function dailyPlan() {
  return NOTIFY_SLOTS.flatMap(({ slot, hour, minute, tasks }) => tasks.map(({ name, task }, i) => {
    const total = hour * 60 + minute + i * STAGGER_MIN;
    return { slot, name, task, hour: Math.floor(total / 60), minute: total % 60 };
  }));
}

function startSchedulers() {
  // ✅ ตอนบูต: เริ่มนับติดตามใบเสนอราคาที่เข้าเงื่อนไขแล้ว (ข้อมูลเดิมก่อนตัดขั้นตอน "ส่งลูกค้า") — ดู services/quotationAutoStart.js
  setTimeout(() => require("./services/quotationAutoStart").syncQuotationStartSafe()
    .then((n) => n && console.log(`📄 เริ่มนับติดตามใบเสนอราคาอัตโนมัติ ${n} งาน`)), 20 * 1000);
  dailyPlan().forEach(({ slot, name, task, hour, minute }, i) => scheduleDaily({
    hour, minute, name: `${slot} · ${name}`, task,
    // ⚠️ ตามเก็บตอนบูตก็เว้นระยะเหมือนกัน (ทีละ 2 นาที) — ไม่งั้นเซิร์ฟเวอร์ที่ดับคร่อมเวลา พอขึ้นมาจะยิงทุกเรื่องพร้อมกัน
    bootDelayMs: 60 * 1000 + i * 2 * 60 * 1000,
  }));
}

module.exports = { startSchedulers, dailyPlan, NOTIFY_SLOTS };
