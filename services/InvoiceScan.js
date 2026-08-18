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
const MODEL = "claude-opus-5";

const isEnabled = () => Boolean(process.env.ANTHROPIC_API_KEY);

let client = null;
const getClient = () => {
  if (!client) client = new Anthropic.Anthropic();
  return client;
};

/**
 * ✅ ใช้ "strict tool use" แทนการให้ตอบเป็นข้อความแล้วมาแกะเอง — API การันตีว่า input ที่ได้ตรงตาม
 * schema เป๊ะ ไม่ต้องเขียน parser เดาเอาเองว่าโมเดลจะตอบรูปแบบไหน (ซึ่งพังทันทีที่รูปแบบเปลี่ยน)
 */
const EXTRACT_TOOL = {
  name: "record_invoice",
  description: "บันทึกตัวเลขที่อ่านได้จากใบวางบิล/ใบแจ้งหนี้",
  strict: true,
  input_schema: {
    type: "object",
    properties: {
      found: {
        type: "boolean",
        description: "อ่านใบวางบิลจากรูปนี้ได้จริงหรือไม่ (false ถ้าไม่ใช่ใบวางบิล/อ่านไม่ออก)",
      },
      invoiceNo: { type: "string", description: "เลขที่ใบวางบิล/ใบแจ้งหนี้ ไม่พบให้ใส่ค่าว่าง" },
      invoicedAt: { type: "string", description: "วันที่บนเอกสาร รูปแบบ YYYY-MM-DD (แปลง พ.ศ. เป็น ค.ศ. ให้เรียบร้อย) ไม่พบให้ใส่ค่าว่าง" },
      amountBeforeVat: { type: "number", description: "ยอดรวมก่อนภาษีมูลค่าเพิ่ม (บาท) ไม่พบให้ใส่ 0" },
      vatRate: { type: "number", description: "อัตรา VAT ที่ปรากฏบนเอกสาร เช่น 7 · ไม่มี VAT ให้ใส่ 0" },
      whtRate: { type: "number", description: "อัตราภาษีหัก ณ ที่จ่าย เช่น 3 · ไม่ปรากฏบนเอกสารให้ใส่ 0" },
      confidence: { type: "string", enum: ["high", "medium", "low"], description: "ความมั่นใจในตัวเลขที่อ่านได้" },
      note: { type: "string", description: "สิ่งที่ควรให้คนตรวจซ้ำ เช่น ตัวเลขเบลอ อ่านได้ไม่ชัด" },
    },
    required: ["found", "invoiceNo", "invoicedAt", "amountBeforeVat", "vatRate", "whtRate", "confidence", "note"],
    additionalProperties: false,
  },
};

const SYSTEM = `คุณคือผู้ช่วยฝ่ายบัญชีของบริษัทรับเหมางานระบบในประเทศไทย
อ่านตัวเลขจากรูปใบวางบิล/ใบแจ้งหนี้ที่ให้มา แล้วบันทึกผ่านเครื่องมือ record_invoice

กติกาที่ห้ามพลาด:
- "ยอดก่อน VAT" คือยอดรวมสินค้า/บริการก่อนบวกภาษีมูลค่าเพิ่ม ไม่ใช่ยอดสุทธิท้ายบิล
- เอกสารไทยมักใช้ปี พ.ศ. — ต้องลบ 543 ให้เป็น ค.ศ. ก่อนเสมอ
- ถ้าตัวเลขช่องไหนอ่านไม่ชัดหรือไม่มีในเอกสาร ห้ามเดา ให้ใส่ 0 หรือค่าว่าง แล้วอธิบายไว้ใน note
- ถ้ารูปไม่ใช่ใบวางบิล ให้ตั้ง found = false`;

/**
 * @param {string} imageUrl URL ของรูป (Cloudinary secure_url ที่ช่างอัปโหลดไว้)
 * @returns {Promise<object>} ค่าที่อ่านได้ พร้อม confidence/note ให้คนตรวจซ้ำ
 */
async function scanInvoiceImage(imageUrl) {
  const res = await getClient().messages.create({
    model: MODEL,
    max_tokens: 2000,
    system: SYSTEM,
    tools: [EXTRACT_TOOL],
    // ⚠️ บังคับให้เรียกเครื่องมือเสมอ — ไม่งั้นบางครั้งโมเดลจะตอบเป็นข้อความบรรยายแทน แล้วฝั่งเรา
    // ไม่มีอะไรให้เอาไปเติมในฟอร์ม
    tool_choice: { type: "tool", name: EXTRACT_TOOL.name },
    messages: [
      {
        role: "user",
        content: [
          // ⚠️ ส่งเป็น URL ตรงๆ ไม่ต้องดาวน์โหลดมาแปลง base64 — ไฟล์อยู่บน Cloudinary เป็น public URL
          // อยู่แล้ว การดึงมาเองเปลืองทั้งเวลาและหน่วยความจำของเซิร์ฟเวอร์โดยไม่ได้อะไรเพิ่ม
          { type: "image", source: { type: "url", url: imageUrl } },
          { type: "text", text: "อ่านใบวางบิลในรูปนี้แล้วบันทึกผ่านเครื่องมือ" },
        ],
      },
    ],
  });

  const call = res.content.find((b) => b.type === "tool_use");
  if (!call) {
    return { found: false, note: "โมเดลไม่ได้ส่งผลลัพธ์กลับมาในรูปแบบที่ใช้ได้" };
  }
  return call.input;
}

module.exports = { scanInvoiceImage, isEnabled, MODEL };
