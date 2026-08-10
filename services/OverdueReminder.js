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

// ✅ หาผู้รับผิดชอบงานจริงด้วยลำดับความสำคัญ — ผู้ใช้ต้องการให้การแจ้งเตือน "งานคงค้าง"/"ใบเสนอราคาค้าง"
// เป็นสิ่งที่ "ผู้รับผิดชอบ" (responsiblePerson) ต้องติดตามเอง ไม่ใช่ "ทีมที่เข้างาน" (team) เหมือนเดิม
// อีกต่อไป — เช็ค responsiblePersonId/responsiblePerson ก่อน แล้วค่อย fallback ไปที่ resPerson → team →
// คนที่สร้าง event เอง (userId) — ข้อมูลจริงในระบบพบว่าหลายงานตั้งชื่อคนที่ลาออก/ไม่มีบัญชีจริงแล้ว
// (ไม่ match กับ user คนไหนเลย) จึงต้อง cascade ผ่านหลายชั้นแบบนี้ กันไม่มีทางแจ้งเตือนใครได้เลย
// ใช้ร่วมกันทั้ง checkAndNotifyOverdueJobs/checkAndNotifyStaleQuotations ด้านล่าง
function resolveResponsibleUser(sessions, userById, userByFname) {
  for (const e of sessions) {
    if (e.responsiblePersonId && userById.has(e.responsiblePersonId.toString())) return userById.get(e.responsiblePersonId.toString());
  }
  for (const e of sessions) {
    if (e.responsiblePerson && userByFname.has(e.responsiblePerson)) return userByFname.get(e.responsiblePerson);
  }
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
}

// ✅ เช็คงานค้างเกิน 1 สัปดาห์แล้วส่ง push แจ้งเตือนช่างที่รับผิดชอบ — เรียกซ้ำเป็นระยะๆ ได้เรื่อยๆ
// (ตั้งเวลาเรียกจาก index.js) ไม่หยุดเตือนจนกว่าช่างจะปิดงาน/ขอปิดงานจริง ตรงตามที่ต้องการให้
// แจ้งเตือน "เป็นระยะๆ" ผ่านหน้าจอจริงของช่าง ไม่ใช่แค่ badge เงียบๆ ในแอป
async function checkAndNotifyOverdueJobs() {
  try {
    const events = await CalendarEvent.find({
      status: { $ne: "ดำเนินการเสร็จสิ้น" },
      closeRequested: { $ne: true },
    })
      .select("company site title system team time jobGroupId resPerson userId end start allDay responsiblePersonId responsiblePerson")
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

    const allUsers = await User.find({}).select("fname role").lean();
    const userById = new Map(allUsers.map((u) => [u._id.toString(), u]));
    const userByFname = new Map(allUsers.map((u) => [u.fname, u]));

    // ✅ แจ้งเฉพาะช่าง — ถ้าหาผู้รับผิดชอบจริงไม่เจอ หรือดันไปตรงกับแอดมิน/manager (เช่น เป็นคนสร้าง
    // event เองแต่ไม่ได้เป็นคนรับผิดชอบ) ให้ข้าม ไม่ใช่เป้าหมายของการแจ้งเตือนนี้
    const overdueByTech = new Map();
    overdueJobs.forEach(({ sessions, daysPastDue }) => {
      const user = resolveResponsibleUser(sessions, userById, userByFname);
      if (!user || user.role !== "technician") return;
      const techId = user._id.toString();
      if (!overdueByTech.has(techId)) overdueByTech.set(techId, []);
      // ✅ เก็บ id ตัวแทนของงานนี้ไว้ด้วย (เอา session แรกพอ) ไม่ใช่แค่จำนวนวันที่ค้างเฉยๆ — ใช้พาไปที่
      // งานนั้นตรงๆ ได้เลยถ้าช่างคนนี้มีงานค้างแค่งานเดียว ไม่ต้องเปิด /operation แล้วไล่หาเอง
      overdueByTech.get(techId).push({ daysPastDue, id: sessions[0]._id.toString() });
    });

    for (const [techId, jobs] of overdueByTech.entries()) {
      const daysList = jobs.map((j) => j.daysPastDue);
      const severeCount = daysList.filter((d) => d > SEVERE_DAYS_AFTER_END).length;
      const body = severeCount > 0
        ? `มี ${daysList.length} งานเลยกำหนดส่งมอบ (${severeCount} งานเกิน 2 สัปดาห์) กรุณาตรวจสอบและปิดงาน`
        : `มี ${daysList.length} งานเลยกำหนดส่งมอบแล้ว กรุณาตรวจสอบและปิดงาน`;

      // ✅ ค้างแค่งานเดียว — เจาะจงพาไปที่งานนั้นเลย (/operation/:id?group=overdue ตรงกับ pattern เดียว
      // กับที่การ์ด "งานค้างของช่าง" ใน Dashboard ใช้อยู่แล้ว — group=overdue สั่งให้แถบสถานะบนหน้า
      // Operation ไฮไลต์ถูกกลุ่มด้วย) มากกว่า 1 งานถึงค่อยพาไปหน้ารวมเหมือนเดิม
      const url = jobs.length === 1 ? `/operation/${jobs[0].id}?group=overdue` : "/operation";

      await sendPushToUsers(techId, {
        title: "⚠️ มีงานค้างเกิน 1 สัปดาห์",
        body,
        url,
        tag: "overdue-reminder",
        renotify: true,
      });
    }
  } catch (err) {
    console.error("❌ Overdue reminder check error:", err);
  }
}

