/**
 * InvoiceScan.js — อ่านยอดเงินจากรูปใบวางบิลด้วย Claude (vision)
 *
 * ⚠️ ผลลัพธ์จากที่นี่เป็น "ข้อเสนอให้ตรวจสอบ" เท่านั้น ห้ามบันทึกลงฐานข้อมูลเองโดยอัตโนมัติเด็ดขาด —
 * เป็นข้อมูลการเงินที่ผิดแล้วตามแก้ยาก (ใบกำกับภาษีออกไปแล้ว/แจ้งลูกค้าไปแล้ว) route นี้จึงคืนค่ากลับ
 * ไปเติมในฟอร์มให้คนกดยืนยันอีกชั้นเสมอ
 *
 * ⚠️ ฟีเจอร์นี้ทำงานเฉพาะเมื่อมี ANTHROPIC_API_KEY ในเครื่องเซิร์ฟเวอร์ — ถ้าไม่ได้ตั้งไว้ ทั้งระบบต้อง
 * ยังทำงานได้ปกติทุกอย่าง แค่ปุ่มนี้ไม่โผล่ (ดู isEnabled) ไม่ใช่พังทั้งหน้า
 */
const Anthropic = require("@anthropic-ai/sdk");

// ⚠️ ตั้งเป็นค่าคงที่ไว้ที่เดียว — ถ้าวันหนึ่งจะเปลี่ยนรุ่น เปลี่ยนที่นี่จุดเดียว
const MODEL = "claude-sonnet-5-5"; // ✅ (19 ต.ค. 2569 ผู้ใช้เลือก Sonnet — ถูกกว่า Opus หลายเท่า อ่านใบเสนอราคา/ใบวางบิลได้ดี)

const isEnabled = () => Boolean(process.env.ANTHROPIC_API_KEY);

let client = null;
const getClient = () => {
  if (!client) client = new Anthropic.Anthropic();
  return client;
};

/**
 * ✅ ใช้ "strict tool use" แทนการให้ตอบเป็นข้อความแล้วมาแกะเอง — API การันตีว่า input ที่ได้ตรงตาม
 * schema เป๊ะ ไม่ต้องเขียน parser เดาเอาเองว่าโมเดลจะตอบรูปแบบไหน (ซึ่งพังทันทีที่รูปแบบเปลี่ยน)
 *
 * 🔁 (17 พ.ย. 2569 ผู้ใช้: "ให้ AI อ่านยอดได้ กรณีที่บิลมีหลายบิล แต่บันทึกเป็นยอดรวม")
 *    อ่านได้หลายไฟล์ในครั้งเดียว — AI แยกเป็น "รายใบ" (ใบเดียวกันที่ถ่ายซ้ำ/หลายหน้า รวมเป็นรายการเดียว)
 *    ส่วน "ยอดรวม" คิดในโค้ดเอง (ไม่ให้ AI บวกเลข) → เลขที่รวมทุกใบ · ยอดก่อน VAT รวม · วันที่ล่าสุด
 */
const invoiceItem = {
  type: "object",
  properties: {
    files: { type: "array", items: { type: "integer" }, description: "ลำดับไฟล์ที่เป็นของใบนี้ (เริ่ม 1) — ใบเดียวกันที่อยู่หลายไฟล์ใส่ทุกลำดับ" },
    invoiceNo: { type: "string", description: "เลขที่ใบวางบิล/ใบแจ้งหนี้/ใบกำกับภาษี ไม่พบให้ใส่ค่าว่าง" },
    invoicedAt: { type: "string", description: "วันที่บนเอกสาร รูปแบบ YYYY-MM-DD (แปลง พ.ศ. เป็น ค.ศ.) ไม่พบให้ใส่ค่าว่าง" },
    amountBeforeVat: { type: "number", description: "ยอดรวมก่อนภาษีมูลค่าเพิ่มของใบนี้ (บาท) ไม่พบให้ใส่ 0" },
    vatRate: { type: "number", description: "อัตรา VAT ของใบนี้ เช่น 7 · ไม่มี VAT ให้ใส่ 0" },
    whtRate: { type: "number", description: "อัตราภาษีหัก ณ ที่จ่ายของใบนี้ เช่น 3 · ไม่ปรากฏให้ใส่ 0" },
  },
  required: ["files", "invoiceNo", "invoicedAt", "amountBeforeVat", "vatRate", "whtRate"],
  additionalProperties: false,
};
const EXTRACT_TOOL = {
  name: "record_invoices",
  description: "บันทึกตัวเลขที่อ่านได้จากใบวางบิล/ใบแจ้งหนี้ — หนึ่งรายการต่อหนึ่งใบ (ไม่ใช่ต่อหนึ่งไฟล์)",
  strict: true,
  input_schema: {
    type: "object",
    properties: {
      found: { type: "boolean", description: "อ่านใบวางบิลจากไฟล์ที่ให้มาได้อย่างน้อย 1 ใบหรือไม่" },
      invoices: { type: "array", items: invoiceItem, description: "ใบวางบิลแต่ละใบที่อ่านได้ (ไม่ซ้ำกัน)" },
      confidence: { type: "string", enum: ["high", "medium", "low"], description: "ความมั่นใจในตัวเลขที่อ่านได้โดยรวม" },
      note: { type: "string", description: "สิ่งที่ควรให้คนตรวจซ้ำ เช่น ตัวเลขเบลอ ไฟล์ซ้ำกัน ไฟล์ไหนไม่ใช่ใบวางบิล" },
    },
    required: ["found", "invoices", "confidence", "note"],
    additionalProperties: false,
  },
};

