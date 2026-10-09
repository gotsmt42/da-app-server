const moment = require("moment");
const CalendarEvent = require("../models/Events");
const User = require("../models/User");
const { sendPushToUsers, sendPushToRoles } = require("./PushNotify");
const { SUPERVISOR_ROLES, DEPARTMENT, effectiveCapabilities, normalizeRank } = require("../config/roles");
const NotifyLog = require("../models/NotifyLog");
const { billingStatus } = require("../utils/billing");
const { DEFAULT_INTERVAL_MONTHS, totalRoundsOf, roundLabelOf } = require("../utils/contractVisits");

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
      // ⚠️ นับเฉพาะงานฝ่ายบริการ
      // 🐛 ที่แก้: นัดของเซลมีสถานะ "กำลังรอยืนยัน" เหมือนงานช่าง และไม่มีวันถูกกด "ปิดงาน"
      // (ไม่มีขั้นตอนนั้นในสายขาย) จึงถูกนับเป็น "งานค้าง" ตลอดกาลแล้วยิงเตือนหัวหน้าทุกวัน
      // ⚠️ ต้องรวม null/ไม่มีฟิลด์ด้วย — แผนงานเดิมทั้งระบบสร้างก่อนมีฟิลด์นี้
      department: { $in: [DEPARTMENT.SERVICE, null] },
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

    const allUsers = await User.find({}).select("fname rank role").lean();
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

      // ⚠️ กันแจ้งซ้ำในวันเดียวกัน — ตัวเช็คนี้ถูกยิงใหม่ทุกครั้งที่เซิร์ฟเวอร์รีสตาร์ท/deploy
      // (ดูเหตุผลเต็มที่ models/NotifyLog.js) ถ้าไม่กันไว้ วัน deploy หลายรอบผู้ใช้จะโดนเรื่องเดิมซ้ำทั้งวัน
      if (!(await NotifyLog.claimOncePerDay("overdue-jobs", "self", techId))) continue;
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
    // ✅ เก็บตกงานที่แนบใบเสนอราคา + ส่งงานแล้วแต่ยังไม่เริ่มนับ (เช่น ปิดงานผ่านช่องทางอื่น) ก่อนเช็คเกินกำหนด
    await require("./quotationAutoStart").syncQuotationStartSafe();
    // ⚠️ ต้อง select quotationFollowUps มาด้วย ไม่งั้นคำนวณ "ติดต่อครั้งล่าสุด" ไม่ได้ (เดิมไม่ได้ดึงมา)
    const events = await CalendarEvent.find({ quotationStatus: "sent" })
      .select("company site title system team time jobGroupId quotationSentAt quotationFollowUps quotationNextFollowUpAt resPerson userId responsiblePersonId responsiblePerson")
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
      // ✅ นัดติดตามครั้งถัดไป (ถ้าตั้งไว้และอยู่หลังการติดต่อล่าสุด) แทนเกณฑ์ 7 วัน — ตรงกับหน้าจอ
      const next = head.quotationNextFollowUpAt ? moment(head.quotationNextFollowUpAt) : null;
      const dueAt = next && next.isValid() && next.isAfter(lastContact)
        ? next.clone().startOf("day")
        : lastContact.clone().startOf("day").add(QUOTATION_WARNING_DAYS, "days");
      if (moment().startOf("day").isAfter(dueAt)) staleJobs.push({ sessions, jobId: head._id.toString() });
    });

    if (staleJobs.length === 0) return;

    // ✅ ค้างแค่ใบเดียว — เจาะจงพาไปเปิด Dialog รายละเอียดใบนั้นเลย (?jobId= ตรงกับ deep-link ที่
    // QuotationTracking.js รองรับอยู่แล้ว จากกล่องแจ้งเตือนใน Dashboard) มากกว่า 1 ใบถึงค่อยพาไปหน้า
    // รวม (ซึ่ง default อยู่ที่แท็บ "รอลูกค้าตอบ" เรียงใบที่ต้องติดตามด่วนขึ้นก่อนอยู่แล้วเช่นกัน)
    const url = staleJobs.length === 1 ? `/quotations?jobId=${staleJobs[0].jobId}` : "/quotations";

    // ⚠️ กันแจ้งซ้ำในวันเดียวกัน (ดู models/NotifyLog.js) — ผู้รับเป็นกลุ่ม role จึงใช้ชื่อกลุ่มเป็นคีย์
    if (await NotifyLog.claimOncePerDay("stale-quotations", "broadcast", "admin+manager")) {
    await sendPushToRoles(SUPERVISOR_ROLES, {
      title: "📄 มีใบเสนอราคาที่ต้องติดตาม",
      body: `มี ${staleJobs.length} ใบเสนอราคาที่ไม่ได้ติดต่อลูกค้ามาเกิน ${QUOTATION_WARNING_DAYS} วันแล้ว กรุณาติดตามและบันทึกผล`,
      url,
      tag: "quotation-reminder",
      renotify: true,
    });
    }

    // ✅ แจ้งผู้รับผิดชอบของแต่ละงานเป็นรายคนด้วย (เทียบ pattern เดียวกับ checkAndNotifyOverdueJobs)
    const allUsers = await User.find({}).select("fname rank role").lean();
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
      if (!(await NotifyLog.claimOncePerDay("stale-quotations", "self", techId))) continue;
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
  /**
   * ✅ (8 ต.ค. 2569 ผู้ใช้เลือก) แจ้งเตือนรอบเข้างาน 3 ระดับ — เกณฑ์ "ระดับเดือน" ตรงกับ nextVisitOverdueInfo ฝั่งแอป
   *   🗓️ ใกล้ถึงรอบ  (รอบตกเดือนหน้า)     → เดือนละครั้ง · ให้นัดลูกค้าล่วงหน้า
   *   🔔 ถึงรอบแล้ว   (รอบตกเดือนนี้)      → เดือนละครั้ง
   *   ⛔ เลยกำหนด     (รอบเลยเดือนมาแล้ว)   → วันละครั้ง จนกว่าจะลงแผนงาน
   * ผู้รับ: ผู้รับผิดชอบสัญญา (เฉพาะสัญญาของตัวเอง) + ตำแหน่งที่มีสิทธิ์ "จัดคิวคำขอลงงาน" (สรุปทุกสัญญา)
   * ⚠️ ไม่เตือนสัญญาที่ครบจำนวนครั้งแล้ว / ยังไม่เคยลงตารางจริงสักครั้ง / ลงแผนงานล่วงหน้าครั้งถัดไปไว้แล้ว
   */
  try {
    const events = await CalendarEvent.find({ contractGroupId: { $exists: true, $nin: [null, ""] } })
      .select("contractGroupId site company contractNo visitCount intervalMonths contractYears contractStart contractEnd time start end allDay unscheduled resPerson team userId responsiblePersonId responsiblePerson")
      .lean();
    if (events.length === 0) return;

    const byContract = new Map();
    events.forEach((e) => {
      if (!byContract.has(e.contractGroupId)) byContract.set(e.contractGroupId, []);
      byContract.get(e.contractGroupId).push(e);
    });

    const thisMonth = moment().utcOffset(7 * 60).startOf("month");
    const found = { soon: [], now: [], overdue: [] }; // { visits, site, round, dueMonth, monthsOverdue }
    byContract.forEach((visits) => {
      const sorted = visits.slice().sort((a, b) => (Number(a.time) || 0) - (Number(b.time) || 0));
      const head = sorted[0];
      const visitCount = totalRoundsOf(head);
      if (!visitCount) return;
      const usedRounds = new Set(
        sorted.map((v) => v.time).filter((t) => t !== undefined && t !== null && t !== "").map(String)
      );
      if (usedRounds.size >= visitCount) return;
      // สัญญาที่หมดอายุไปแล้วไม่เตือนรอบ (มีแจ้งเตือนต่อสัญญาแยกอยู่แล้ว)
      if (head.contractEnd && moment(head.contractEnd).isBefore(thisMonth)) return;
      const realVisits = sorted.filter((v) => !v.unscheduled);
      if (realVisits.length === 0) return;
      const lastVisitDate = realVisits.reduce((latest, v) => {
        const d = v.end ? moment(v.end).subtract(v.allDay ? 1 : 0, "days") : moment(v.start);
        return !latest || d.isAfter(latest) ? d : latest;
      }, null);
      const dueDate = lastVisitDate.clone().add(Number(head.intervalMonths) || DEFAULT_INTERVAL_MONTHS, "months");
      const monthsUntilDue = dueDate.clone().utcOffset(7 * 60).startOf("month").diff(thisMonth, "months");
      if (monthsUntilDue > 1) return;
      let nextRound = 1;
      while (usedRounds.has(String(nextRound))) nextRound += 1;
      const item = {
        visits: sorted,
        site: head.site || head.company || head.contractNo || "สัญญา",
        round: roundLabelOf(nextRound, head),
        dueMonth: dueDate.clone().utcOffset(7 * 60),
        monthsOverdue: Math.max(0, -monthsUntilDue),
      };
      if (monthsUntilDue === 1) found.soon.push(item);
      else if (monthsUntilDue === 0) found.now.push(item);
      else found.overdue.push(item);
    });

    const monthTH = (m) => `${["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."][m.month()]} ${String(m.year() + 543).slice(-2)}`;
    const listOf = (items) => {
      const names = items.slice(0, 3).map((x) => `${x.site} (${x.round})`);
      return names.join(", ") + (items.length > 3 ? ` และอีก ${items.length - 3} สัญญา` : "");
    };
    const LEVELS = [
      {
        key: "soon", items: found.soon, once: "month", url: "/contracts",
        title: (n) => `🗓️ เดือนหน้าถึงรอบเข้างาน ${n} สัญญา`,
        body: (items) => `นัดลูกค้าล่วงหน้า: ${listOf(items)}`,
      },
      {
        key: "now", items: found.now, once: "month", url: "/contracts?view=overdue",
        title: (n) => `🔔 เดือนนี้ถึงรอบเข้างาน ${n} สัญญา`,
        body: (items) => `ยังไม่ได้ลงแผนงาน: ${listOf(items)}`,
      },
      {
        key: "overdue", items: found.overdue, once: "day", url: "/contracts?view=overdue",
        title: (n) => `⛔ เลยกำหนดรอบเข้างาน ${n} สัญญา`,
        body: (items) => `นานสุด ${Math.max(...items.map((x) => x.monthsOverdue))} เดือน — ${listOf(items)} · กรุณาลงแผนงานครั้งถัดไป`,
      },
    ];

    const claim = (once, kind, subject, recipient) => (once === "month"
      ? NotifyLog.claimOncePerMonth(kind, subject, recipient)
      : NotifyLog.claimOncePerDay(kind, subject, recipient));

    // ── ผู้จัดคิว (ตำแหน่งที่มีสิทธิ์ assignDispatch) — สรุปทุกสัญญา ──
    const dispatchRanks = effectiveCapabilities().assignDispatch || SUPERVISOR_ROLES;
    for (const lv of LEVELS) {
      if (!lv.items.length) continue;
      if (!(await claim(lv.once, `contract-round-${lv.key}`, "broadcast", "dispatchers"))) continue;
      await sendPushToRoles(dispatchRanks, {
        title: lv.title(lv.items.length), body: lv.body(lv.items), url: lv.url,
        tag: `contract-round-${lv.key}`, renotify: true,
      });
    }

    // ── ผู้รับผิดชอบสัญญา — เฉพาะสัญญาของตัวเอง (ทุกตำแหน่ง) ──
    const allUsers = await User.find({}).select("fname rank role").lean();
    const userById = new Map(allUsers.map((u) => [u._id.toString(), u]));
    const userByFname = new Map(allUsers.map((u) => [u.fname, u]));
    for (const lv of LEVELS) {
      const mine = new Map();
      lv.items.forEach((it) => {
        const user = resolveResponsibleUser(it.visits, userById, userByFname);
        if (!user) return;
        // ผู้จัดคิวได้สรุปทุกสัญญาไปแล้ว — ไม่ส่งซ้ำอีกฉบับ
        if (dispatchRanks.includes(normalizeRank(user))) return;
        const id = user._id.toString();
        if (!mine.has(id)) mine.set(id, []);
        mine.get(id).push(it);
      });
      for (const [uid, items] of mine.entries()) {
        if (!(await claim(lv.once, `contract-round-${lv.key}`, "self", uid))) continue;
        await sendPushToUsers(uid, {
          title: lv.title(items.length).replace("สัญญา", "สัญญาที่คุณรับผิดชอบ"),
          body: lv.body(items), url: lv.url,
          tag: `contract-round-${lv.key}`, renotify: true,
        });
      }
    }
    if (found.soon.length || found.now.length || found.overdue.length) {
      console.log(`📋 รอบเข้างาน: ใกล้ถึง ${found.soon.length} · เดือนนี้ ${found.now.length} · เลยกำหนด ${found.overdue.length} (${monthTH(thisMonth)})`);
    }
  } catch (err) {
    console.error("❌ Contract round reminder check error:", err);
  }
}

