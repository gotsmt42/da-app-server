const moment = require("moment");
const CalendarEvent = require("../models/Events");
const User = require("../models/User");
const { sendPushToUsers, sendPushToRoles } = require("./PushNotify");
const { DEFAULT_INTERVAL_MONTHS } = require("../utils/contractVisits");

// ✅ เกณฑ์เดียวกับฝั่ง frontend (Operation/index.js) — เลยกำหนดวันสิ้นสุดงานตามแผนจริงมาแล้ว
// อย่างน้อย 1 สัปดาห์ ถือว่า "ค้างงาน" ต้องแจ้งเตือน
const WARNING_DAYS_AFTER_END = 7;
const SEVERE_DAYS_AFTER_END = 14;

// ✅ ลายเซ็นเดียวกับที่ใช้จัดกลุ่มงานหลายวันไม่ติดกันฝั่ง frontend (jobGroupId ก่อน ไม่มีก็ fallback
// ไปจับคู่ company/site/title/system/team/time)
const getGroupKey = (ev) => {
  if (ev.jobGroupId) return `gid:${ev.jobGroupId}`;
  return ["company", "site", "title", "system", "team", "time"]
    .map((k) => (ev[k] || "").toString().trim().toLowerCase())
    .join("|");
};

// ✅ เช็คงานค้างเกิน 1 สัปดาห์แล้วส่ง push แจ้งเตือนช่างที่รับผิดชอบ — เรียกซ้ำเป็นระยะๆ ได้เรื่อยๆ
// (ตั้งเวลาเรียกจาก index.js) ไม่หยุดเตือนจนกว่าช่างจะปิดงาน/ขอปิดงานจริง ตรงตามที่ต้องการให้
// แจ้งเตือน "เป็นระยะๆ" ผ่านหน้าจอจริงของช่าง ไม่ใช่แค่ badge เงียบๆ ในแอป
async function checkAndNotifyOverdueJobs() {
  try {
    const events = await CalendarEvent.find({
      status: { $ne: "ดำเนินการเสร็จสิ้น" },
      closeRequested: { $ne: true },
    })
      .select("company site title system team time jobGroupId resPerson userId end start allDay")
      .lean();

    if (events.length === 0) return;

    // ✅ งานที่เข้าหลายวันไม่ติดกัน (ผูกด้วย jobGroupId/ลายเซ็นเดียวกัน) ต้องนับเป็น "1 งาน" และคิด
    // ค้างจากวันสุดท้ายของทั้งชุด ไม่ใช่นับ/คิดแยกทีละแถว (เทียบ pattern เดียวกับหน้า Operation)
    const bySignature = new Map();
    events.forEach((e) => {
      const key = getGroupKey(e);
      if (!bySignature.has(key)) bySignature.set(key, []);
      bySignature.get(key).push(e);
    });

    const overdueJobs = []; // { sessions, daysPastDue }
    bySignature.forEach((sessions) => {
      let lastPlanEnd = null;
      sessions.forEach((e) => {
        const end = e.end
          ? moment(e.end).subtract(e.allDay ? 1 : 0, "days")
          : moment(e.start);
        if (!lastPlanEnd || end.isAfter(lastPlanEnd)) lastPlanEnd = end;
      });
      const daysPastDue = moment().startOf("day").diff(lastPlanEnd.startOf("day"), "days");
      // ✅ ใช้ > แทน >= — วันที่ครบพอดี 7 วันยังไม่ถือว่า "เกิน" 1 สัปดาห์ (เทียบเกณฑ์เดียวกับ
      // isFlaggedDays ใน utils/overdueJobs.js ฝั่ง frontend)
      if (daysPastDue > WARNING_DAYS_AFTER_END) overdueJobs.push({ sessions, daysPastDue });
    });

    if (overdueJobs.length === 0) return;

    // ✅ หาเจ้าของงานจริงด้วยลำดับความสำคัญเดียวกับที่ backend ใช้ตัดสินว่า "งานนี้ของช่างคนไหน"
    // ใน GET /events/event-op (resPerson ตรงๆ → ชื่อทีมตรงกับ fname → คนที่สร้าง event เอง)
    // ข้อมูลจริงในระบบพบว่า resPerson แทบไม่ถูกตั้งเลย และหลายงานตั้ง team เป็นชื่อคนที่ลาออก/ไม่มี
    // บัญชีจริงแล้ว (ไม่ match กับ user คนไหนเลย) — กรณีนั้นไม่มีทางแจ้งเตือนใครได้ ข้ามไปเงียบๆ
    const allUsers = await User.find({}).select("fname role").lean();
    const userById = new Map(allUsers.map((u) => [u._id.toString(), u]));
    const userByFname = new Map(allUsers.map((u) => [u.fname, u]));

    const resolveTech = (sessions) => {
      for (const e of sessions) {
        if (e.resPerson && userById.has(e.resPerson.toString())) return userById.get(e.resPerson.toString());
      }
      for (const e of sessions) {
        if (e.team && userByFname.has(e.team)) return userByFname.get(e.team);
      }
      for (const e of sessions) {
        if (e.userId && userById.has(e.userId.toString())) return userById.get(e.userId.toString());
      }
      return null;
    };

    // ✅ แจ้งเฉพาะช่าง — ถ้าหาเจ้าของจริงไม่เจอ หรือดันไปตรงกับแอดมิน/manager (เช่น เป็นคนสร้าง
    // event เองแต่ไม่ได้เป็นคนทำ) ให้ข้าม ไม่ใช่เป้าหมายของการแจ้งเตือนนี้
    const overdueByTech = new Map();
    overdueJobs.forEach(({ sessions, daysPastDue }) => {
      const user = resolveTech(sessions);
      if (!user || user.role !== "technician") return;
      const techId = user._id.toString();
      if (!overdueByTech.has(techId)) overdueByTech.set(techId, []);
      overdueByTech.get(techId).push(daysPastDue);
    });

    for (const [techId, daysList] of overdueByTech.entries()) {
      const severeCount = daysList.filter((d) => d > SEVERE_DAYS_AFTER_END).length;
      const body = severeCount > 0
        ? `มี ${daysList.length} งานเลยกำหนดส่งมอบ (${severeCount} งานเกิน 2 สัปดาห์) กรุณาตรวจสอบและปิดงาน`
        : `มี ${daysList.length} งานเลยกำหนดส่งมอบแล้ว กรุณาตรวจสอบและปิดงาน`;

      await sendPushToUsers(techId, {
        title: "⚠️ มีงานค้างเกิน 1 สัปดาห์",
        body,
        url: "/operation",
        tag: "overdue-reminder",
        renotify: true,
      });
    }
  } catch (err) {
    console.error("❌ Overdue reminder check error:", err);
  }
}

