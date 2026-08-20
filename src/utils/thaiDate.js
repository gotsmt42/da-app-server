const moment = require("moment");
require("moment/locale/th");

/**
 * thaiDate.js — จัดรูปแบบวันที่แบบไทย (พ.ศ. + เดือนภาษาไทย) สำหรับ "ข้อความที่ผู้ใช้อ่าน"
 *
 * ⚠️ คู่แฝดของ da-app/src/shared/utils/thaiDate.js — ต้องแก้พร้อมกันเสมอ (แบบเดียวกับ utils/billing.js)
 * ถ้าสองฝั่งคำนวณไม่ตรงกัน ผู้ใช้จะเห็นวันที่ในแจ้งเตือนไม่ตรงกับที่เห็นบนหน้าจอ ซึ่งหาสาเหตุยากมาก
 *
 * ⚠️ ใช้กับข้อความแจ้งเตือน / ข้อความ error / รายละเอียดใน audit log เท่านั้น
 * ห้ามใช้กับค่าที่เก็บลงฐานข้อมูลหรือส่งกลับไปให้ frontend คำนวณต่อ ซึ่งต้องเป็น ค.ศ. เสมอ
 *
 * 🐛 ห้ามทำเป็น clone().add(543, "years") — 29 ก.พ. จะถูกหดเหลือ 28 ก.พ. เงียบๆ เพราะปีปลายทาง
 * ไม่ใช่ปีอธิกสุรทิน วิธีที่ใช้คือแก้ที่ "ตัวรูปแบบ" แทน โดยเปลี่ยน token ปีเป็นข้อความตายตัว
 */

const BE_OFFSET = 543;

const toBEYear = (ceYear) => Number(ceYear) + BE_OFFSET;

/**
 * เปลี่ยน token ปี (YYYY / YY) ให้เป็นข้อความตายตัวของปี พ.ศ.
 * ⚠️ ต้องจับ [...] ที่ escape ไว้ก่อนเสมอ ไม่งั้นข้อความที่ตั้งใจ escape ไว้จะโดนแปลงไปด้วย
 */
const patchYearTokens = (pattern, beYear) =>
  String(pattern).replace(/\[[^\]]*\]|Y{2,4}/g, (token) => {
    if (token[0] === "[") return token;
    if (token === "YY") return `[${String(beYear).slice(-2)}]`;
    return `[${beYear}]`;
  });

/**
 * @param {*} value          วันที่ (Date / string / moment)
 * @param {string} pattern   รูปแบบของ moment เช่น "D MMM YYYY"
 * @param {string} [fallback] ข้อความเมื่อค่าใช้ไม่ได้
 */
function formatThai(value, pattern, fallback = "-") {
  if (value === null || value === undefined || value === "") return fallback;
  const m = moment.isMoment(value) ? value.clone() : moment(value);
  if (!m.isValid()) return fallback;
  return m.locale("th").format(patchYearTokens(pattern, toBEYear(m.year())));
}

/** 20 ส.ค. 2569 */
const thaiDate = (value, fallback = "-") => formatThai(value, "D MMM YYYY", fallback);

/** 20/08/2569 */
const thaiDateNumeric = (value, fallback = "-") => formatThai(value, "DD/MM/YYYY", fallback);

/** 20 สิงหาคม 2569 */
const thaiDateFull = (value, fallback = "-") => formatThai(value, "D MMMM YYYY", fallback);

module.exports = {
  BE_OFFSET,
  toBEYear,
  patchYearTokens,
  formatThai,
  thaiDate,
  thaiDateNumeric,
  thaiDateFull,
};
