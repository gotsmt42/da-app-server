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

let client = null;
const getClient = () => {
  if (!client) client = new Anthropic.Anthropic();
  return client;
};

const EXTRACT_TOOL = {
  name: "record_quotation",
  description: "บันทึกข้อมูลที่อ่านได้จากใบเสนอราคา",
  strict: true,
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
 * @param {{ fileUrl: string, isPdf: boolean }} file ไฟล์บน Cloudinary (public URL)
 */
async function scanQuotationFile({ fileUrl, isPdf }) {
  const res = await getClient().messages.create({
    model: MODEL,
    max_tokens: 2000,
    system: SYSTEM,
    tools: [EXTRACT_TOOL],
    tool_choice: { type: "tool", name: EXTRACT_TOOL.name },
    messages: [{
      role: "user",
      content: [
        isPdf
          ? { type: "document", source: { type: "url", url: fileUrl } }
          : { type: "image", source: { type: "url", url: fileUrl } },
        { type: "text", text: "อ่านใบเสนอราคานี้แล้วบันทึกผ่านเครื่องมือ" },
      ],
    }],
  });
  const call = res.content.find((b) => b.type === "tool_use");
  if (!call) return { found: false, note: "โมเดลไม่ได้ส่งผลลัพธ์กลับมาในรูปแบบที่ใช้ได้" };
  return call.input;
}

module.exports = { scanQuotationFile, isEnabled, MODEL };
