/**
 * QuotationScan.js — อ่านข้อมูลจากไฟล์ใบเสนอราคา (รูป/PDF) ด้วย Claude
 *
 * ✅ (19 ต.ค. 2569 ผู้ใช้: "อยากให้วิเคราะห์ข้อมูลในภาพหรือไฟล์อัตโนมัติเลยว่าราคารวมเท่าไรที่แนบ")
 *    อ่าน เลขที่ · วันที่ · ยืนราคาถึง · ยอดก่อน VAT · VAT · ยอดรวม · ผู้ติดต่อ แล้วเติมให้อัตโนมัติ (ผู้ใช้เลือก)
 *
 * 🔁 (19 ต.ค. 2569 ผู้ใช้: "ราคาไม่ตรงมั่ว · เลขที่ด้วย · ให้ดูว่ามีกี่ใบกี่ไฟล์ด้วย ให้สมบูรณ์")
 *    • อ่าน "ทุกไฟล์ของงานพร้อมกัน" — ภาพหน้าจอใบเดียวมักแยกหลายไฟล์ (หัวกระดาษไฟล์หนึ่ง ยอดรวมอีกไฟล์) และงานหนึ่งอาจมีหลายใบ
 *    • AI ต้องแยกเป็นรายใบ บอกว่าแต่ละใบอยู่ไฟล์ไหน · ยอดรวมต้อง "พิมพ์อยู่บนเอกสารจริง" ห้ามบวกเอง/เดาจากตัวเลขที่ถูกตัด
 *    • เซิร์ฟเวอร์ตรวจซ้ำ: ยอดก่อน VAT + VAT ต้องเท่ายอดรวม ไม่งั้นไม่เติมมูลค่า
 *    • รูปยาวถูกตัดเป็นช่วงให้ตัวหนังสือใหญ่พอ (aiFileSource.toContentBlocks)
 *    • อ่านใหม่ทับได้เฉพาะช่องที่ AI เติมไว้เอง (ยังไม่มีคนแก้) — ช่องที่คนกรอกไม่แตะ
 * ⚠️ ไม่มี ANTHROPIC_API_KEY = ปิดฟีเจอร์ ระบบอื่นทำงานปกติ
 */
const Anthropic = require("@anthropic-ai/sdk");
const { MODEL, isEnabled } = require("./InvoiceScan");
const { toContentBlocks, createMessage, isPdfFile, isImageFile } = require("./aiFileSource");

let client = null;
const getClient = () => {
  if (!client) client = new Anthropic.Anthropic();
  return client;
};

const MAX_FILES = 8;

const EXTRACT_TOOL = {
  name: "record_quotations",
  description: "บันทึกใบเสนอราคาทุกใบที่พบในไฟล์ทั้งหมด (แยกรายใบ)",
  input_schema: {
    type: "object",
    properties: {
      quotations: {
        type: "array",
        description: "ใบเสนอราคาแต่ละใบที่พบ (เลขที่ต่างกัน = คนละใบ · ไฟล์หลายไฟล์ที่เป็นใบเดียวกันให้รวมเป็นรายการเดียว)",
        items: {
          type: "object",
          properties: {
            quotationNo: { type: "string", description: "เลขที่ใบเสนอราคา คัดลอกตรงตามเอกสารทุกตัวอักษร ไม่พบให้ใส่ค่าว่าง" },
            files: { type: "array", items: { type: "integer" }, description: "หมายเลขไฟล์ (เริ่ม 1) ที่เป็นส่วนของใบนี้" },
            quotationDate: { type: "string", description: "วันที่ใบเสนอราคา YYYY-MM-DD (แปลง พ.ศ. เป็น ค.ศ.) ไม่พบให้ใส่ค่าว่าง" },
            validUntil: { type: "string", description: "ยืนราคาถึง YYYY-MM-DD (ระบุเป็นจำนวนวันให้คำนวณจากวันที่ใบ) ไม่พบให้ใส่ค่าว่าง" },
            totalVisible: { type: "boolean", description: "บรรทัดยอดรวมสุทธิท้ายใบ (รวม VAT) มองเห็นครบทุกหลักในไฟล์หรือไม่" },
            totalText: { type: "string", description: "คัดลอกป้ายและตัวเลขยอดรวมสุทธิตามที่พิมพ์ เช่น 'จำนวนเงินรวมทั้งสิ้น 21,186.00' ไม่เห็นให้ใส่ค่าว่าง" },
            amountBeforeVat: { type: "number", description: "ยอดหลังหักส่วนลด ก่อนบวก VAT ตามที่พิมพ์ ไม่เห็นให้ใส่ 0" },
            vatAmount: { type: "number", description: "จำนวนเงิน VAT ตามที่พิมพ์ ไม่มี/ไม่เห็นให้ใส่ 0" },
            grandTotal: { type: "number", description: "ยอดรวมสุทธิตามที่พิมพ์ (รวม VAT) ทศนิยม 2 ตำแหน่ง · ไม่เห็นครบให้ใส่ 0" },
            contactName: { type: "string", description: "ชื่อผู้ติดต่อฝั่งลูกค้า (ถึง/เรียน/Attn) ไม่พบให้ใส่ค่าว่าง" },
            contactPhone: { type: "string", description: "เบอร์โทรฝั่งลูกค้า ไม่พบให้ใส่ค่าว่าง" },
            contactEmail: { type: "string", description: "อีเมลฝั่งลูกค้า ไม่พบให้ใส่ค่าว่าง" },
          },
          required: ["quotationNo", "files", "quotationDate", "validUntil", "totalVisible", "totalText", "amountBeforeVat", "vatAmount", "grandTotal", "contactName", "contactPhone", "contactEmail"],
        },
      },
      otherFiles: { type: "array", items: { type: "integer" }, description: "หมายเลขไฟล์ที่ไม่ใช่ใบเสนอราคา/อ่านไม่ออก" },
      confidence: { type: "string", enum: ["high", "medium", "low"], description: "ความมั่นใจโดยรวม" },
      note: { type: "string", description: "สิ่งที่ควรให้คนตรวจซ้ำ (ภาษาไทยสั้นๆ) เช่น ยอดรวมถูกตัด ตัวเลขเบลอ" },
    },
    required: ["quotations", "otherFiles", "confidence", "note"],
  },
};