// ✅ ระบบติดตามใบเสนอราคา — เตือนแอดมิน/manager แบบภาพรวม และเตือน "ผู้รับผิดชอบ" ของแต่ละงานเป็นราย
// คนด้วย (ผู้รับผิดชอบเป็นคนติดตามใบเสนอราคาของงานตัวเอง ไม่ใช่ "ทีมที่เข้างาน")
//
// ⚠️ ตรรกะต้องตรงกับ src/utils/quotationTracking.js ฝั่งหน้าจอเป๊ะๆ (คนละโปรเจกต์ import ข้ามกันไม่ได้
// จึงต้องคัดลอกมา — แก้ที่ไหนต้องแก้อีกที่เสมอ) ไม่งั้นหน้าจอบอกว่า "ต้องติดตาม" แต่ไม่มีแจ้งเตือน
// หรือกลับกัน ผู้ใช้จะไม่รู้ว่าอันไหนถูก
//
// 🐛 BUG ที่แก้ 2 อย่าง:
// 1) เกณฑ์เดิม 3 วัน ไม่ตรงกับที่อื่นในระบบ (หน้า Dashboard ใช้ 7) — รวมเป็น 7 วันทั้งระบบตามที่ผู้ใช้ขอ
// 2) เดิมนับจาก quotationSentAt อย่างเดียว ไม่สนใจ quotationFollowUps เลย — ช่างโทรตามลูกค้าแล้ว
//    บันทึกผลไว้เรียบร้อย ระบบก็ยังเด้งเตือนทุกวันเพราะยังนับจากวันที่ส่งครั้งแรกอยู่ดี บันทึกติดตามจึง
//    ไม่มีผลอะไรเลย — ต้องนับจาก "การติดต่อลูกค้าครั้งล่าสุด" แทน บันทึก 1 ครั้ง = ได้เวลาอีก 7 วัน
const QUOTATION_WARNING_DAYS = 7;

// ✅ วันที่ติดต่อลูกค้าครั้งล่าสุด — วันที่ส่ง หรือวันที่ติดตามครั้งล่าสุด แล้วแต่อันไหนใหม่กว่า
function getLastContactAt(event) {
  let latest = moment(event.quotationSentAt);
  (event.quotationFollowUps || []).forEach((f) => {
    if (!f?.contactedAt) return;
    const t = moment(f.contactedAt);
    if (t.isValid() && t.isAfter(latest)) latest = t;
  });
  return latest;
}

