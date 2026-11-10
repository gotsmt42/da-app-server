/**
 * WorkValueScan.js — ให้ AI อ่าน "มูลค่างานครั้งนี้" จากไฟล์ที่แนบกับงาน (PO · ใบเสนอราคา · ใบวางบิล · เอกสารอ้างอิง)
 *
 * ✅ (10 พ.ย. 2569 ผู้ใช้: "มูลค่างานครั้งนี้ … งานไหนที่ไม่มีมูลค่า งานทั่วไปหรืออื่นๆ ให้เอา AI มาช่วยอ่านไฟล์
 *    และให้เลือกได้ว่าจะระบุยอดบวก VAT หรือยอด Net")
 *    • คืนทั้ง "ยอดก่อน VAT" และ "ยอดรวม VAT" ให้คนเลือกเองว่าจะใช้ค่าไหน — ไม่บันทึกอะไรลงฐานข้อมูล
 *    • ยอดต้องพิมพ์อยู่บนเอกสารจริง ห้ามบวกเอง · เซิร์ฟเวอร์ตรวจซ้ำ ก่อน VAT + VAT = ยอดรวม
 *    • เลือกเอกสารที่เป็น "ยอดของงานนี้" ที่สุด: PO/ใบสั่งจ้าง > ใบเสนอราคาที่ได้งาน > ใบวางบิล/ใบแจ้งหนี้
 * ⚠️ ไม่มี ANTHROPIC_API_KEY = ปิดฟีเจอร์
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

const TOOL = {
  name: "record_work_value",
  description: "บันทึกมูลค่างานที่อ่านได้จากเอกสารของงานนี้",
  input_schema: {
    type: "object",
    properties: {
      found: { type: "boolean", description: "พบยอดเงินของงานที่พิมพ์ครบชัดเจนหรือไม่" },
      docType: { type: "string", enum: ["po", "quotation", "invoice", "contract", "other", ""], description: "ชนิดเอกสารที่ใช้เป็นยอดของงาน" },
      docNo: { type: "string", description: "เลขที่เอกสารที่ใช้ คัดลอกตรงตามที่พิมพ์ ไม่พบให้ใส่ค่าว่าง" },
      file: { type: "integer", description: "หมายเลขไฟล์ (เริ่ม 1) ที่มียอดนี้ · ไม่พบให้ใส่ 0" },
      totalVisible: { type: "boolean", description: "บรรทัดยอดเงินมองเห็นครบทุกหลักหรือไม่" },
      totalText: { type: "string", description: "คัดลอกป้ายและตัวเลขยอดตามที่พิมพ์ เช่น 'รวมทั้งสิ้น 21,186.00'" },
      amountBeforeVat: { type: "number", description: "ยอดหลังหักส่วนลด ก่อน VAT ตามที่พิมพ์ ไม่เห็นให้ใส่ 0" },
      vatAmount: { type: "number", description: "จำนวนเงิน VAT ตามที่พิมพ์ ไม่มี/ไม่เห็นให้ใส่ 0" },
      grandTotal: { type: "number", description: "ยอดรวมทั้งสิ้น (รวม VAT) ตามที่พิมพ์ ไม่เห็นให้ใส่ 0" },
      note: { type: "string", description: "สิ่งที่ควรให้คนตรวจ (ภาษาไทยสั้นๆ) เช่น มีหลายใบ ยอดไม่ตรงกัน ตัวเลขเบลอ" },
    },
    required: ["found", "docType", "docNo", "file", "totalVisible", "totalText", "amountBeforeVat", "vatAmount", "grandTotal", "note"],
  },
};

const SYSTEM = `คุณคือผู้ช่วยฝ่ายบัญชีของบริษัทรับเหมางานระบบในประเทศไทย
จะได้รับไฟล์เอกสารของ "งานหนึ่งงาน" (มีป้าย "ไฟล์ที่ N" และชนิดที่แนบไว้กำกับ · รูปยาวอาจถูกตัดเป็นหลายช่วง)
หา "มูลค่าของงานนี้" แล้วบันทึกผ่านเครื่องมือ record_work_value

กติกา:
- เลือกเอกสารตามลำดับ: ใบสั่งซื้อ/ใบสั่งจ้าง (PO) > ใบเสนอราคา > ใบวางบิล/ใบแจ้งหนี้/ใบกำกับภาษี > สัญญา
- ถ้ามีใบเสนอราคาหลายใบและไม่มี PO ให้รวมยอดทุกใบที่เป็นของงานนี้ (ระบุใน note ว่ารวมกี่ใบ)
- ยอดเงินต้องเป็นตัวเลขที่พิมพ์อยู่บนเอกสารเท่านั้น ห้ามคำนวณจากรายการสินค้าเอง ห้ามเดาตัวเลขที่ถูกตัด
  ไม่เห็นยอดครบ ให้ found = false, totalVisible = false และยอดเป็น 0
- grandTotal = ยอดรวมทั้งสิ้น (รวม VAT) · amountBeforeVat = หลังหักส่วนลด ก่อน VAT · เอกสารไม่มี VAT ให้ vatAmount = 0 และ grandTotal = amountBeforeVat
- รูปถ่ายหน้างาน/รูปคน ไม่ใช่เอกสาร ข้ามได้`;

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const money = (n) => Number(n || 0).toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** ตรวจผลซ้ำ — ยอดไม่ครบ/บวกไม่ตรง = ไม่ใช้ยอดนั้น */
function verify(raw) {
  const issues = [];
  let before = r2(raw.amountBeforeVat);
  const vat = r2(raw.vatAmount);
  let total = raw.totalVisible ? r2(raw.grandTotal) : 0;
  if (!raw.totalVisible) before = 0;
  if (total && before && vat && Math.abs(before + vat - total) > 1) {
    issues.push(`ยอดก่อน VAT + VAT (${money(before + vat)}) ไม่ตรงยอดรวม (${money(total)})`);
    total = 0; before = 0;
  }
  // เห็นยอดรวม + VAT แต่ไม่เห็นยอดก่อน VAT → หักออกได้ (ตัวเลขทั้งสองพิมพ์อยู่บนเอกสาร)
  if (total && vat && !before && vat < total) before = r2(total - vat);
  // ไม่มี VAT บนเอกสาร = ยอดเดียวกัน
  if (total && !before && !vat) before = total;
  if (before && !total && !vat) total = before;
  return { amountBeforeVat: before, vatAmount: vat, grandTotal: total, issues };
}