// ✅ ระบบติดตามใบเสนอราคา — เตือนแอดมิน/manager เมื่อส่งใบเสนอราคาให้ลูกค้าไปแล้วเกิน 3 วัน
// ยังไม่มีการบันทึกผล (อนุมัติ/ปฏิเสธ/ขอแก้ไข) เพื่อกันไม่ให้ลืมติดตามลูกค้า (เทียบ pattern เดียวกับ
// checkAndNotifyOverdueJobs ด้านบน แค่คิดจาก quotationSentAt แทนวันสิ้นสุดงาน)
const QUOTATION_WARNING_DAYS = 3;

async function checkAndNotifyStaleQuotations() {
  try {
    const events = await CalendarEvent.find({ quotationStatus: "sent" })
      .select("company site title system team time jobGroupId quotationSentAt")
      .lean();

    if (events.length === 0) return;

    // ✅ งานที่เข้าหลายวัน (jobGroupId เดียวกัน) มีค่า quotationSentAt ตรงกันทุกแถวอยู่แล้ว (อัปเดตทั้ง
    // กลุ่มพร้อมกันตอนกดจากหน้า /quotations) — จัดกลุ่มก่อนนับ กันแจ้งเตือนซ้ำหลายครั้งต่องานเดียว
    const seen = new Set();
    let staleCount = 0;
    events.forEach((e) => {
      const key = getGroupKey(e);
      if (seen.has(key)) return;
      seen.add(key);
      if (!e.quotationSentAt) return;
      const days = moment().startOf("day").diff(moment(e.quotationSentAt).startOf("day"), "days");
      if (days > QUOTATION_WARNING_DAYS) staleCount++;
    });

    if (staleCount === 0) return;

    await sendPushToRoles(["admin", "manager"], {
      title: "📄 มีใบเสนอราคาที่ต้องติดตาม",
      body: `มี ${staleCount} ใบเสนอราคาที่ส่งลูกค้าไปแล้วเกิน ${QUOTATION_WARNING_DAYS} วัน ยังไม่ได้บันทึกผล กรุณาติดตาม`,
      url: "/quotations",
      tag: "quotation-reminder",
      renotify: true,
    });
  } catch (err) {
    console.error("❌ Quotation reminder check error:", err);
  }
}

