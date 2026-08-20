const moment = require("moment");
const Events = require("../models/Events");

// ✅ ช่วง end ของ event ที่เก็บไว้เป็นแบบ exclusive (บวก +1 วันไว้แล้วตอนสร้าง — ดู AddEvent.js/
// formatDateRange.js ฝั่ง frontend) ดังนั้นเช็คทับกันต้องใช้ "<" เข้มงวด ไม่ใช่ "<=" ไม่งั้นงานที่
// ต่อกันพอดี (จบวันนี้ เริ่มวันถัดไป) จะถูกฟ้องว่าชนกันทั้งที่จริงไม่ชน
const rangesOverlap = (startA, endA, startB, endB) => {
  return new Date(startA) < new Date(endB) && new Date(startB) < new Date(endA);
};

// ✅ ช่วง start/end ปกติเป็นแค่ "วัน" ล้วนๆ (exclusive whole-day) ไม่มีเวลา — ถ้าเช็คด้วยวันเฉยๆ ทีม
// เดียวกันจะมี 2 งานในวันเดียวกันไม่ได้เลย ทั้งที่จริงอาจเป็นคนละช่วงเวลากัน (เช่น เช้า 08:00-10:00
// กับบ่าย 13:00-15:00) — ถ้าเป็นงานวันเดียวและกรอกเวลาเริ่ม/สิ้นสุดไว้ครบทั้งคู่ ให้ใช้ช่วงเวลาจริงแทน
// ทั้งวันในการเทียบ ส่วนงานหลายวันหรือที่ไม่ได้ระบุเวลา (ไม่รู้จะชนกันจริงไหม) ยังกันทั้งวันไว้เหมือนเดิม
const effectiveRange = ({ start, end, startTime, endTime }) => {
  const isSingleDay = moment(end).diff(moment(start), "days") === 1;
  if (isSingleDay && startTime && endTime) {
    const day = moment(start).format("YYYY-MM-DD");
    const s = moment(`${day} ${startTime}`, "YYYY-MM-DD HH:mm", true);
    const e = moment(`${day} ${endTime}`, "YYYY-MM-DD HH:mm", true);
    if (s.isValid() && e.isValid() && e.isAfter(s)) {
      return { start: s.toDate(), end: e.toDate() };
    }
  }
  return { start, end };
};

// ✅ เช็คว่า resPerson คนนี้มีงานอื่นในระบบที่ช่วงเวลาทับกับช่วงที่กำลังจะบันทึกหรือไม่
// (ไม่นับงาน "วางแผนล่วงหน้า" ที่ยังไม่ลงตาราง เพราะยังไม่มีวันที่จริง และไม่นับ record ตัวเองตอนแก้ไข)
// นับทุกสถานะรวมถึงงานที่ปิดแล้ว — ช่างไปทำ 2 ที่พร้อมกันไม่ได้จริงไม่ว่างานจะปิดไปแล้วหรือไม่
async function findResPersonConflicts({ resPerson, start, end, startTime, endTime, excludeEventId }) {
  if (!resPerson || !start || !end) return [];

  const query = {
    resPerson,
    unscheduled: { $ne: true },
    start: { $lt: end },
    end: { $gt: start },
  };
  if (excludeEventId) query._id = { $ne: excludeEventId };

  // ✅ query ด้านบนกรองแค่ระดับวัน (กว้างไว้ก่อน ใช้ index ได้เต็มที่) แล้วค่อยกรองซ้ำในหน่วยความจำ
  // ด้วยช่วงเวลาจริง (effectiveRange) อีกที เพื่อตัดคู่ที่วันชนกันแต่เวลาจริงไม่ชนออกไป
  const candidates = await Events.find(query)
    .select("company site title start end startTime endTime")
    .lean();

  const incoming = effectiveRange({ start, end, startTime, endTime });
  return candidates.filter((c) => {
    const other = effectiveRange(c);
    return rangesOverlap(incoming.start, incoming.end, other.start, other.end);
  });
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