async function checkAndNotifyStaleQuotations() {
  try {
    // ⚠️ ต้อง select quotationFollowUps มาด้วย ไม่งั้นคำนวณ "ติดต่อครั้งล่าสุด" ไม่ได้ (เดิมไม่ได้ดึงมา)
    const events = await CalendarEvent.find({ quotationStatus: "sent" })
      .select("company site title system team time jobGroupId quotationSentAt quotationFollowUps resPerson userId responsiblePersonId responsiblePerson")
      .lean();

    if (events.length === 0) return;

    // ✅ งานที่เข้าหลายวัน (jobGroupId เดียวกัน) มีค่า quotationSentAt ตรงกันทุกแถวอยู่แล้ว (อัปเดตทั้ง
    // กลุ่มพร้อมกันตอนกดจากหน้า /quotations) — จัดกลุ่มก่อนนับ กันแจ้งเตือนซ้ำหลายครั้งต่องานเดียว
    const bySignature = new Map();
    events.forEach((e) => {
      const key = getGroupKey(e);
      if (!bySignature.has(key)) bySignature.set(key, []);
      bySignature.get(key).push(e);
    });

    const staleJobs = []; // { sessions, jobId }
    bySignature.forEach((sessions) => {
      const head = sessions[0];
      if (!head.quotationSentAt) return;
      // ⚠️ การบันทึกติดตามอาจอยู่ที่ session ไหนก็ได้ในกลุ่ม (ฝั่งจอยิงไปที่ document ตัวแทน) — ต้องหา
      // "ครั้งล่าสุดของทั้งกลุ่ม" ไม่ใช่ดูแค่ head ไม่งั้นบันทึกไปแล้วแต่ระบบยังเตือนอยู่เหมือนเดิม
      const lastContact = sessions
        .map(getLastContactAt)
        .reduce((a, b) => (b.isAfter(a) ? b : a));
      const days = moment().startOf("day").diff(lastContact.startOf("day"), "days");
      if (days > QUOTATION_WARNING_DAYS) staleJobs.push({ sessions, jobId: head._id.toString() });
    });

    if (staleJobs.length === 0) return;

    // ✅ ค้างแค่ใบเดียว — เจาะจงพาไปเปิด Dialog รายละเอียดใบนั้นเลย (?jobId= ตรงกับ deep-link ที่
    // QuotationTracking.js รองรับอยู่แล้ว จากกล่องแจ้งเตือนใน Dashboard) มากกว่า 1 ใบถึงค่อยพาไปหน้า
    // รวม (ซึ่ง default อยู่ที่แท็บ "รอลูกค้าตอบ" เรียงใบที่ต้องติดตามด่วนขึ้นก่อนอยู่แล้วเช่นกัน)
    const url = staleJobs.length === 1 ? `/quotations?jobId=${staleJobs[0].jobId}` : "/quotations";

    await sendPushToRoles(["admin", "manager"], {
      title: "📄 มีใบเสนอราคาที่ต้องติดตาม",
      body: `มี ${staleJobs.length} ใบเสนอราคาที่ไม่ได้ติดต่อลูกค้ามาเกิน ${QUOTATION_WARNING_DAYS} วันแล้ว กรุณาติดตามและบันทึกผล`,
      url,
      tag: "quotation-reminder",
      renotify: true,
    });

    // ✅ แจ้งผู้รับผิดชอบของแต่ละงานเป็นรายคนด้วย (เทียบ pattern เดียวกับ checkAndNotifyOverdueJobs)
    const allUsers = await User.find({}).select("fname role").lean();
    const userById = new Map(allUsers.map((u) => [u._id.toString(), u]));
    const userByFname = new Map(allUsers.map((u) => [u.fname, u]));

    const staleByTech = new Map();
    staleJobs.forEach(({ sessions, jobId }) => {
      const user = resolveResponsibleUser(sessions, userById, userByFname);
      if (!user || user.role !== "technician") return;
      const techId = user._id.toString();
      if (!staleByTech.has(techId)) staleByTech.set(techId, []);
      staleByTech.get(techId).push(jobId);
    });

    for (const [techId, jobIds] of staleByTech.entries()) {
      const techUrl = jobIds.length === 1 ? `/quotations?jobId=${jobIds[0]}` : "/quotations";
      await sendPushToUsers(techId, {
        title: "📄 มีใบเสนอราคาที่ต้องติดตาม",
        body: `มี ${jobIds.length} ใบเสนอราคาของงานที่คุณรับผิดชอบ ไม่ได้ติดต่อลูกค้ามาเกิน ${QUOTATION_WARNING_DAYS} วันแล้ว กรุณาติดตามและบันทึกผล`,
        url: techUrl,
        tag: "quotation-reminder",
        renotify: true,
      });
    }
  } catch (err) {
    console.error("❌ Quotation reminder check error:", err);
  }
}