// ✅ เช็คสัญญาที่ "ใกล้หมดอายุ / หมดอายุแล้ว" แล้วแจ้งเตือนล่วงหน้า
// ⚠️ ต่างจาก checkAndNotifyOverdueContracts ด้านบนคนละเรื่องกันโดยสิ้นเชิง: ตัวนั้นดู "รอบเข้างานถัดไป"
// (ยังอยู่ในสัญญา แค่ยังไม่ลงแผน) ส่วนตัวนี้ดู "วันสิ้นสุดสัญญา" ซึ่งถ้าปล่อยผ่านคือรายได้ต่อเนื่อง
// หายไปทั้งก้อน — เดิมเห็นได้ทางเดียวคือเปิดหน้าภาพรวมงานมาดูเองเท่านั้น ระบบไม่เคยส่งเสียงเลย
//
// ⚠️ เกณฑ์ต้องตรงกับ contractStatusInfo ใน ContractOverview.js เป๊ะๆ (หมดอายุ = เลยวันสิ้นสุดมาแล้ว,
// ใกล้หมดอายุ = เหลือ ≤ 60 วัน) ไม่งั้นตัวเลขในแจ้งเตือนกับที่เห็นในตารางจะไม่ตรงกัน
const EXPIRY_WARN_DAYS = 60;

