/**
 * quotationSplit — ได้งานบางใบ: แยกใบเสนอราคาที่ยังไม่ได้งานไปเป็น "ใบเสนอราคาแยก" ที่อิงงานเดิม (ติดตามต่อได้)
 * ✅ (10 พ.ย. 2569 ผู้ใช้: "บันทึกได้งาน ให้แยกตัดเฉพาะใบที่ติ๊ก ไม่ใช่ตัดรวมทั้งหมด แบบนี้จะติดตามใบที่เหลือไม่ได้
 *    ให้ตัดใบที่กดได้งาน และยอดนั้นๆ ไปได้งาน")
 *    • งานเดิม = เฉพาะใบที่ได้งาน (เลขที่ · ยอดรวมของใบที่ได้ · ผลอ่าน AI ของใบนั้น) + quotationSplitTo → ใบใหม่
 *    • ใบใหม่ = ไฟล์ของใบที่ยังไม่ได้ (ย้ายมาจากงานเดิม) · สถานะ "รอลูกค้าตอบ" นับวันต่อจากเดิม · ประวัติติดตามติดมาด้วย
 *    • เลขไฟล์ในผลอ่าน AI (เริ่ม 1 · รูป/PDF ฉบับปัจจุบัน ≤ 8 ไฟล์) นับใหม่ให้ตรงไฟล์ของแต่ละใบ
 * @param CalendarEvent  model (ส่งเข้ามา — ทดสอบได้โดยไม่ต้องต่อฐานข้อมูล ดู scripts/checkQuotationSplit.js)
 * @param d  { approvedNos, approvedAmount, split: { fileIds, nos, amount } }
 */
