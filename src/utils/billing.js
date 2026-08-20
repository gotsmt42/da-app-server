/**
 * billing.js — คณิตศาสตร์ของการวางบิล/รับเงิน (ของกลาง ใช้ทั้ง route และตัวแจ้งเตือน)
 *
 * ⚠️ แยกออกมาเป็นไฟล์เดี่ยวเพราะเป็นตรรกะ "เรื่องเงิน" ที่ผิดไม่ได้ และต้องเทสต์ได้โดยไม่ต้องต่อ
 * ฐานข้อมูล — ตัวเลขพวกนี้ไปโผล่ในเอกสารที่ส่งให้ลูกค้าและในรายงานที่ผู้บริหารใช้ตัดสินใจ
 */

/**
 * ปัดทศนิยม 2 ตำแหน่งแบบเงินบาท
 * ⚠️ ห้ามใช้ Math.round(x * 100) / 100 ตรงๆ — เลขทศนิยมฐานสองทำให้ 1.005 กลายเป็น 1.00 แทนที่จะ
 * เป็น 1.01 (1.005 เก็บจริงเป็น 1.00499999999999989) ต้องขยับผ่าน exponent ของ string ก่อน
 */
function round2(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Number(`${Math.round(Number(`${v}e2`))}e-2`);
}

/**
 * คำนวณยอดทั้งชุดจาก "ยอดก่อน VAT + อัตราภาษี"
 *
 * ⚠️ ทั้ง VAT และภาษีหัก ณ ที่จ่าย คิดจาก "ยอดก่อน VAT" เหมือนกันทั้งคู่ — ไม่ใช่คิดหัก ณ ที่จ่าย
 * จากยอดรวม VAT (ผิดหลักสรรพากรไทย และทำให้ยอดโอนจริงเพี้ยนทุกใบ)
 * ⚠️ ปัดทีละตัวแล้วค่อยบวก ไม่ใช่บวกก่อนปัดทีเดียว — ใบกำกับภาษีจริงแสดงยอด VAT เป็นบรรทัดแยก
 * ที่ปัดแล้ว ถ้าปัดทีหลังยอดในระบบจะไม่ตรงกับกระดาษที่ส่งลูกค้าไป
 *
 * @returns {{amountBeforeVat:number, vatRate:number, vatAmount:number,
 *            whtRate:number, whtAmount:number, netAmount:number}}
 */
function computeBillingAmounts({ amountBeforeVat, vatRate = 7, whtRate = 3 }) {
  const base = round2(amountBeforeVat);
  const vr = Number.isFinite(Number(vatRate)) ? Number(vatRate) : 0;
  const wr = Number.isFinite(Number(whtRate)) ? Number(whtRate) : 0;
  const vatAmount = round2((base * vr) / 100);
  const whtAmount = round2((base * wr) / 100);
  return {
    amountBeforeVat: base,
    vatRate: vr,
    vatAmount,
    whtRate: wr,
    whtAmount,
    netAmount: round2(base + vatAmount - whtAmount),
  };
}

/** วันครบกำหนดชำระ = วันวางบิล + เครดิตเทอม (คืน null ถ้ายังไม่ได้วางบิล) */
function computeDueAt(invoicedAt, creditTermDays) {
  if (!invoicedAt) return null;
  const d = new Date(invoicedAt);
  if (Number.isNaN(d.getTime())) return null;
  const days = Number(creditTermDays);
  d.setDate(d.getDate() + (Number.isFinite(days) ? days : 0));
  return d;
}

/** ยอดที่รับมาแล้วทั้งหมด (ผลรวมของรายการรับเงิน) */
function paidTotal(billing) {
  return round2((billing?.payments || []).reduce((sum, p) => sum + (Number(p.amount) || 0), 0));
}

/**
 * สรุปสถานะของใบวางบิลใบหนึ่ง
 *
 * ⚠️ สถานะเป็น "ค่าคำนวณ" เสมอ ไม่เก็บลงฐานข้อมูล — ถ้าเก็บไว้ วันไหนลืมอัปเดตตอนบันทึกรับเงิน
 * สถานะจะค้างอยู่ที่ค่าเดิมและไม่มีอะไรฟ้อง (และ "เลยกำหนด" เปลี่ยนเองตามเวลาโดยไม่มีใครแตะข้อมูลเลย
 * ซึ่งเป็นไปไม่ได้ที่จะเก็บให้ถูกตลอด)
 *
 * @param {Date} [now] — ส่งเข้ามาได้เพื่อให้เทสต์กำหนดเวลาเองได้
 */
function billingStatus(billing, now = new Date()) {
  if (!billing?.invoicedAt) return { state: "not_invoiced", label: "ยังไม่ได้วางบิล" };

  const net = round2(billing.netAmount);
  const paid = paidTotal(billing);
  const outstanding = round2(net - paid);

  // ⚠️ ต้องเทียบด้วย <= 0 ไม่ใช่ === 0 — ลูกค้าโอนเกินเศษสตางค์เกิดขึ้นจริง ถ้าเทียบเท่ากันเป๊ะ
  // ใบนั้นจะค้างอยู่ในสถานะ "ชำระบางส่วน" ตลอดกาลทั้งที่รับเงินครบแล้ว
  if (net > 0 && outstanding <= 0) {
    return { state: "paid", label: "ชำระครบแล้ว", net, paid, outstanding: 0 };
  }

  const due = billing.dueAt ? new Date(billing.dueAt) : null;
  const overdueDays = due ? Math.floor((now - due) / 86400000) : 0;
  if (due && overdueDays > 0) {
    return {
      state: "overdue",
      label: `เลยกำหนดชำระ ${overdueDays} วัน`,
      net, paid, outstanding, overdueDays,
    };
  }
  if (paid > 0) return { state: "partial", label: "ชำระบางส่วน", net, paid, outstanding };
  return { state: "unpaid", label: "รอชำระ", net, paid, outstanding };
}

module.exports = { round2, computeBillingAmounts, computeDueAt, paidTotal, billingStatus };
