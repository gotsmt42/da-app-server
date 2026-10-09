/**
 * ✅ (9 ต.ค. 2569 ผู้ใช้: "การแจ้งเตือนให้เห็นแค่ของตัวเองก็พอ") ก่อนแก้ ประกาศ "เพิ่มงานใหม่เข้าระบบ" ของงานช่าง
 * ถูกส่งถึงทุกคนรวมฝ่ายขาย — ล้างรายการเหล่านั้นออกจากกล่องแจ้งเตือนของฝ่ายขายครั้งเดียว
 * ⚠️ ทำครั้งเดียว (DocCounter key "migr:sales-inbox-v1") · ไม่แตะแจ้งเตือนอื่นของเซล
 */
const Notification = require("../models/Notification");
const User = require("../models/User");
const DocCounter = require("../models/DocCounter");
const { departmentOf, DEPARTMENT } = require("../config/roles");

const FLAG = "migr:sales-inbox-v1";

async function cleanupSalesInbox() {
  if (await DocCounter.findOne({ key: FLAG }).lean()) return 0;
  const users = await User.find({}).select("_id rank role").lean();
  const salesIds = users.filter((u) => departmentOf(u) === DEPARTMENT.SALES).map((u) => String(u._id));
  let n = 0;
  if (salesIds.length) {
    const res = await Notification.deleteMany({ userId: { $in: salesIds }, title: /เพิ่มงานใหม่เข้าระบบ/ });
    n = res.deletedCount || 0;
  }
  await DocCounter.create({ key: FLAG, seq: 1 });
  if (n) console.log(`🔕 ล้างแจ้งเตือนงานช่างออกจากกล่องของฝ่ายขาย ${n} รายการ`);
  return n;
}

module.exports = { cleanupSalesInbox };