const SYSTEM = `คุณคือผู้ช่วยฝ่ายบัญชีของบริษัทรับเหมางานระบบในประเทศไทย
อ่านตัวเลขจากรูปใบวางบิล/ใบแจ้งหนี้/ใบกำกับภาษีที่ให้มา (อาจมีหลายไฟล์ แต่ละไฟล์มีป้าย "ไฟล์ที่ N")
แล้วบันทึกผ่านเครื่องมือ record_invoices เสมอ — ห้ามตอบเป็นข้อความอย่างเดียว

กติกาที่ห้ามพลาด:
- หนึ่งรายการ = หนึ่งใบ (หนึ่งเลขที่เอกสาร) · ใบเดียวกันที่ถ่ายซ้ำ/เป็นสำเนา/ต่อหลายหน้า ให้รวมเป็นรายการเดียว แล้วใส่ลำดับไฟล์ทั้งหมดใน files
- อย่าบวกยอดหลายใบเข้าด้วยกันเอง — ใส่ยอดของแต่ละใบแยกรายการ ระบบจะรวมให้
- "ยอดก่อน VAT" คือยอดรวมสินค้า/บริการก่อนบวกภาษีมูลค่าเพิ่ม ไม่ใช่ยอดสุทธิท้ายบิลหรือยอดหลังหัก ณ ที่จ่าย
- เอกสารไทยมักใช้ปี พ.ศ. — ต้องลบ 543 ให้เป็น ค.ศ. ก่อนเสมอ
- ถ้าตัวเลขช่องไหนอ่านไม่ชัดหรือไม่มีในเอกสาร ห้ามเดา ให้ใส่ 0 หรือค่าว่าง แล้วอธิบายไว้ใน note
- ไฟล์ที่ไม่ใช่ใบวางบิล ไม่ต้องใส่เป็นรายการ ให้บอกใน note · ถ้าไม่มีใบไหนอ่านได้เลย ให้ found = false`;