async function splitRemainingQuotes(CalendarEvent, anchor, d, { actorName, userId, now }) {
  const { isPdfFile, isImageFile } = require("./aiFileSource");
  const scannable = (files) => (files || []).filter((f) => f?.fileUrl && !f.supersededAt && (isPdfFile(f) || isImageFile(f))).slice(-8);
  const filter = anchor.jobGroupId ? { jobGroupId: anchor.jobGroupId } : { _id: anchor._id };
  const sessions = await CalendarEvent.find(filter).select("quotationFiles").lean();
  const before = sessions.flatMap((s) => s.quotationFiles || []).filter((f) => !f.supersededAt);
  const moveIds = new Set(d.split.fileIds.map(String));
  const moved = before.filter((f) => moveIds.has(String(f._id)));
  const kept = before.filter((f) => !moveIds.has(String(f._id)));
  if (moved.length) {
    await CalendarEvent.updateMany(filter, { $pull: { quotationFiles: { _id: { $in: moved.map((f) => f._id) } } } });
  }
  // ผลอ่าน AI → แบ่งใบ + นับเลขไฟล์ใหม่
  const ai = anchor.quotationAiFilled && typeof anchor.quotationAiFilled.toObject === "function" ? anchor.quotationAiFilled.toObject() : (anchor.quotationAiFilled || {});
  const oldList = scannable(before);
  const reindex = (q, list) => {
    const ids = list.map((f) => String(f._id));
    const files = (q.files || []).map((n) => oldList[n - 1]).filter(Boolean).map((f) => ids.indexOf(String(f._id)) + 1).filter((n) => n > 0);
    return { ...q, files };
  };
  const restNos = new Set(d.split.nos);
  const aiQuotes = Array.isArray(ai.quotations) ? ai.quotations : [];
  const restQuotes = aiQuotes.filter((q) => restNos.has(String(q.quotationNo || "").trim())).map((q) => reindex(q, scannable(moved)));
  const wonQuotes = aiQuotes.filter((q) => !restNos.has(String(q.quotationNo || "").trim())).map((q) => reindex(q, scannable(kept)));
  const wonTotal = wonQuotes.length && wonQuotes.every((q) => Number(q.grandTotal) > 0) ? Math.round(wonQuotes.reduce((t, q) => t + Number(q.grandTotal), 0) * 100) / 100 : null;
  const rev = Number(anchor.quotationRevision) || 0;
  const follow = (anchor.quotationFollowUps || []).filter((f) => (Number(f.revision) || 0) === rev).map((f) => {
    const o = typeof f.toObject === "function" ? f.toObject() : { ...f };
    delete o._id;
    return { ...o, revision: 0 };
  });
  const label = [anchor.jobNo, anchor.title, anchor.system].filter(Boolean).join(" · ") || "งาน";
  const restAmount = d.split.amount != null ? d.split.amount
    : restQuotes.length && restQuotes.every((q) => Number(q.grandTotal) > 0) ? Math.round(restQuotes.reduce((t, q) => t + Number(q.grandTotal), 0) * 100) / 100 : null;
  const doc = await new CalendarEvent({
    quoteOnly: true, unscheduled: true,
    quoteRef: { kind: "event", eventId: String(anchor._id), jobGroupId: anchor.jobGroupId ? String(anchor.jobGroupId) : null, label: label.slice(0, 120), start: anchor.start || null, splitFrom: true },
    department: anchor.department, company: anchor.company, site: anchor.site || anchor.company || "-",
    title: `${anchor.title || "ใบเสนอราคา"} · ใบที่ยังไม่ได้งาน`, system: anchor.system || "",
    start: now, end: now, allDay: true, backgroundColor: "#2563eb", textColor: "#ffffff", fontSize: 8,
    userId: anchor.userId, responsiblePerson: anchor.responsiblePerson, responsiblePersonId: anchor.responsiblePersonId,
    quotationApplicable: true, approvalStatus: "approved", status: "กำลังดำเนินการ",
    quotationFiles: moved,
    quotationStatus: "sent", quotationSentAt: anchor.quotationSentAt || now,
    quotationNo: d.split.nos.join(", "), quotationAmount: restAmount, quotationVatIncluded: anchor.quotationVatIncluded,
    quotationDate: anchor.quotationDate || null, quotationValidUntil: anchor.quotationValidUntil || null,
    quotationContact: anchor.quotationContact ? JSON.parse(JSON.stringify(anchor.quotationContact)) : undefined,
    quotationFollowUps: follow, quotationNextFollowUpAt: anchor.quotationNextFollowUpAt || null,
    quotationAiFilled: { ...ai, fields: [], quotations: restQuotes, fileCount: scannable(moved).length },
    activityLog: [{ userId: String(userId), userName: actorName, action: "quotation_split", timestamp: now,
      detail: `แยกจากงาน ${label} — ลูกค้าอนุมัติบางใบ ใบนี้ (${d.split.nos.join(", ") || `${moved.length} ไฟล์`}) ยังไม่ได้งาน ติดตามต่อ` }],
  }).save();
  // งานเดิม = เฉพาะใบที่ได้งาน
  const wonNos = d.approvedNos?.length ? d.approvedNos : [];
  const $set = {
    quotationApprovedNos: [],
    quotationAiFilled: { ...ai, quotations: wonQuotes, fileCount: scannable(kept).length },
    ...(wonNos.length ? { quotationNo: wonNos.join(", ") } : {}),
    ...(wonTotal != null ? { quotationAmount: wonTotal } : d.approvedAmount != null ? { quotationAmount: d.approvedAmount } : {}),
  };
  await CalendarEvent.updateMany(filter, { $set });
  await CalendarEvent.updateOne({ _id: anchor._id }, {
    $set: { quotationSplitTo: String(doc._id) },
    $push: { activityLog: { action: "quotation_split", userId: String(userId), userName: actorName, timestamp: now,
      detail: `ได้งานบางใบ — ใบที่ยังไม่ได้งาน (${d.split.nos.join(", ") || `${moved.length} ไฟล์`}) แยกไปติดตามต่อเป็นใบเสนอราคาแยก` } },
  });
  return doc;
}

module.exports = { splitRemainingQuotes };