async function checkAndNotifyExpiringContracts() {
  try {
    const events = await CalendarEvent.find({
      contractGroupId: { $exists: true, $nin: [null, ""] },
      contractEnd: { $exists: true, $ne: null },
    })
      .select("contractGroupId contractNo company site contractEnd resPerson team userId responsiblePersonId responsiblePerson")
      .lean();
    if (events.length === 0) return;

    // ⚠️ ต้องยุบเป็น "รายสัญญา" ก่อนเสมอ — ทุกครั้งในสัญญาถือ contractEnd ชุดเดียวกัน ถ้านับจาก
    // document ดิบ สัญญาที่มี 4 ครั้งจะถูกนับเป็น 4 สัญญาทันที ตัวเลขในแจ้งเตือนจะเกินจริงหลายเท่า
    const byContract = new Map();
    events.forEach((e) => {
      if (!byContract.has(e.contractGroupId)) byContract.set(e.contractGroupId, []);
      byContract.get(e.contractGroupId).push(e);
    });

    const today = moment().startOf("day");
    const expired = [];  // เลยวันสิ้นสุดมาแล้ว
    const expiring = []; // เหลือ ≤ 60 วัน
    byContract.forEach((visits) => {
      const head = visits[0];
      const end = moment(head.contractEnd).startOf("day");
      if (!end.isValid()) return;
      const daysLeft = end.diff(today, "days");
      if (daysLeft < 0) expired.push({ visits, daysLeft });
      else if (daysLeft <= EXPIRY_WARN_DAYS) expiring.push({ visits, daysLeft });
    });
    if (expired.length === 0 && expiring.length === 0) return;

    // ── แจ้งแอดมิน/manager ภาพรวม ────────────────────────────────────────
    // ⚠️ รวมเป็นข้อความเดียว ไม่แยกส่ง 2 ก้อน — คนกลุ่มนี้รับแจ้งเตือนจากทุกระบบอยู่แล้ว การยิงเพิ่ม
    // เป็น 2 เรื่องต่อวันเรื่องเดียวกันคือทางที่ทำให้คนเริ่มปิดแจ้งเตือนทิ้ง
    if (await NotifyLog.claimOncePerDay("expiring-contracts", "broadcast", "admin+manager")) {
      const parts = [];
      if (expired.length > 0) parts.push(`หมดอายุแล้ว ${expired.length} สัญญา`);
      if (expiring.length > 0) {
        const soonest = Math.min(...expiring.map((c) => c.daysLeft));
        parts.push(`ใกล้หมดอายุ ${expiring.length} สัญญา (เร็วสุดอีก ${soonest} วัน)`);
      }
      await sendPushToRoles(SUPERVISOR_ROLES, {
        title: "📄 มีสัญญาที่ต้องต่ออายุ",
        body: `${parts.join(" · ")} กรุณาตรวจสอบและติดต่อลูกค้าเพื่อต่อสัญญา`,
        // ✅ เปิดมาที่แท็บ "สัญญาหมดอายุ" ให้เลย (ดู VIEW_FILTER_VALUES ใน ContractOverview.js)
        url: "/contracts?view=expired",
        tag: "contract-expiry-reminder",
        renotify: true,
      });
    }

    // ── แจ้งผู้รับผิดชอบรายคน ────────────────────────────────────────────
    const allUsers = await User.find({}).select("fname rank role").lean();
    const userById = new Map(allUsers.map((u) => [u._id.toString(), u]));
    const userByFname = new Map(allUsers.map((u) => [u.fname, u]));

    const byTech = new Map(); // techId -> { expired, expiring }
    [...expired, ...expiring].forEach(({ visits, daysLeft }) => {
      const user = resolveResponsibleUser(visits, userById, userByFname);
      if (!user || user.role !== "technician") return;
      const techId = user._id.toString();
      const cur = byTech.get(techId) || { expired: 0, expiring: 0 };
      if (daysLeft < 0) cur.expired += 1; else cur.expiring += 1;
      byTech.set(techId, cur);
    });

    for (const [techId, counts] of byTech.entries()) {
      if (!(await NotifyLog.claimOncePerDay("expiring-contracts", "self", techId))) continue;
      const parts = [];
      if (counts.expired > 0) parts.push(`หมดอายุแล้ว ${counts.expired} สัญญา`);
      if (counts.expiring > 0) parts.push(`ใกล้หมดอายุ ${counts.expiring} สัญญา`);
      await sendPushToUsers(techId, {
        title: "📄 มีสัญญาที่ต้องต่ออายุ",
        body: `สัญญาที่คุณรับผิดชอบ ${parts.join(" · ")} กรุณาแจ้งผู้เกี่ยวข้อง`,
        url: "/contracts?view=expired",
        tag: "contract-expiry-reminder",
        renotify: true,
      });
    }
  } catch (err) {
    console.error("❌ Contract expiry reminder check error:", err);
  }
}

