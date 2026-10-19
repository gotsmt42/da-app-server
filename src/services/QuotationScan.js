/**
 * QuotationScan.js — อ่านข้อมูลจากไฟล์ใบเสนอราคา (รูป/PDF) ด้วย Claude
 *
 * ✅ (19 ต.ค. 2569 ผู้ใช้: "อยากให้วิเคราะห์ข้อมูลในภาพหรือไฟล์อัตโนมัติเลยว่าราคารวมเท่าไรที่แนบ")
 *    แนบไฟล์ใบเสนอราคาแล้ว หน้าจอขอให้อ่าน เลขที่ · วันที่ · ยืนราคาถึง · ยอดก่อน VAT · VAT · ยอดรวม · ผู้ติดต่อ
 *
 * ⚠️ แบบเดียวกับ InvoiceScan: ผลลัพธ์เป็น "ข้อเสนอให้ตรวจ" เท่านั้น — route คืนค่าให้หน้าจอแสดง แล้วคนกด
 *    "ใช้ค่านี้" เองจึงบันทึก (ตัวเลขเงินผิดแล้วตามแก้ยาก) · ไม่มี ANTHROPIC_API_KEY = ปิดฟีเจอร์ ระบบอื่นทำงานปกติ
 */
const Anthropic = require("@anthropic-ai/sdk");
const { MODEL, isEnabled } = require("./InvoiceScan");
const { toContentBlock, isPdfFile, isImageFile } = require("./aiFileSource");

let client = null;
const getClient = () => {
  if (!client) client = new Anthropic.Anthropic();
  return client;
};

const EXTRACT_TOOL = {
  name: "record_quotation",
  description: "บันทึกข้อมูลที่อ่านได้จากใบเสนอราคา",
  input_schema: {
    type: "object",
    properties: {
      found: { type: "boolean", description: "อ่านใบเสนอราคาจากไฟล์นี้ได้จริงหรือไม่ (false ถ้าไม่ใช่ใบเสนอราคา/อ่านไม่ออก)" },
      quotationNo: { type: "string", description: "เลขที่ใบเสนอราคา ไม่พบให้ใส่ค่าว่าง" },
      quotationDate: { type: "string", description: "วันที่ใบเสนอราคา YYYY-MM-DD (แปลง พ.ศ. เป็น ค.ศ.) ไม่พบให้ใส่ค่าว่าง" },
      validUntil: { type: "string", description: "ยืนราคาถึงวันที่ YYYY-MM-DD (ถ้าระบุเป็นจำนวนวัน ให้คำนวณจากวันที่ใบเสนอราคา) ไม่พบให้ใส่ค่าว่าง" },
      amountBeforeVat: { type: "number", description: "ยอดรวมก่อนภาษีมูลค่าเพิ่ม (บาท) หลังหักส่วนลด ไม่พบให้ใส่ 0" },
      vatAmount: { type: "number", description: "จำนวนเงินภาษีมูลค่าเพิ่ม (บาท) ไม่มีให้ใส่ 0" },
      grandTotal: { type: "number", description: "ยอดรวมสุทธิท้ายใบเสนอราคา (รวม VAT แล้ว) ไม่พบให้ใส่ 0" },
      contactName: { type: "string", description: "ชื่อผู้ติดต่อฝั่งลูกค้า (ถึง/Attn) ไม่พบให้ใส่ค่าว่าง" },
      contactPhone: { type: "string", description: "เบอร์โทรผู้ติดต่อฝั่งลูกค้า ไม่พบให้ใส่ค่าว่าง" },
      contactEmail: { type: "string", description: "อีเมลผู้ติดต่อฝั่งลูกค้า ไม่พบให้ใส่ค่าว่าง" },
      confidence: { type: "string", enum: ["high", "medium", "low"], description: "ความมั่นใจในตัวเลขที่อ่านได้" },
      note: { type: "string", description: "สิ่งที่ควรให้คนตรวจซ้ำ เช่น ตัวเลขเบลอ มีหลายยอด" },
    },
    required: ["found", "quotationNo", "quotationDate", "validUntil", "amountBeforeVat", "vatAmount", "grandTotal", "contactName", "contactPhone", "contactEmail", "confidence", "note"],
    additionalProperties: false,
  },
};

const SYSTEM = `คุณคือผู้ช่วยฝ่ายขายของบริษัทรับเหมางานระบบในประเทศไทย
อ่านข้อมูลจากใบเสนอราคา (Quotation) ที่ให้มา แล้วบันทึกผ่านเครื่องมือ record_quotation

กติกาที่ห้ามพลาด:
- grandTotal คือยอดรวมสุทธิที่ลูกค้าต้องจ่าย (รวม VAT แล้ว) · amountBeforeVat คือยอดหลังหักส่วนลดแต่ก่อนบวก VAT
- ผู้ติดต่อคือฝั่ง "ลูกค้า" (ถึง/เรียน/Attn) ไม่ใช่ผู้เสนอราคาหรือบริษัทผู้ออกเอกสาร
- เอกสารไทยมักใช้ปี พ.ศ. — ต้องลบ 543 ให้เป็น ค.ศ. ก่อนเสมอ
- ช่องไหนอ่านไม่ชัดหรือไม่มีในเอกสาร ห้ามเดา ให้ใส่ 0 หรือค่าว่าง แล้วอธิบายไว้ใน note
- ถ้าไม่ใช่ใบเสนอราคา ให้ตั้ง found = false`;

