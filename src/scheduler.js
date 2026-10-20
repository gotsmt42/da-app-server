const {
  checkAndNotifyOverdueJobs,
  checkAndNotifyStaleQuotations,
  checkAndNotifyOverdueContracts,
  checkAndNotifyExpiringContracts,
  checkAndNotifyOverdueInvoices,
  checkAndNotifyUnackedJobs,
  checkAndNotifyStalledIntake,
  checkAndNotifyUnconfirmedJobs,
  checkAndNotifyMissingCheckin,
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
//   • ในรอบเดียวกัน แต่ละหมวดห่างกัน 30 นาที (15 ต.ค. 2569 ผู้ใช้: "ไม่ให้เวลาเท่ากัน ให้ห่างกันทีละ 30 นาที")
//
// ⚠️ ไม่แจ้งซ้ำแม้ deploy หลายรอบ/ตามเก็บตอนบูต — ชั้นส่งกันซ้ำด้วย NotifyLog.claimOncePerDay
// (1 เรื่อง : 1 ผู้รับ : 1 วัน) อยู่แล้ว
const STAGGER_MIN = 30;

const NOTIFY_SLOTS = [
  {
    slot: "เช้า", hour: 8, minute: 30,
    tasks: [
      { name: "คำขอแจ้งงานค้าง", task: checkAndNotifyUnassignedDispatch },
      { name: "งานค้าง", task: checkAndNotifyOverdueJobs },
      { name: "สัญญาเลยกำหนดรอบ", task: checkAndNotifyOverdueContracts },
      { name: "งานวันนี้/พรุ่งนี้ยังไม่รับทราบ", task: checkAndNotifyUnackedJobs },
      // ✅ (20 ต.ค. 2569 ผู้ใช้: "เตือนช่างกันลืม") รับทราบแล้วแต่ยังไม่ยืนยันนัด (งานภายใน 3 วัน)
      { name: "งานใกล้ถึงยังไม่ยืนยันนัด", task: checkAndNotifyUnconfirmedJobs },
      { name: "งานใหม่ค้างเกิน 2 วัน", task: checkAndNotifyStalledIntake },
      // (15 ต.ค. 2569) สรุปสัปดาห์ละครั้ง — ย้ายมาช่วงเช้า ให้เห็นตอนเริ่มงานวันจันทร์
      { name: "สัญญาใกล้หมดอายุ (ทุกจันทร์)", task: checkAndNotifyExpiringContracts },
    ],
  },
  {
    // ✅ (20 ต.ค. 2569 ผู้ใช้: "ไม่กดบันทึกงานเมื่อถึงเวลา เตือนให้ชัดเจน กันลืม") — สายๆ ควรถึงหน้างานแล้ว
    slot: "สาย", hour: 10, minute: 30,
    tasks: [
      { name: "ถึงวันเข้างานยังไม่บันทึกเข้างาน", task: checkAndNotifyMissingCheckin },
    ],
  },
  {
    slot: "บ่าย", hour: 13, minute: 30,
    tasks: [
      { name: "ใบเบิกรออนุมัติค้าง", task: checkAndNotifyPendingExpenses },
      { name: "Advance เลยกำหนดเคลียร์ (ทุกจันทร์)", task: checkAndNotifyOverdueAdvances },
    ],
  },
  {
    slot: "เย็น", hour: 16, minute: 0,
    tasks: [
      { name: "ใบเสนอราคาค้าง (ทุกจันทร์)", task: checkAndNotifyStaleQuotations },
      { name: "ใบวางบิลเลยกำหนด (ทุกจันทร์)", task: checkAndNotifyOverdueInvoices },
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