const SYSTEM = `คุณคือผู้ช่วยฝ่ายขายของบริษัทรับเหมางานระบบในประเทศไทย
จะได้รับไฟล์ใบเสนอราคาหลายไฟล์ของงานเดียวกัน (มีป้าย "ไฟล์ที่ N" กำกับ · รูปยาวอาจถูกตัดเป็นหลายช่วงต่อกันจากบนลงล่าง)
ให้แยกว่ามีใบเสนอราคากี่ใบ แล้วบันทึกผ่านเครื่องมือ record_quotations

กติกาที่ห้ามพลาด:
- ใบเดียวกันอาจถูกถ่าย/แคปแยกหลายไฟล์ (ส่วนหัวไฟล์หนึ่ง ส่วนยอดรวมอีกไฟล์) ให้รวมเป็นใบเดียว ดูจากเลขที่ ชื่องาน รายการสินค้าที่ต่อเนื่อง
- เลขที่ใบเสนอราคาต้องคัดลอกตรงตามที่พิมพ์ทุกตัว ห้ามเดาตัวที่มองไม่ชัด (ใส่ค่าว่างแล้วบอกใน note)
- ยอดเงินต้องเป็นตัวเลข "ที่พิมพ์อยู่บนเอกสาร" เท่านั้น ห้ามคำนวณจากรายการสินค้าเอง ห้ามเดาจากตัวเลขที่ถูกตัดขอบ
  ถ้าบรรทัดยอดรวมไม่อยู่ในไฟล์ใดเลยหรือถูกตัด ให้ totalVisible = false และ grandTotal = 0
- grandTotal = ยอดสุทธิที่ลูกค้าต้องจ่าย (รวม VAT) · amountBeforeVat = หลังหักส่วนลดแต่ก่อน VAT · ส่วนลดไม่ใช่ยอดรวม
- ผู้ติดต่อคือฝั่ง "ลูกค้า" ไม่ใช่ผู้ขาย/ผู้เสนอราคา/บริษัทผู้ออกเอกสาร
- ปี พ.ศ. ต้องลบ 543 ให้เป็น ค.ศ.`;

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const money = (n) => Number(n || 0).toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const scannableFiles = (files) => (files || []).filter((f) => f?.fileUrl && (isPdfFile(f) || isImageFile(f))).slice(-MAX_FILES);

/** ตรวจผลจาก AI ซ้ำฝั่งเซิร์ฟเวอร์ — ยอดที่ไม่เห็นครบ/บวกแล้วไม่ตรง = ไม่ใช้ยอด */
function verifyQuote(q) {
  const before = r2(q.amountBeforeVat);
  const vat = r2(q.vatAmount);
  let total = q.totalVisible ? r2(q.grandTotal) : 0;
  const issues = [];
  if (!q.totalVisible) issues.push("ไม่เห็นบรรทัดยอดรวมครบ");
  const printed = Number((String(q.totalText || "").match(/\d[\d,]*\.\d{2}/g) || []).pop()?.replace(/,/g, "") || 0);
  if (total && printed && Math.abs(printed - total) > 0.01) {
    issues.push(`ตัวเลขยอดรวมที่อ่านได้ไม่ตรงกัน (${money(printed)} / ${money(total)})`);
    total = 0;
  }
  if (total && before && vat && Math.abs(before + vat - total) > 1) {
    issues.push(`ยอดก่อน VAT + VAT (${money(before + vat)}) ไม่ตรงยอดรวม (${money(total)})`);
    total = 0;
  }
  return { ...q, quotationNo: String(q.quotationNo || "").trim(), amountBeforeVat: before, vatAmount: vat, grandTotal: total, issues };
}