/**
 * @param {{ fileUrl: string, fileName?: string, fileType?: string }} file ไฟล์ใบเสนอราคาบน Cloudinary
 */
async function scanQuotationFile(file) {
  const block = await toContentBlock(file);
  const res = await getClient().messages.create({
    model: MODEL,
    max_tokens: 2000,
    system: SYSTEM,
    tools: [EXTRACT_TOOL],
    tool_choice: { type: "tool", name: EXTRACT_TOOL.name },
    messages: [{
      role: "user",
      content: [
        block,
        { type: "text", text: "อ่านใบเสนอราคานี้แล้วบันทึกผ่านเครื่องมือ" },
      ],
    }],
  });
  const call = res.content.find((b) => b.type === "tool_use");
  if (!call) return { found: false, note: "โมเดลไม่ได้ส่งผลลัพธ์กลับมาในรูปแบบที่ใช้ได้" };
  return call.input;
}

/**
 * ✅ (19 ต.ค. 2569 ผู้ใช้เลือก "เติมให้อัตโนมัติเลย") อ่านไฟล์แล้วเติม "เฉพาะช่องที่ยังว่าง" ให้ทั้งงาน (ทุกวันของ jobGroupId)
 *    เลขที่ · วันที่ · ยืนราคา · มูลค่า (ยอดรวม) · ผู้ติดต่อ — ไม่ทับค่าที่คนกรอกไว้ · จดลงประวัติ + quotationAiFilled
 *    แจ้งหน้าจอทุกเครื่องให้โหลดใหม่ (realtime "events")
 * @returns {Promise<{filled: string[], result: object}|null>}
 */
async function autoFillQuotation(eventId, fileId) {
  if (!isEnabled()) return null;
  const CalendarEvent = require("../models/Events");
  const ev = await CalendarEvent.findById(eventId).lean();
  if (!ev) return null;
  const files = ev.quotationFiles || [];
  const file = fileId ? files.find((f) => String(f._id) === String(fileId)) : files[files.length - 1];
  if (!file) return null;
  if (!isPdfFile(file) && !isImageFile(file)) return null;
  const r = await scanQuotationFile(file);
  if (!r?.found) return { filled: [], result: r };

  const day = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) ? new Date(`${v}T00:00:00+07:00`) : null);
  const $set = {};
  const filled = [];
  if (!ev.quotationNo && r.quotationNo) { $set.quotationNo = String(r.quotationNo).slice(0, 60); filled.push("quotationNo"); }
  if (!ev.quotationDate && day(r.quotationDate)) { $set.quotationDate = day(r.quotationDate); filled.push("quotationDate"); }
  if (!ev.quotationValidUntil && day(r.validUntil)) { $set.quotationValidUntil = day(r.validUntil); filled.push("quotationValidUntil"); }
  const vat = Number(r.vatAmount) || 0;
  const total = Number(r.grandTotal) || (Number(r.amountBeforeVat) + vat) || 0;
  if (!ev.quotationAmount && total > 0) {
    $set.quotationAmount = Math.round(total * 100) / 100;
    $set.quotationVatIncluded = vat > 0 || Number(r.grandTotal) > Number(r.amountBeforeVat);
    filled.push("quotationAmount");
  }
  const c = ev.quotationContact || {};
  if ((!c.name && r.contactName) || (!c.phone && r.contactPhone) || (!c.email && r.contactEmail)) {
    $set.quotationContact = { name: c.name || r.contactName || "", phone: c.phone || r.contactPhone || "", email: c.email || r.contactEmail || "" };
    filled.push("quotationContact");
  }
  if (!filled.length) return { filled, result: r };
  const prev = (ev.quotationAiFilled?.fields || []);
  $set.quotationAiFilled = { at: new Date(), fields: [...new Set([...prev, ...filled])], confidence: r.confidence || "", note: r.note || "" };
  const filter = ev.jobGroupId ? { jobGroupId: ev.jobGroupId } : { _id: ev._id };
  await CalendarEvent.updateMany(filter, { $set });
  const LABEL = { quotationNo: "เลขที่", quotationDate: "วันที่", quotationValidUntil: "ยืนราคา", quotationAmount: "มูลค่า", quotationContact: "ผู้ติดต่อ" };
  await CalendarEvent.updateOne({ _id: ev._id }, {
    $push: { activityLog: { action: "quotation_ai_filled", detail: `AI อ่านไฟล์ใบเสนอราคาแล้วเติม: ${filled.map((k) => LABEL[k]).join(" · ")}${total ? ` (ยอดรวม ${total.toLocaleString("th-TH")} บาท)` : ""}`, userId: "", userName: "ระบบ (AI)", timestamp: new Date() } },
  });
  try { require("./realtime").publish({ topic: "events", id: String(ev._id), action: "put", origin: "", by: "" }); } catch { /* ไม่ขวาง */ }
  return { filled, result: r };
}

/** เรียกแบบไม่รอผล (หลังอัปโหลด) — ล้มเหลวต้องไม่กระทบคำขอหลัก */
const autoFillQuotationSafe = (eventId, fileId) =>
  autoFillQuotation(eventId, fileId).catch((err) => { console.error("❌ AI เติมใบเสนอราคาไม่สำเร็จ:", err?.message); return null; });

module.exports = { scanQuotationFile, autoFillQuotation, autoFillQuotationSafe, isEnabled, MODEL };
