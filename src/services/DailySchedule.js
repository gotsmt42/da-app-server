/**
 * DailySchedule.js — จับเวลาให้งานประจำวันทำงาน "เวลาเดิมทุกวัน" ตามเวลาประเทศไทย
 *
 * 🐛 ปัญหาที่แก้ (แจ้งเตือนมั่ว เวลาไม่แน่นอน): เดิมใช้ setTimeout(2 นาที) + setInterval(24 ชม.)
 * ซึ่งนับจาก "เวลาที่โปรเซสเริ่มทำงาน" — deploy ตอน 09:20 ก็ได้แจ้ง 09:22 ทุกวัน, deploy ใหม่ตอน
 * 15:40 ก็ย้ายไปแจ้ง 15:42 แทน ผู้ใช้จึงเจอเวลาแจ้งเปลี่ยนไปเรื่อยๆ ทุกครั้งที่ขึ้นระบบใหม่
 * ✅ ตอนนี้ยิงที่ "เวลาตามนาฬิกา" ที่กำหนดเสมอ ไม่ว่าโปรเซสจะเริ่มเมื่อไหร่
 *
 * ⚠️ ต้องคำนวณเป็นเวลาไทยเองเสมอ ห้ามพึ่ง new Date() ของเครื่อง — เซิร์ฟเวอร์ที่ deploy จริงมัก
 * ตั้งเป็น UTC (เครื่องพัฒนาเป็น UTC+7) ถ้าใช้เวลาเครื่องตรงๆ จะกลายเป็นแจ้ง 19:00 บนเครื่องจริง
 * ⚠️ ไทยไม่มี daylight saving และไม่เคยเปลี่ยน offset ตั้งแต่ปี 2463 — คิดจาก +7 คงที่ได้ปลอดภัย
 * (ถ้าวันหนึ่งต้องรองรับหลายประเทศ ค่อยเปลี่ยนไปใช้ Intl.DateTimeFormat + timeZone แทน)
 */
const TH_OFFSET_MS = 7 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * เวลาที่กำหนดของ "วันนี้" (ตามเวลาไทย) เป็น epoch ms — ตัวตั้งของทั้ง 2 ฟังก์ชันด้านล่าง
 * ⚠️ แยกออกมาเพราะเคยเขียนเงื่อนไข "เลยเวลาวันนี้แล้วหรือยัง" เป็นสูตรลบเวลาที่กลับหัวกลับหาง
 * (nextRunAt - now > DAY_MS - 1000) ซึ่งให้ผลผิดทุกครั้งที่บูตหลังเที่ยง — เทียบกับเวลาเป้าหมายตรงๆ
 * แบบนี้อ่านออกทันทีว่าถูกหรือผิด ไม่ต้องนั่งคิดเลขในหัว
 */
function targetToday(hour, minute, now) {
  const th = new Date(now + TH_OFFSET_MS);   // เลื่อนให้ getUTC* อ่านเป็นเวลาไทย
  return Date.UTC(th.getUTCFullYear(), th.getUTCMonth(), th.getUTCDate(), hour, minute, 0, 0) - TH_OFFSET_MS;
}

/**
 * เวลาที่ควรทำงาน "ครั้งถัดไป" (epoch ms)
 * ⚠️ ถ้าเวลาของวันนี้ผ่านไปแล้ว "หรือตรงพอดี" ให้ข้ามไปพรุ่งนี้ — ต้องใช้ <= ไม่ใช่ <
 * ไม่งั้นตอนยิงเสร็จพอดีวินาทีนั้น จะได้เวลาเดิมกลับมาแล้วยิงซ้ำเป็นลูปไม่จบ
 */
function nextRunAt(hour, minute = 0, now = Date.now()) {
  const t = targetToday(hour, minute, now);
  return t <= now ? t + DAY_MS : t;
}

/** เวลาที่กำหนดของวันนี้ผ่านไปแล้วหรือยัง (ใช้ตัดสินว่าต้องตามเก็บของวันนี้ไหม) */
function isPastToday(hour, minute = 0, now = Date.now()) {
  return now >= targetToday(hour, minute, now);
}

const fmtTh = (ms) => new Date(ms + TH_OFFSET_MS).toISOString().replace("T", " ").slice(0, 19);

/**
 * ตั้งให้ task ทำงานทุกวันเวลาเดิม
 *
 * @param {number}   hour           ชั่วโมงตามเวลาไทย (0-23)
 * @param {number}   minute
 * @param {string}   name           ชื่อไว้ log
 * @param {Function} task
 * @param {boolean}  [catchUpOnBoot=true]  ถ้าโปรเซสเริ่มหลังเวลาที่กำหนดของวันนั้นไปแล้ว ให้ตามเก็บทันที
 * @param {number}   [bootDelayMs]  หน่วงก่อนตามเก็บ (รอ DB ต่อให้เสร็จก่อน)
 */
function scheduleDaily({ hour, minute = 0, name, task, catchUpOnBoot = true, bootDelayMs = 60 * 1000 }) {
  // ⚠️ ตั้งเวลาครั้งถัดไป "หลังงานเสร็จ" ทุกครั้ง ไม่ใช้ setInterval — setInterval จะสะสมความคลาดเคลื่อน
  // ไปเรื่อยๆ และถ้างานรอบหนึ่งใช้เวลานานกว่าปกติ รอบถัดไปจะซ้อนทับกันเอง
  const arm = () => {
    const at = nextRunAt(hour, minute);
    const delay = at - Date.now();
    console.log(`⏰ [${name}] รอบถัดไป ${fmtTh(at)} (อีก ${Math.round(delay / 60000)} นาที)`);
    // ⚠️ unref() ไม่ได้ — ถ้า unref แล้วโปรเซสที่ไม่มีงานอื่นค้างจะปิดตัวเองก่อนถึงเวลา
    setTimeout(run, delay);
  };

  const run = async () => {
    try {
      await task();
    } catch (err) {
      // ⚠️ ต้องกลืน error ให้ได้เสมอ — ถ้าปล่อยหลุด งานรอบถัดไปจะไม่ถูกตั้งเวลาแล้วเงียบหายไปตลอดกาล
      console.error(`❌ [${name}] ทำงานไม่สำเร็จ:`, err);
    } finally {
      arm();
    }
  };

  if (catchUpOnBoot && isPastToday(hour, minute)) {
    // ✅ ตามเก็บของวันนี้ — เผื่อเซิร์ฟเวอร์ดับคร่อมเวลาที่กำหนดไว้
    // ⚠️ ไม่ได้ทำให้แจ้งซ้ำตอน deploy หลายรอบ เพราะชั้นส่งกันซ้ำด้วย NotifyLog.claimOncePerDay
    // (1 เรื่อง : 1 ผู้รับ : 1 วัน) อยู่แล้ว — รอบที่สองของวันเดียวกันจะถูกตัดทิ้งเอง
    console.log(`⏰ [${name}] เลยเวลาของวันนี้แล้ว — ตามเก็บใน ${Math.round(bootDelayMs / 1000)} วินาที`);
    setTimeout(run, bootDelayMs);
  } else {
    arm();
  }
}

module.exports = { scheduleDaily, nextRunAt, isPastToday, TH_OFFSET_MS };