const MAX_FILES = 8;
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const normNo = (v) => String(v || "").replace(/\s+/g, "").toUpperCase();
/** ค่าที่พบบ่อยที่สุด (อัตรา VAT/หัก ณ ที่จ่าย) — ทุกใบเท่ากันก็ได้ค่านั้น */
const mostCommon = (list) => {
  const count = new Map();
  list.forEach((v) => count.set(v, (count.get(v) || 0) + 1));
  return [...count.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;
};

/** รวมผลรายใบเป็นค่าที่เติมในฟอร์ม (คิดในโค้ด ไม่ให้ AI บวกเลขเอง) */
function combine(input, fileCount) {
  const notes = [String(input?.note || "").trim()].filter(Boolean);
  const seen = new Set();
  const invoices = [];
  (Array.isArray(input?.invoices) ? input.invoices : []).forEach((x) => {
    const key = normNo(x.invoiceNo);
    if (key && seen.has(key)) {
      // ใบเดียวกันอยู่หลายไฟล์ — นับยอดครั้งเดียว แต่จำลำดับไฟล์ไว้
      const first = invoices.find((v) => normNo(v.invoiceNo) === key);
      (x.files || []).forEach((n) => { if (Number.isInteger(n) && n >= 1 && n <= fileCount && !first.files.includes(n)) first.files.push(n); });
      notes.push(`เลขที่ ${x.invoiceNo} ซ้ำกัน — นับยอดครั้งเดียว`);
      return;
    }
    if (key) seen.add(key);
    invoices.push({
      files: (x.files || []).filter((n) => Number.isInteger(n) && n >= 1 && n <= fileCount),
      invoiceNo: String(x.invoiceNo || "").trim(),
      invoicedAt: /^\d{4}-\d{2}-\d{2}$/.test(String(x.invoicedAt || "")) ? x.invoicedAt : "",
      amountBeforeVat: round2(Math.max(0, Number(x.amountBeforeVat) || 0)),
      vatRate: Number(x.vatRate) || 0,
      whtRate: Number(x.whtRate) || 0,
    });
  });
  const found = Boolean(input?.found) && invoices.length > 0;
  if (!found) return { found: false, note: notes.join(" · ") || "อ่านใบวางบิลจากไฟล์ที่ให้มาไม่ได้", invoices: [], fileCount };
  const vats = invoices.map((x) => x.vatRate);
  const whts = invoices.map((x) => x.whtRate);
  if (new Set(vats).size > 1) notes.push(`อัตรา VAT ไม่เท่ากันทุกใบ (${[...new Set(vats)].join("% / ")}%) — ตรวจก่อนบันทึก`);
  if (new Set(whts).size > 1) notes.push(`อัตราหัก ณ ที่จ่ายไม่เท่ากันทุกใบ (${[...new Set(whts)].join("% / ")}%) — ตรวจก่อนบันทึก`);
  if (invoices.some((x) => !(x.amountBeforeVat > 0))) notes.push("มีบางใบที่อ่านยอดไม่ได้ — ยอดรวมยังไม่รวมใบนั้น");
  const dates = invoices.map((x) => x.invoicedAt).filter(Boolean).sort();
  return {
    found: true,
    invoiceNo: [...new Set(invoices.map((x) => x.invoiceNo).filter(Boolean))].join(", "),
    invoicedAt: dates[dates.length - 1] || "",
    amountBeforeVat: round2(invoices.reduce((sum, x) => sum + x.amountBeforeVat, 0)),
    vatRate: mostCommon(vats),
    whtRate: mostCommon(whts),
    confidence: ["high", "medium", "low"].includes(input?.confidence) ? input.confidence : "low",
    note: notes.join(" · "),
    invoices,
    fileCount,
  };
}

/**
 * @param {string[]} imageUrls URL รูปใบวางบิล (Cloudinary) — 1 ไฟล์ขึ้นไป (สูงสุด MAX_FILES)
 * @returns {Promise<object>} ค่ารวมที่เติมในฟอร์ม + รายใบ (invoices) + confidence/note ให้คนตรวจซ้ำ
 */
async function scanInvoiceImages(imageUrls) {
  const { toContentBlocks, createMessage } = require("./aiFileSource");
  const urls = (imageUrls || []).slice(0, MAX_FILES);
  const content = [];
  for (let i = 0; i < urls.length; i += 1) {
    // 🐛 (19 ต.ค. 2569) ส่ง base64 ที่ดึงเอง (รูปย่อจาก Cloudinary) แทน URL — URL ตรงถูกปฏิเสธเมื่อรูปใหญ่/ไฟล์ raw · รูปยาวตัดเป็นช่วง
    content.push({ type: "text", text: `ไฟล์ที่ ${i + 1}:` });
    // eslint-disable-next-line no-await-in-loop -- ดึงทีละไฟล์ กันยิงพร้อมกันจนหน่วยความจำพุ่ง
    content.push(...(await toContentBlocks({ fileUrl: urls[i], fileType: "image/jpeg" })));
  }
  content.push({ type: "text", text: urls.length > 1
    ? `มีทั้งหมด ${urls.length} ไฟล์ — อ่านทุกใบแล้วบันทึกผ่านเครื่องมือ record_invoices (หนึ่งรายการต่อหนึ่งใบ)`
    : "อ่านใบวางบิลในรูปนี้แล้วบันทึกผ่านเครื่องมือ record_invoices" });

  const res = await createMessage(getClient(), {
    model: MODEL,
    max_tokens: 4000,
    system: SYSTEM,
    tools: [EXTRACT_TOOL],
    // ⚠️ Claude Sonnet 5.5 ไม่รับการบังคับเครื่องมือ (tool_choice "tool"/"any" = 400) — ใช้ auto + strict
    //    และสั่งในคำสั่งระบบให้เรียกเครื่องมือเสมอ
    tool_choice: { type: "auto" },
    messages: [{ role: "user", content }],
  });

  const call = res.content.find((b) => b.type === "tool_use" && b.name === EXTRACT_TOOL.name);
  if (!call) return { found: false, note: "โมเดลไม่ได้ส่งผลลัพธ์กลับมาในรูปแบบที่ใช้ได้ — ลองใหม่อีกครั้ง", invoices: [], fileCount: urls.length };
  return combine(call.input, urls.length);
}

/** อ่านรูปเดียว (ของเดิม) — ใช้ตัวอ่านหลายไฟล์ตัวเดียวกัน */
const scanInvoiceImage = (imageUrl) => scanInvoiceImages([imageUrl]);

module.exports = { scanInvoiceImage, scanInvoiceImages, isEnabled, MODEL, MAX_FILES, combine };