// ✅ เตือนแอดมิน/manager ว่ามีสัญญาที่รอบล่าสุดผ่านมาเกินระยะห่างระหว่างรอบที่กำหนดไว้แล้ว แต่ยังไม่ได้
// ลงแผนงานครั้งถัดไปเลย — เดิมเห็นได้แค่จุดแดงในตาราง "ภาพรวมงาน" ตอนเปิดหน้าค้างไว้เท่านั้น ⚠️ ตรรกะ
// ต้องตรงกับ utils/contractOverdue.js (nextVisitOverdueInfo) ฝั่ง frontend เป๊ะๆ ไม่งั้นตัวเลขในแจ้งเตือน
// กับจุดแดงในตารางจะไม่ตรงกัน — query ด้วย contractGroupId เฉยๆ (ไม่กรอง unscheduled) เพราะ
// countUsedRounds ฝั่งจอนับรวมแผนงานล่วงหน้าด้วย
async function checkAndNotifyOverdueContracts() {
  try {
    const events = await CalendarEvent.find({ contractGroupId: { $exists: true, $nin: [null, ""] } })
      .select("contractGroupId visitCount intervalMonths time start end unscheduled")
      .lean();
    if (events.length === 0) return;

    const byContract = new Map();
    events.forEach((e) => {
      if (!byContract.has(e.contractGroupId)) byContract.set(e.contractGroupId, []);
      byContract.get(e.contractGroupId).push(e);
    });

    const overdueMonths = [];
    byContract.forEach((visits) => {
      const sorted = visits.slice().sort((a, b) => (Number(a.time) || 0) - (Number(b.time) || 0));
      const head = sorted[0];
      const visitCount = Number(head.visitCount);
      if (!visitCount) return;
      const usedRounds = new Set(
        sorted.map((v) => v.time).filter((t) => t !== undefined && t !== null && t !== "").map(String)
      );
      if (usedRounds.size >= visitCount) return;
      const realVisits = sorted.filter((v) => !v.unscheduled);
      if (realVisits.length === 0) return;
      const lastVisitDate = realVisits.reduce((latest, v) => {
        const d = moment(v.end || v.start);
        return !latest || d.isAfter(latest) ? d : latest;
      }, null);
      const dueDate = lastVisitDate.clone().add(Number(head.intervalMonths) || DEFAULT_INTERVAL_MONTHS, "months");
      if (dueDate.isAfter(moment())) return;
      overdueMonths.push(Math.max(1, moment().diff(dueDate, "months") + 1));
    });
    if (overdueMonths.length === 0) return;

    await sendPushToRoles(["admin", "manager"], {
      title: "📋 มีสัญญาที่ยังไม่ได้วางแผนรอบถัดไป",
      body: `มี ${overdueMonths.length} สัญญาที่เลยกำหนดรอบถัดไปแล้ว (นานสุด ${Math.max(...overdueMonths)} เดือน) กรุณาตรวจสอบและลงแผนงานครั้งถัดไป`,
      url: "/contracts",
      tag: "contract-round-reminder",
      renotify: true,
    });
  } catch (err) {
    console.error("❌ Contract round reminder check error:", err);
  }
}

module.exports = { checkAndNotifyOverdueJobs, checkAndNotifyStaleQuotations, checkAndNotifyOverdueContracts };