// ✅ เตือนแอดมิน/manager แบบภาพรวม (เหมือนเดิม) และเตือน "ผู้รับผิดชอบ" ของแต่ละสัญญาเป็นรายคนด้วย
// (เพิ่มใหม่ — เทียบ pattern เดียวกับ checkAndNotifyOverdueJobs/checkAndNotifyStaleQuotations)
// ว่ามีสัญญาที่รอบล่าสุดผ่านมาเกินระยะห่างระหว่างรอบที่กำหนดไว้แล้ว แต่ยังไม่ได้ลงแผนงานครั้งถัดไปเลย —
// เดิมเห็นได้แค่จุดแดงในตาราง "ภาพรวมงาน" ตอนเปิดหน้าค้างไว้เท่านั้น ⚠️ ตรรกะต้องตรงกับ
// utils/contractOverdue.js (nextVisitOverdueInfo) ฝั่ง frontend เป๊ะๆ ไม่งั้นตัวเลขในแจ้งเตือนกับจุดแดง
// ในตารางจะไม่ตรงกัน — query ด้วย contractGroupId เฉยๆ (ไม่กรอง unscheduled) เพราะ countUsedRounds
// ฝั่งจอนับรวมแผนงานล่วงหน้าด้วย
async function checkAndNotifyOverdueContracts() {
  try {
    const events = await CalendarEvent.find({ contractGroupId: { $exists: true, $nin: [null, ""] } })
      .select("contractGroupId visitCount intervalMonths time start end allDay unscheduled resPerson team userId responsiblePersonId responsiblePerson")
      .lean();
    if (events.length === 0) return;

    const byContract = new Map();
    events.forEach((e) => {
      if (!byContract.has(e.contractGroupId)) byContract.set(e.contractGroupId, []);
      byContract.get(e.contractGroupId).push(e);
    });

    const overdueContracts = []; // { visits, monthsOverdue }
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
      // ⚠️ BUG ที่แก้: เดิมใช้ v.end ตรงๆ — แต่ end ของงาน allDay ถูกบวกไป 1 วันตอนบันทึกเสมอ (ค่า end
      // แบบ exclusive ของ FullCalendar) ทำให้ "รอบล่าสุด" ที่ใช้คำนวณเพี้ยนไปวันหนึ่งเสมอ ไม่ตรงกับ
      // nextVisitOverdueInfo ฝั่ง frontend ที่แก้จุดนี้ไปแล้วก่อนหน้านี้ — ต้องแก้ให้ตรงกันเป๊ะๆ ตามคอมเมนต์
      // ด้านบนของฟังก์ชัน ไม่งั้นตัวเลขในแจ้งเตือนจะไม่ตรงกับจุดแดงในตาราง "ภาพรวมงาน"
      const lastVisitDate = realVisits.reduce((latest, v) => {
        const d = v.end
          ? moment(v.end).subtract(v.allDay ? 1 : 0, "days")
          : moment(v.start);
        return !latest || d.isAfter(latest) ? d : latest;
      }, null);
      const dueDate = lastVisitDate.clone().add(Number(head.intervalMonths) || DEFAULT_INTERVAL_MONTHS, "months");
      if (dueDate.isAfter(moment())) return;
      overdueContracts.push({ visits: sorted, monthsOverdue: Math.max(1, moment().diff(dueDate, "months") + 1) });
    });
    if (overdueContracts.length === 0) return;

    // ✅ ?view=overdue — เปิดหน้า "ภาพรวมงาน" มาที่แท็บ "เลยกำหนด/คงค้าง" ให้เลยทันที (ดู viewFilter
    // ใน ContractOverview.js) แทนที่จะเปิดมาแท็บ "งานสัญญา/งานรายปี" เริ่มต้นแล้วต้องกดกรองเอง
    await sendPushToRoles(["admin", "manager"], {
      title: "📋 มีสัญญาที่ยังไม่ได้วางแผนรอบถัดไป",
      body: `มี ${overdueContracts.length} สัญญาที่เลยกำหนดรอบถัดไปแล้ว (นานสุด ${Math.max(...overdueContracts.map((c) => c.monthsOverdue))} เดือน) กรุณาตรวจสอบและลงแผนงานครั้งถัดไป`,
      url: "/contracts?view=overdue",
      tag: "contract-round-reminder",
      renotify: true,
    });

    // ✅ แจ้งผู้รับผิดชอบของแต่ละสัญญาเป็นรายคนด้วย (เทียบ pattern เดียวกับ checkAndNotifyOverdueJobs)
    const allUsers = await User.find({}).select("fname role").lean();
    const userById = new Map(allUsers.map((u) => [u._id.toString(), u]));
    const userByFname = new Map(allUsers.map((u) => [u.fname, u]));

    const overdueByTech = new Map();
    overdueContracts.forEach(({ visits }) => {
      const user = resolveResponsibleUser(visits, userById, userByFname);
      if (!user || user.role !== "technician") return;
      const techId = user._id.toString();
      overdueByTech.set(techId, (overdueByTech.get(techId) || 0) + 1);
    });

    for (const [techId, count] of overdueByTech.entries()) {
      await sendPushToUsers(techId, {
        title: "📋 มีสัญญาที่ยังไม่ได้วางแผนรอบถัดไป",
        body: `มี ${count} สัญญาที่คุณรับผิดชอบเลยกำหนดรอบถัดไปแล้ว กรุณาตรวจสอบและลงแผนงานครั้งถัดไป`,
        url: "/contracts?view=overdue",
        tag: "contract-round-reminder",
        renotify: true,
      });
    }
  } catch (err) {
    console.error("❌ Contract round reminder check error:", err);
  }
}

module.exports = { checkAndNotifyOverdueJobs, checkAndNotifyStaleQuotations, checkAndNotifyOverdueContracts };
