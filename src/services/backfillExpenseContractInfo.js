/**
 * ✅ (9 ต.ค. 2569) ใบเบิก/เคลม/ค่าจ้างผู้รับเหมาที่ผูกงานสัญญาไว้ก่อนหน้า ยังไม่มีข้อมูลสัญญาติดใบ
 * → ป้ายขึ้นเป็น "ครั้งที่ 5/8" ไม่ระบุปีสัญญา · เติมข้อมูลสัญญาจากงานที่ผูกไว้ให้ครั้งเดียว
 * ⚠️ ทำครั้งเดียว (DocCounter key "migr:expense-contract-v1") · ไม่แตะชื่องาน/ยอดเงิน/ส่วนอื่นของใบ
 */
const Expense = require("../models/Expense");
const CalendarEvent = require("../models/Events");
const DocCounter = require("../models/DocCounter");

const FLAG = "migr:expense-contract-v1";

async function backfillExpenseContractInfo() {
  if (await DocCounter.findOne({ key: FLAG }).lean()) return 0;
  const rows = await Expense.find({ eventId: { $nin: [null, ""] }, "job.round": { $nin: [null, ""] } })
    .select("_id eventId").lean();
  const ids = [...new Set(rows.map((r) => String(r.eventId)).filter((x) => /^[a-f0-9]{24}$/i.test(x)))];
  const events = await CalendarEvent.find({ _id: { $in: ids } })
    .select("contractNo contractStart contractEnd contractYears intervalMonths").lean();
  const byId = new Map(events.map((e) => [String(e._id), e]));
  let n = 0;
  for (const r of rows) {
    const ev = byId.get(String(r.eventId));
    if (!ev || (!ev.contractStart && !ev.contractNo)) continue;
    await Expense.updateOne({ _id: r._id }, { $set: {
      "job.contractNo": ev.contractNo || "",
      "job.contractStart": ev.contractStart || null,
      "job.contractEnd": ev.contractEnd || null,
      "job.contractYears": Number(ev.contractYears) || null,
      "job.intervalMonths": Number(ev.intervalMonths) || null,
    } });
    n += 1;
  }
  await DocCounter.create({ key: FLAG, seq: 1 });
  if (n) console.log(`🧾 เติมข้อมูลสัญญาให้ใบเบิกเดิม ${n} ใบ`);
  return n;
}

module.exports = { backfillExpenseContractInfo };
