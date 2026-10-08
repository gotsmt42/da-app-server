// ✅ ค่าเริ่มต้นของ "ระยะห่างระหว่างรอบ" (เดือน) สำหรับสัญญาที่ยังไม่เคยระบุ intervalMonths ไว้ —
// ใช้เป็นเกณฑ์เตือน "เกินกำหนดรอบถัดไป" เท่านั้น (ดู services/OverdueReminder.js,
// src/utils/contractOverdue.js ฝั่ง frontend) ไม่เกี่ยวกับ/ไม่คำนวณทับ visitCount ซึ่งผู้ใช้กำหนด
// เองอิสระเสมอ เพราะงานจริงเลื่อน/ชนกันได้ตลอด
const DEFAULT_INTERVAL_MONTHS = 3;

/**
 * ✅ จำนวนครั้งทั้งหมดของสัญญา — ตัวตัดสินเดียวที่ทุกจุดต้องใช้ (ป้าย "x/y", ปุ่ม "+ เพิ่มครั้งถัดไป",
 *    แจ้งเตือนเลยกำหนดรอบ, คอลัมน์ครั้งที่ N, รายการสัญญาในฟอร์มเพิ่มงาน)
 * 🐛 ที่แก้: เดิมป้าย x/y คิดจาก "รอบเข้า" (ทุก 6 เดือน = 2 ครั้ง) แต่ปุ่มเพิ่มครั้ง/แจ้งเตือนอ่าน visitCount
 *    ที่บันทึกแยกไว้ ซึ่งค้างค่าเก่าได้ — สัญญาขึ้น "2/2 ครบแล้ว" แต่ยังมีช่องให้ลงครั้งที่ 3 และเตือนเลยกำหนด
 * กติกา: ตั้งรอบเข้าที่หาร 12 ลงตัว → 12 ÷ รอบเข้า (ทั้งระบบถือสัญญาเป็นรายปี — ตรงกับที่ฟอร์มเพิ่มสัญญา
 *        และการแก้รอบเข้าบันทึกไว้) ไม่งั้นใช้ visitCount ที่กรอกไว้ตรงๆ
 * ⚠️ ฝั่งแอปมีตัวเดียวกันที่ shared/utils/contractRounds.js (totalRoundsOf) — แก้ต้องแก้คู่กัน
 */
/**
 * ✅ (8 ต.ค. 2569 ผู้ใช้: "ลงเป็นแบบ เข้าปีละกี่ครั้ง และเข้ากี่ปี เช่น ปีละ 4 ครั้ง 2 ปี") จำนวนปีของสัญญา
 *    contractYears ที่เลือกในฟอร์ม → ไม่มี (สัญญาเก่า) คิดจากช่วงวันที่สัญญา → ไม่มีวันที่ = 1 ปี
 * ⚠️ ฝั่งแอปมีตัวเดียวกันที่ shared/utils/contractRounds.js (contractYearsOf) — แก้ต้องแก้คู่กัน
 */
const MAX_CONTRACT_YEARS = 5;
const contractYearsOf = (c) => {
  const y = Number(c && c.contractYears);
  if (Number.isInteger(y) && y >= 1) return Math.min(y, MAX_CONTRACT_YEARS);
  const a = c && c.contractStart ? new Date(c.contractStart) : null;
  const b = c && c.contractEnd ? new Date(c.contractEnd) : null;
  if (!a || !b || Number.isNaN(a.getTime()) || Number.isNaN(b.getTime()) || b < a) return 1;
  const days = (b - a) / 86400000 + 1;
  return Math.min(MAX_CONTRACT_YEARS, Math.max(1, Math.round(days / 365.25)));
};

/** จำนวนครั้งทั้งหมดของสัญญา = (ปีละกี่ครั้ง × จำนวนปี) เมื่อรอบเข้าหาร 12 ลงตัว · ไม่งั้นใช้ visitCount ที่กรอกไว้ */
const totalRoundsOf = (c) => {
  const n = Number(c && c.intervalMonths);
  if (n >= 1 && 12 % n === 0) return (12 / n) * contractYearsOf(c);
  return Number(c && c.visitCount) || 0;
};

/** ปีละกี่ครั้ง — ตรงกับ perYearOf ฝั่งแอป */
const perYearOf = (c) => {
  const n = Number(c && c.intervalMonths);
  if (n >= 1 && 12 % n === 0) return 12 / n;
  const total = Number(c && c.visitCount) || 0;
  const years = contractYearsOf(c);
  return years > 1 && total % years === 0 ? total / years : total;
};

/** "ครั้งที่ 2/4 - 2569" — นับใหม่ทุกปีของสัญญา (ตรงกับ formatRoundLabel ฝั่งแอป) */
const roundLabelOf = (t, c) => {
  const per = perYearOf(c);
  const n = Number(t);
  if (!per || !Number.isInteger(n) || n < 1) return `ครั้งที่ ${t}`;
  const yearIdx = Math.ceil(n / per);
  const inYear = ((n - 1) % per) + 1;
  const start = c && c.contractStart ? new Date(c.contractStart) : null;
  const year = start && !Number.isNaN(start.getTime()) ? start.getFullYear() + 543 + yearIdx - 1 : null;
  return `ครั้งที่ ${inYear}/${per}${year ? ` - ${year}` : ""}`;
};

module.exports = { DEFAULT_INTERVAL_MONTHS, MAX_CONTRACT_YEARS, contractYearsOf, totalRoundsOf, perYearOf, roundLabelOf };
