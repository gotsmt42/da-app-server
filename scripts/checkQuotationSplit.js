/**
 * checkQuotationSplit.js — ทดสอบ "ได้งานบางใบ → แยกใบที่เหลือไปติดตามต่อ" โดยไม่ต้องต่อฐานข้อมูล (model ปลอม)
 * รัน: node scripts/checkQuotationSplit.js
 * ✅ (10 พ.ย. 2569) ล็อกพฤติกรรม: ย้ายไฟล์ถูกใบ · ยอด/เลขที่ถูก · เลขไฟล์ AI นับใหม่ · ประวัติติดตามติดไป · งานเดิมชี้ไปใบใหม่
 */
const assert = require("node:assert/strict");
const { splitRemainingQuotes } = require("../src/services/quotationSplit");

const calls = { updateMany: [], updateOne: [], saved: [] };
const sessionFiles = [
  { _id: "F1", fileName: "QT69.pdf", fileUrl: "https://x/qt69.pdf" },
  { _id: "F2", fileName: "QT70.pdf", fileUrl: "https://x/qt70.pdf" },
  { _id: "F0", fileName: "old.pdf", fileUrl: "https://x/old.pdf", supersededAt: new Date("2026-01-01") },
];
class FakeModel {
  constructor(doc) { Object.assign(this, doc); this._id = "NEW1"; }
  async save() { calls.saved.push(this); return this; }
  static find() { return { select: () => ({ lean: async () => [{ quotationFiles: sessionFiles }] }) }; }
  static async updateMany(filter, update) { calls.updateMany.push({ filter, update }); }
  static async updateOne(filter, update) { calls.updateOne.push({ filter, update }); }
}

const anchor = {
  _id: "A1", jobGroupId: "G1", jobNo: "JOB-1", title: "Service", system: "Fire Alarm", company: "ดู ออล", site: "Site X",
  department: "service", userId: "U1", responsiblePerson: "ภูริต", responsiblePersonId: "U1",
  quotationSentAt: new Date("2026-10-01"), quotationRevision: 0, quotationVatIncluded: true,
  quotationFollowUps: [{ _id: "FU1", note: "โทรแล้ว", revision: 0 }, { _id: "FU0", note: "ฉบับเก่า", revision: -1 }],
  quotationAiFilled: { fields: ["quotationNo"], quotations: [
    { quotationNo: "QT69", grandTotal: 160500, files: [1] },
    { quotationNo: "QT70", grandTotal: 128400, files: [2] },
  ] },
};
const d = { approvedNos: ["QT69"], approvedAmount: 160500, split: { fileIds: ["F2"], nos: ["QT70"], amount: 128400 } };

(async () => {
  const doc = await splitRemainingQuotes(FakeModel, anchor, d, { actorName: "admin", userId: "U9", now: new Date("2026-11-10") });

  // 1) ไฟล์ของใบที่ไม่ได้งานถูกถอดจากทุกวันของงานเดิม
  const pull = calls.updateMany[0];
  assert.deepEqual(pull.filter, { jobGroupId: "G1" });
  assert.deepEqual(pull.update.$pull.quotationFiles._id.$in, ["F2"]);

  // 2) ใบใหม่ = ใบเสนอราคาแยก อิงงานเดิม · ไฟล์ F2 · สถานะรอลูกค้าตอบ (นับต่อจากเดิม) · ยอด/เลขที่ของใบที่เหลือ
  assert.equal(doc.quoteOnly, true);
  assert.equal(doc.quoteRef.kind, "event");
  assert.equal(doc.quoteRef.eventId, "A1");
  assert.equal(doc.quoteRef.jobGroupId, "G1");
  assert.deepEqual(doc.quotationFiles.map((f) => f._id), ["F2"]);
  assert.equal(doc.quotationStatus, "sent");
  assert.equal(+doc.quotationSentAt, +anchor.quotationSentAt);
  assert.equal(doc.quotationNo, "QT70");
  assert.equal(doc.quotationAmount, 128400);
  // ผลอ่าน AI ของใบที่เหลือ เลขไฟล์นับใหม่ (QT70 เคยเป็นไฟล์ที่ 2 → ในใบใหม่เป็นไฟล์ที่ 1)
  assert.deepEqual(doc.quotationAiFilled.quotations.map((q) => [q.quotationNo, q.files]), [["QT70", [1]]]);
  // ประวัติติดตามของฉบับปัจจุบันติดมาด้วย (ไม่เอาฉบับเก่า) · ไม่มี _id เดิม
  assert.deepEqual(doc.quotationFollowUps.map((f) => f.note), ["โทรแล้ว"]);
  assert.equal(doc.quotationFollowUps[0]._id, undefined);

  // 3) งานเดิม = เฉพาะใบที่ได้งาน
  const set = calls.updateMany[1].update.$set;
  assert.equal(set.quotationNo, "QT69");
  assert.equal(set.quotationAmount, 160500);
  assert.deepEqual(set.quotationApprovedNos, []);
  assert.deepEqual(set.quotationAiFilled.quotations.map((q) => [q.quotationNo, q.files]), [["QT69", [1]]]);
  // ชี้ไปใบใหม่ + บันทึกประวัติ
  assert.equal(calls.updateOne[0].update.$set.quotationSplitTo, "NEW1");
  assert.match(calls.updateOne[0].update.$push.activityLog.detail, /แยกไปติดตามต่อ/);

  console.log("✅ แยกใบเสนอราคาที่ยังไม่ได้งาน — ผ่านทุกข้อ");
})().catch((e) => { console.error("❌", e.message); process.exit(1); });
