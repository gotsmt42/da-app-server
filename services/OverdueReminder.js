const moment = require("moment");
const CalendarEvent = require("../models/Events");
const User = require("../models/User");
const { sendPushToUsers } = require("./PushNotify");

// ✅ เกณฑ์เดียวกับฝั่ง frontend (Operation/index.js) — เลยกำหนดวันสิ้นสุดงานตามแผนจริงมาแล้ว
// อย่างน้อย 1 สัปดาห์ ถือว่า "ค้างงาน" ต้องแจ้งเตือน
const WARNING_DAYS_AFTER_END = 7;
const SEVERE_DAYS_AFTER_END = 14;

const getDaysPastDue = (event) => {
  const planEnd = event.end
    ? moment(event.end).subtract(event.allDay ? 1 : 0, "days")
    : moment(event.start);
  return moment().startOf("day").diff(planEnd.startOf("day"), "days");
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
      .select("resPerson userId team end start allDay")
      .lean();

    const overdueEvents = events
      .map((event) => ({ ...event, daysPastDue: getDaysPastDue(event) }))
      .filter((event) => event.daysPastDue >= WARNING_DAYS_AFTER_END);

    if (overdueEvents.length === 0) return;

    // ✅ หาเจ้าของงานจริงด้วยลำดับความสำคัญเดียวกับที่ backend ใช้ตัดสินว่า "งานนี้ของช่างคนไหน"
    // ใน GET /events/event-op (resPerson ตรงๆ → ชื่อทีมตรงกับ fname → คนที่สร้าง event เอง)
    // ข้อมูลจริงในระบบพบว่า resPerson แทบไม่ถูกตั้งเลย และหลายงานตั้ง team เป็นชื่อคนที่ลาออก/ไม่มี
    // บัญชีจริงแล้ว (ไม่ match กับ user คนไหนเลย) — กรณีนั้นไม่มีทางแจ้งเตือนใครได้ ข้ามไปเงียบๆ
    const allUsers = await User.find({}).select("fname role").lean();
    const userById = new Map(allUsers.map((u) => [u._id.toString(), u]));
    const userByFname = new Map(allUsers.map((u) => [u.fname, u]));

    const overdueByTech = new Map();
    overdueEvents.forEach((event) => {
      let user = null;
      if (event.resPerson) user = userById.get(event.resPerson.toString());
      if (!user && event.team && userByFname.has(event.team)) user = userByFname.get(event.team);
      if (!user && event.userId) user = userById.get(event.userId.toString());
      // ✅ แจ้งเฉพาะช่าง — ถ้าหาเจ้าของจริงไม่เจอ หรือดันไปตรงกับแอดมิน/manager (เช่น เป็นคนสร้าง
      // event เองแต่ไม่ได้เป็นคนทำ) ให้ข้าม ไม่ใช่เป้าหมายของการแจ้งเตือนนี้
      if (!user || user.role !== "technician") return;

      const techId = user._id.toString();
      if (!overdueByTech.has(techId)) overdueByTech.set(techId, []);
      overdueByTech.get(techId).push(event.daysPastDue);
    });

    for (const [techId, daysList] of overdueByTech.entries()) {
      const severeCount = daysList.filter((d) => d >= SEVERE_DAYS_AFTER_END).length;
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

module.exports = { checkAndNotifyOverdueJobs };