// ✅ เช็คใบวางบิลที่ "เลยกำหนดชำระแล้วแต่ยังรับเงินไม่ครบ" แล้วแจ้งแอดมิน/manager
// ⚠️ เกณฑ์ต้องใช้ billingStatus ตัวเดียวกับที่หน้าจอใช้ (utils/billing.js) ห้ามเขียนเงื่อนไขซ้ำที่นี่
// ไม่งั้นตัวเลขในแจ้งเตือนกับที่เห็นบนจอจะไม่ตรงกัน ซึ่งเป็นเรื่องเงิน ผู้ใช้จับได้ทันที
// ⚠️ query กรองที่ฐานข้อมูลด้วย billing.dueAt ก่อน (มี index รองรับ) แล้วค่อยกรองละเอียดใน memory —
// งานส่วนใหญ่ยังไม่ได้วางบิลเลย ถ้าดึงทั้งคอลเลกชันมากรองเองจะหนักขึ้นเรื่อยๆ ตามข้อมูลที่โต
async function checkAndNotifyOverdueInvoices() {
  try {
    const now = new Date();
    const events = await CalendarEvent.find({ "billing.dueAt": { $ne: null, $lt: now } })
      .select("company site title time billing")
      .lean();
    if (events.length === 0) return;

    const overdue = events
      .map((e) => ({ e, st: billingStatus(e.billing, now) }))
      .filter(({ st }) => st.state === "overdue");
    if (overdue.length === 0) return;

    const totalOutstanding = overdue.reduce((sum, { st }) => sum + Math.max(0, st.outstanding), 0);
    const worst = overdue.reduce((a, b) => (b.st.overdueDays > a.st.overdueDays ? b : a));

    if (await NotifyLog.claimOncePerDay("overdue-invoices", "broadcast", "admin+manager")) {
      await sendPushToRoles(SUPERVISOR_ROLES, {
        title: "💰 มีใบวางบิลเลยกำหนดชำระ",
        body: `ค้างรับ ${overdue.length} ใบ รวม ${Math.round(totalOutstanding).toLocaleString("th-TH")} บาท (นานสุด ${worst.st.overdueDays} วัน · ${worst.e.company || "ไม่ระบุลูกค้า"})`,
        // ⚠️ ใช้ชื่อ status ไม่ใช่ tab — ฝั่งหน้าเว็บ /billing เป็นลิงก์เก่าที่พาไปหน้ารวมการเงิน
        // ซึ่งใช้ tab เลือกแท็บของตัวเองอยู่แล้ว ถ้าส่ง tab มาด้วยจะแย่งกันจนเปิดผิดแท็บ
        // (ดู LegacyTabRedirect ใน da-app/src/app/router/index.js และตัวรับค่าใน BillingTracking.js)
        url: "/billing?status=overdue",
        tag: "invoice-overdue-reminder",
        renotify: true,
      });
    }
  } catch (err) {
    console.error("❌ Overdue invoice reminder check error:", err);
  }
}