/**
 * อ่านทุกไฟล์ใบเสนอราคาของงานพร้อมกัน
 * @returns {Promise<object>} สรุปรวม (found · quotationNo · grandTotal …) + quotations รายใบ + fileCount
 */
async function scanQuotationFiles(files) {
  const list = scannableFiles(files);
  if (!list.length) return { found: false, quotations: [], fileCount: 0, note: "ไม่มีไฟล์รูปหรือ PDF ให้อ่าน" };
  const content = [];
  for (let i = 0; i < list.length; i += 1) {
    content.push({ type: "text", text: `ไฟล์ที่ ${i + 1}: ${list[i].fileName || ""}` });
    content.push(...(await toContentBlocks(list[i])));
  }
  content.push({ type: "text", text: `รวม ${list.length} ไฟล์ — แยกใบเสนอราคาทุกใบแล้วบันทึกผ่านเครื่องมือ` });

  const res = await createMessage(getClient(), {
    model: MODEL,
    max_tokens: 4000,
    system: SYSTEM,
    tools: [EXTRACT_TOOL],
    tool_choice: { type: "tool", name: EXTRACT_TOOL.name },
    messages: [{ role: "user", content }],
  });
  const call = res.content.find((b) => b.type === "tool_use");
  const raw = call?.input || {};
  const quotations = (Array.isArray(raw.quotations) ? raw.quotations : []).map(verifyQuote)
    .filter((q) => q.quotationNo || q.grandTotal);
  const out = {
    found: quotations.length > 0,
    fileCount: list.length,
    quotations: quotations.map((q) => ({
      quotationNo: q.quotationNo,
      files: (Array.isArray(q.files) ? q.files : []).filter((n) => n >= 1 && n <= list.length),
      quotationDate: q.quotationDate || "",
      grandTotal: q.grandTotal,
      totalText: q.totalText || "",
      issues: q.issues,
    })),
    otherFiles: Array.isArray(raw.otherFiles) ? raw.otherFiles : [],
    confidence: raw.confidence || "",
    note: call
      ? [raw.note, ...quotations.flatMap((q) => q.issues.map((x) => `${q.quotationNo || "ใบที่ไม่มีเลขที่"}: ${x}`))].filter(Boolean).join(" · ")
      : "โมเดลไม่ได้ส่งผลลัพธ์กลับมาในรูปแบบที่ใช้ได้",
  };
  if (!quotations.length) return out;

  // สรุปเป็นค่าของงาน: ใบเดียว = ค่าของใบนั้น · หลายใบ = เลขที่ต่อกัน + ยอดรวมทุกใบ (ต้องเห็นยอดครบทุกใบ)
  const allTotals = quotations.every((q) => q.grandTotal > 0);
  const days = (k) => quotations.map((q) => q[k]).filter((v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ""))).sort();
  const contact = quotations.find((q) => q.contactName || q.contactPhone || q.contactEmail) || {};
  return {
    ...out,
    quotationNo: quotations.map((q) => q.quotationNo).filter(Boolean).join(", "),
    quotationDate: days("quotationDate")[0] || "",
    validUntil: days("validUntil")[0] || "",
    amountBeforeVat: allTotals ? r2(quotations.reduce((s, q) => s + q.amountBeforeVat, 0)) : 0,
    vatAmount: allTotals ? r2(quotations.reduce((s, q) => s + q.vatAmount, 0)) : 0,
    grandTotal: allTotals ? r2(quotations.reduce((s, q) => s + q.grandTotal, 0)) : 0,
    contactName: contact.contactName || "",
    contactPhone: contact.contactPhone || "",
    contactEmail: contact.contactEmail || "",
  };
}

/**
 * อ่านทุกไฟล์แล้วเติมให้ทั้งงาน (ทุกวันของ jobGroupId) — เติมช่องที่ว่าง หรือช่องที่ AI เติมไว้เอง (ยังไม่มีคนแก้)
 * ช่องที่ AI เคยเติมแต่รอบนี้ยืนยันไม่ได้ (เช่น ยอดถูกตัด) = ล้างออก ไม่ปล่อยค่าผิดค้างไว้
 * @returns {Promise<{filled: string[], result: object}|null>}
 */
