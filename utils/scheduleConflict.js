const Events = require("../models/Events");

// ✅ ช่วง end ของ event ที่เก็บไว้เป็นแบบ exclusive (บวก +1 วันไว้แล้วตอนสร้าง — ดู AddEvent.js/
// formatDateRange.js ฝั่ง frontend) ดังนั้นเช็คทับกันต้องใช้ "<" เข้มงวด ไม่ใช่ "<=" ไม่งั้นงานที่
// ต่อกันพอดี (จบวันนี้ เริ่มวันถัดไป) จะถูกฟ้องว่าชนกันทั้งที่จริงไม่ชน
const rangesOverlap = (startA, endA, startB, endB) => {
  return new Date(startA) < new Date(endB) && new Date(startB) < new Date(endA);
};

// ✅ เช็คว่า resPerson คนนี้มีงานอื่นในระบบที่ช่วงวันที่ทับกับช่วงที่กำลังจะบันทึกหรือไม่
// (ไม่นับงาน "วางแผนล่วงหน้า" ที่ยังไม่ลงตาราง เพราะยังไม่มีวันที่จริง และไม่นับ record ตัวเองตอนแก้ไข)
// นับทุกสถานะรวมถึงงานที่ปิดแล้ว — ช่างไปทำ 2 ที่พร้อมกันไม่ได้จริงไม่ว่างานจะปิดไปแล้วหรือไม่
async function findResPersonConflicts({ resPerson, start, end, excludeEventId }) {
  if (!resPerson || !start || !end) return [];

  const query = {
    resPerson,
    unscheduled: { $ne: true },
    start: { $lt: end },
    end: { $gt: start },
  };
  if (excludeEventId) query._id = { $ne: excludeEventId };

  return Events.find(query)
    .select("company site title start end")
    .lean();
}

// ✅ เช็คช่วงวันที่ในชุดเดียวกัน (dates[] ที่ส่งมาพร้อมกันตอนสร้างสัญญาหลายครั้ง) ชนกันเองหรือไม่
// เช็คในหน่วยความจำล้วนๆ ไม่มีการ query ฐานข้อมูล — กันเคสกรอกวันที่ครั้งที่ 1/3 ทับกันเองโดยไม่ตั้งใจ
function findMutualOverlaps(dateRanges) {
  const conflicts = [];
  for (let i = 0; i < dateRanges.length; i++) {
    for (let j = i + 1; j < dateRanges.length; j++) {
      const a = dateRanges[i];
      const b = dateRanges[j];
      if (rangesOverlap(a.start, a.end, b.start, b.end)) {
        conflicts.push([a, b]);
      }
    }
  }
  return conflicts;
}

module.exports = { findResPersonConflicts, findMutualOverlaps, rangesOverlap };