/**
 * @param {Array<{fileName, fileUrl, fileType, kind}>} files เรียงตามความสำคัญแล้ว (kind = ป้ายชนิดที่แนบ)
 */
async function scanWorkValue(files) {
  const list = (files || []).filter((f) => f?.fileUrl && (isPdfFile(f) || isImageFile(f))).slice(0, MAX_FILES);
  if (!list.length) return { found: false, fileCount: 0, files: [], note: "ไม่มีไฟล์รูปหรือ PDF ให้อ่าน" };
  const content = [];
  for (let i = 0; i < list.length; i += 1) {
    content.push({ type: "text", text: `ไฟล์ที่ ${i + 1} (${list[i].kind || "ไฟล์แนบ"}): ${list[i].fileName || ""}` });
    content.push(...(await toContentBlocks(list[i])));
  }
  content.push({ type: "text", text: `รวม ${list.length} ไฟล์ — หามูลค่างานแล้วบันทึกผ่านเครื่องมือ` });
  const res = await createMessage(getClient(), {
    model: MODEL,
    max_tokens: 1500,
    system: SYSTEM,
    tools: [TOOL],
    tool_choice: { type: "tool", name: TOOL.name },
    messages: [{ role: "user", content }],
  });
  const call = res.content.find((b) => b.type === "tool_use");
  const raw = call?.input || {};
  const v = verify(raw);
  const fileNo = Number(raw.file) || 0;
  const src = fileNo >= 1 && fileNo <= list.length ? list[fileNo - 1] : null;
  return {
    found: Boolean(raw.found) && v.grandTotal > 0,
    docType: raw.docType || "",
    docNo: String(raw.docNo || "").trim(),
    fileName: src?.fileName || "",
    fileKind: src?.kind || "",
    totalText: raw.totalText || "",
    ...v,
    fileCount: list.length,
    files: list.map((f) => ({ fileName: f.fileName || "", kind: f.kind || "" })),
    note: call ? [raw.note, ...v.issues].filter(Boolean).join(" · ") : "โมเดลไม่ได้ส่งผลลัพธ์กลับมาในรูปแบบที่ใช้ได้",
  };
}

module.exports = { scanWorkValue, verify, isEnabled, MODEL, MAX_FILES };