async function autoFillQuotation(eventId) {
  if (!isEnabled()) return null;
  const CalendarEvent = require("../models/Events");
  const ev = await CalendarEvent.findById(eventId).lean();
  // ✅ (26 ต.ค. 2569) อ่านเฉพาะฉบับปัจจุบัน — ฉบับเดิมที่ถูกแทนแล้ว (supersededAt) ไม่นับ
  const files = (ev?.quotationFiles || []).filter((f) => !f.supersededAt);
  if (!ev || !scannableFiles(files).length) return null;
  const r = await scanQuotationFiles(files);

  const aiOwned = new Set(ev.quotationAiFilled?.fields || []);
  const day = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) ? new Date(`${v}T00:00:00+07:00`) : null);
  const same = (a, b) => (a instanceof Date || b instanceof Date ? +new Date(a || 0) === +new Date(b || 0) : String(a ?? "") === String(b ?? ""));
  const $set = {};
  const filled = [];
  const owned = new Set();
  const put = (key, current, value, extra) => {
    if (current && !aiOwned.has(key)) return; // คนกรอกเอง — ไม่แตะ
    if (value) {
      $set[key] = value; Object.assign($set, extra || {}); owned.add(key);
      if (!same(current, value)) filled.push(key);
    } else if (current) {
      $set[key] = key === "quotationNo" ? "" : null; // AI เคยเติมแต่ยืนยันไม่ได้แล้ว → ล้าง
    }
  };
  put("quotationNo", ev.quotationNo, r.quotationNo ? String(r.quotationNo).slice(0, 120) : "");
  put("quotationDate", ev.quotationDate, day(r.quotationDate));
  put("quotationValidUntil", ev.quotationValidUntil, day(r.validUntil));
  put("quotationAmount", ev.quotationAmount, r.grandTotal > 0 ? r.grandTotal : 0,
    { quotationVatIncluded: r.vatAmount > 0 || r.grandTotal > r.amountBeforeVat });
  const c = ev.quotationContact || {};
  const ownC = aiOwned.has("quotationContact");
  if ((r.contactName || r.contactPhone || r.contactEmail) && (ownC || !c.name || !c.phone || !c.email)) {
    const pick = (mine, ai) => (ownC ? ai || mine : mine || ai) || "";
    const next = { name: pick(c.name, r.contactName), phone: pick(c.phone, r.contactPhone), email: pick(c.email, r.contactEmail) };
    $set.quotationContact = next;
    owned.add("quotationContact");
    if (next.name !== (c.name || "") || next.phone !== (c.phone || "") || next.email !== (c.email || "")) filled.push("quotationContact");
  }
  const keepOwned = [...aiOwned].filter((k) => !(k in $set) && k !== "quotationContact");
  $set.quotationAiFilled = {
    at: new Date(),
    fields: [...new Set([...keepOwned, ...owned])],
    confidence: r.confidence || "",
    note: r.note || "",
    fileCount: r.fileCount || 0,
    quotations: r.quotations || [],
  };
  const filter = ev.jobGroupId ? { jobGroupId: ev.jobGroupId } : { _id: ev._id };
  await CalendarEvent.updateMany(filter, { $set });
  if (filled.length) {
    const LABEL = { quotationNo: "เลขที่", quotationDate: "วันที่", quotationValidUntil: "ยืนราคา", quotationAmount: "มูลค่า", quotationContact: "ผู้ติดต่อ" };
    await CalendarEvent.updateOne({ _id: ev._id }, {
      $push: { activityLog: { action: "quotation_ai_filled", detail: `AI อ่านใบเสนอราคา ${r.quotations.length} ใบ จาก ${r.fileCount} ไฟล์ แล้วเติม: ${filled.map((k) => LABEL[k]).join(" · ")}${r.grandTotal ? ` (ยอดรวม ${money(r.grandTotal)} บาท)` : ""}`, userId: "", userName: "ระบบ (AI)", timestamp: new Date() } },
    });
  }
  try { require("./realtime").publish({ topic: "events", id: String(ev._id), action: "put", origin: "", by: "" }); } catch { /* ไม่ขวาง */ }
  return { filled, result: r };
}

/**
 * เรียกแบบไม่รอผล (หลังอัปโหลด) — รอ 15 วินาทีหลังไฟล์สุดท้าย แล้วอ่านทุกไฟล์ทีเดียว
 * (แนบหลายไฟล์ติดกันไม่ต้องอ่านซ้ำหลายรอบ = ประหยัดเครดิต) · ล้มเหลวต้องไม่กระทบคำขอหลัก
 */
const pending = new Map();
const autoFillQuotationSafe = (eventId) => {
  const key = String(eventId);
  clearTimeout(pending.get(key));
  pending.set(key, setTimeout(() => {
    pending.delete(key);
    autoFillQuotation(eventId).catch((err) => console.error("❌ AI เติมใบเสนอราคาไม่สำเร็จ:", err?.status, err?.message));
  }, 15000));
};

module.exports = { scanQuotationFiles, autoFillQuotation, autoFillQuotationSafe, isEnabled, MODEL };