/**
 * ✅ (9 ต.ค. 2569) ขั้นตอนทำงานมาตรฐาน ขั้น 4 — งานพรุ่งนี้ที่ช่างยังไม่กด "รับทราบงาน"
 *   ช่างที่ได้รับมอบหมาย: เตือนให้กดรับทราบงาน · ผู้จัดคิว (assignDispatch): สรุปว่างานไหนยังไม่มีใครรับ
 */
async function checkAndNotifyUnackedJobs() {
  try {
    const tz = 7 * 60;
    const from = moment().utcOffset(tz).add(1, "day").startOf("day").toDate();
    const to = moment().utcOffset(tz).add(2, "day").startOf("day").toDate();
    const events = await CalendarEvent.find({
      department: { $ne: DEPARTMENT.SALES },
      unscheduled: { $ne: true },
      approvalStatus: { $ne: "pending" },
      status: { $nin: ["ดำเนินการเสร็จสิ้น"] },
      start: { $gte: from, $lt: to },
      resPerson: { $nin: [null, ""] },
      "acks.0": { $exists: false },
      createdAt: { $gte: require("../routes/calendarEvent/jobflow").ACK_TRACK_SINCE },
    }).select("_id title site company jobNo resPerson jobGroupId").lean();
    if (!events.length) return;

    const seen = new Set();
    const jobs = events.filter((e) => {
      const k = e.jobGroupId || String(e._id);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    const label = (e) => `${e.title || "งาน"} · ${e.site || e.company || "-"}`;

    for (const e of jobs) {
      const uid = String(e.resPerson);
      if (!(await NotifyLog.claimOncePerDay("unacked-job", String(e.jobGroupId || e._id), uid))) continue;
      await sendPushToUsers(uid, {
        title: "📋 พรุ่งนี้มีงาน — กด “รับทราบงาน” ด้วย",
        body: `${label(e)}${e.jobNo ? ` (${e.jobNo})` : ""}`,
        url: `/operation/${e._id}`,
        tag: `unacked-${e.jobGroupId || e._id}`,
      });
    }

    const dispatchRanks = effectiveCapabilities().assignDispatch || SUPERVISOR_ROLES;
    if (await NotifyLog.claimOncePerDay("unacked-jobs", "broadcast", "dispatchers")) {
      const names = jobs.slice(0, 3).map(label).join(", ") + (jobs.length > 3 ? ` และอีก ${jobs.length - 3} งาน` : "");
      await sendPushToRoles(dispatchRanks, {
        title: `⏳ งานพรุ่งนี้ ${jobs.length} งาน ช่างยังไม่กดรับทราบงาน`,
        body: names,
        url: "/operation",
        tag: "unacked-jobs",
      });
    }
  } catch (err) {
    console.error("❌ checkAndNotifyUnackedJobs:", err.message);
  }
}

module.exports = {
  checkAndNotifyUnackedJobs,
  checkAndNotifyOverdueJobs,
  checkAndNotifyStaleQuotations,
  checkAndNotifyOverdueContracts,
  checkAndNotifyExpiringContracts,
  checkAndNotifyOverdueInvoices,
};
