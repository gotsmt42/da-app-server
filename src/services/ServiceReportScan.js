/**
 * ServiceReportScan.js — ให้ AI อ่านใบ Service Report ที่ช่างแนบ (รูปถ่าย/สแกน/PDF · ลายมือ) แล้วสรุปเป็นข้อมูลมีโครงสร้าง
 *
 * ✅ (25 ต.ค. 2569 ผู้ใช้: "ทำระบบให้อ่าน Service Report ของช่าง แล้วให้กดสร้างสรุปออกมาเป็น PDF ทำให้สมบูรณ์ที่สุด")
 * 🔁 (25 ต.ค. 2569 ผู้ใช้: "เอาแค่เนื้อหารายละเอียดงานที่ทำ ไม่ต้องอ่านหัวกระดาษ และท้ายกระดาษ ... และสรุปปัญหาที่พบ")
 *    • อ่านเฉพาะ "เนื้อหา" = รายละเอียดงานที่ทำ + ปัญหาที่พบ/อุปกรณ์ที่ต้องเปลี่ยน
 *    • ไม่อ่านหัวกระดาษ (โครงการ วันที่ เวลา ผู้ติดต่อ ประเภทงาน ระบบ) — ข้อมูลพวกนี้ระบบมีอยู่แล้วจากงาน
 *      ไม่อ่านท้ายกระดาษ (ลายเซ็น ความเห็นลูกค้า ชื่อช่าง) — ลายมือส่วนนี้อ่านผิดง่ายและไม่ใช้ในรายงาน
 *    • อ่าน "ทุกไฟล์" ของงานพร้อมกัน (ใบเดียวมักหลายหน้า · มีแผ่นต่อ · งานหลายวันมีหลายใบ)
 *    • ผลใช้ได้ทั้ง PDF และ Excel: งานที่ทำเป็นข้อๆ · ปัญหาแยกแถวละ 1 จุด/1 รายการอุปกรณ์ (จำนวนแยกเลข/หน่วย)
 *    • สิ่งที่อ่านไม่ชัด ต้องบอกใน reviewNotes — ห้ามเดา (เอกสารนี้ส่งลูกค้าได้)
 * ⚠️ ผลเป็น "ร่าง" เสมอ คนต้องตรวจ/แก้แล้วกดยืนยันเอง (routes/calendarEvent/workflow.js)
 * ⚠️ ไม่มี ANTHROPIC_API_KEY = ปิดฟีเจอร์ ระบบอื่นทำงานปกติ
 */
const Anthropic = require("@anthropic-ai/sdk");
const { MODEL } = require("./InvoiceScan");
const { toContentBlocks, createMessage, isPdfFile, isImageFile } = require("./aiFileSource");

let client = null;
const getClient = () => {
  if (!client) client = new Anthropic.Anthropic();
  return client;
};

const MAX_FILES = 12;
const ISSUE_STATUSES = ["fixed", "pending", "need_quote", "unknown"];

const str = (description) => ({ type: "string", description });
const strArr = (description) => ({ type: "array", items: { type: "string" }, description });

const SUMMARY_TOOL = {
  name: "record_service_report",
  description: "บันทึกเนื้อหารายละเอียดงานที่ทำ และปัญหาที่พบ จากใบ Service Report ทุกไฟล์ของงานนี้",
  input_schema: {
    type: "object",
    properties: {
      found: { type: "boolean", description: "ไฟล์เป็นใบ Service Report/รายงานบริการจริงและอ่านเนื้อหาได้หรือไม่" },
      summary: str("สรุปงานที่ทำ ภาษาไทยทางการ 2–4 ประโยค: เข้าทำอะไร ผลเป็นอย่างไร (มีตัวเลขก่อน→หลังถ้าเขียนไว้)"),
      workDone: strArr("รายละเอียดงานที่ทำ เรียงตามลำดับในเอกสาร ข้อละ 1 เรื่อง เขียนให้คนนอกอ่านรู้เรื่อง สุภาพ รวมผลตรวจ/ตัวเลขสถานะระบบที่เขียนในเนื้อหาไว้ในข้อนั้นๆ (แก้คำย่อ/สะกดผิดได้ ห้ามเพิ่มข้อเท็จจริงที่ไม่มีในเอกสาร)"),
      issueSummary: str("สรุปปัญหาที่พบ 1–3 ประโยค: ปัญหาหลักคืออะไร ยังค้างอะไร ต้องเปลี่ยนอุปกรณ์/เสนอราคาอะไร · ไม่พบปัญหาให้ใส่ค่าว่าง"),
      issues: {
        type: "array",
        description: "ปัญหาที่พบ / จุดค้าง / อุปกรณ์ที่ต้องเปลี่ยน — 1 แถวต่อ 1 จุด หรือ 1 รายการอุปกรณ์",
        items: {
          type: "object",
          properties: {
            location: str("ตำแหน่ง อาคาร/ชั้น/ห้อง/Loop ตามที่เขียน ไม่มีให้ใส่ค่าว่าง"),
            problem: str("อาการ/ปัญหา"),
            part: str("อุปกรณ์/รุ่นที่ต้องเปลี่ยน (ตัวพิมพ์ใหญ่ตามรุ่น เช่น SIGA-OSD) ไม่มีให้ใส่ค่าว่าง"),
            qty: str("จำนวน + หน่วย เช่น '85 ตัว' ไม่มีให้ใส่ค่าว่าง"),
            status: { type: "string", enum: ISSUE_STATUSES, description: "แก้แล้ว / ยังค้าง / ต้องเสนอราคา (ต้องเปลี่ยน/ซื้ออุปกรณ์) / ไม่ระบุ" },
          },
          required: ["location", "problem", "part", "qty", "status"],
        },
      },
      reviewNotes: strArr("สิ่งที่คนควรตรวจซ้ำ: คำ/ตัวเลขที่อ่านไม่ชัด ลายมือกำกวม ข้อมูลขัดกัน (ภาษาไทยสั้นๆ ระบุว่าไฟล์ไหน)"),
      confidence: { type: "string", enum: ["high", "medium", "low"], description: "ความมั่นใจโดยรวมในการอ่าน" },
    },
    required: ["found", "summary", "workDone", "issueSummary", "issues", "reviewNotes", "confidence"],
  },
};

const SYSTEM = `คุณคือวิศวกรผู้ตรวจรายงานของบริษัทรับเหมางานระบบอาคาร (Fire Alarm, CCTV, Access Control ฯลฯ) ในประเทศไทย
จะได้รับไฟล์ใบ Service Report (รายงานบริการ) ของงานเดียวกัน — ส่วนใหญ่เป็นรูปถ่ายใบที่ช่างเขียนด้วยลายมือ อาจหลายหน้า/หลายแผ่น/แผ่นต่อ
แต่ละไฟล์มีป้าย "ไฟล์ที่ N" · รูปยาวอาจถูกตัดเป็นหลายช่วงต่อกันจากบนลงล่าง
ให้อ่านทุกไฟล์รวมกันเป็นงานเดียว แล้วบันทึกผ่านเครื่องมือ record_service_report (ต้องเรียกเครื่องมือเสมอ)

อ่านเฉพาะ "เนื้อหา" ของใบ:
- อ่าน: รายละเอียดงานที่ทำ · ผลตรวจเช็ค/ตัวเลขสถานะระบบที่เขียนในเนื้อหา · ปัญหาที่พบ · อุปกรณ์ที่ต้องเปลี่ยน · จุดที่ยังค้าง
- ไม่ต้องอ่าน หัวกระดาษ: ชื่อบริษัท โลโก้ เลขที่ใบ โครงการ วันที่ เวลาเข้า-ออก ผู้ติดต่อ เบอร์โทร ช่องติ๊กประเภทงาน/ระบบ
- ไม่ต้องอ่าน ท้ายกระดาษ: ลายเซ็น ชื่อช่าง ชื่อ/ความเห็นลูกค้า วันที่ลงชื่อ
- แผ่นต่อที่มีหัวกระดาษซ้ำ ให้ข้ามหัว/ท้ายเช่นกัน อ่านแค่เนื้อหาต่อจากแผ่นก่อน

กติกาที่ห้ามพลาด:
- ถอดตามที่เขียนจริงเท่านั้น ห้ามแต่งข้อเท็จจริง ตัวเลข ชื่อรุ่น หรือจำนวนขึ้นเอง · คำที่อ่านไม่ชัดให้ใส่ตามที่อ่านได้แล้วระบุใน reviewNotes
- workDone เขียนให้คนนอกอ่านเข้าใจ (แก้คำย่อ/สะกดผิด เช่น "ต.ร.ว." → "ตรวจ") แต่ความหมายต้องตรงต้นฉบับ · ตัวเลขเช่น "Trouble 291 เหลือ 174 จุด" ให้คงไว้ในข้อนั้น
- รายการอุปกรณ์ที่ต้องเปลี่ยนพร้อมจำนวน ให้แยกเป็นแถวใน issues คนละแถว · จุดที่ยังค้าง (เช่น Alarm ค้างห้อง 911) ก็เป็นแถวใน issues
- ใบเก่าที่เขียนรวมกันในช่องเดียว ให้แยกเองว่าประโยคไหนคืองานที่ทำ และประโยคไหนคือปัญหา
- ไม่ใช่ใบ Service Report หรืออ่านเนื้อหาไม่ได้เลย ให้ found = false และอธิบายใน reviewNotes`;

const scannableFiles = (files) => (files || []).filter((f) => f?.fileUrl && (isPdfFile(f) || isImageFile(f))).slice(0, MAX_FILES);

/**
 * @param {Array<{fileName, fileUrl, fileType}>} files ไฟล์ Service Report ทั้งงาน (เรียงตามเวลาแนบ)
 * @returns {Promise<object>} ข้อมูลตาม SUMMARY_TOOL + fileCount
 */
async function scanServiceReport(files) {
  const list = scannableFiles(files);
  if (!list.length) return { ...normalize({ found: false, reviewNotes: ["ไม่มีไฟล์รูปหรือ PDF ให้อ่าน"] }), fileCount: 0 };
  const content = [];
  for (let i = 0; i < list.length; i += 1) {
    content.push({ type: "text", text: `ไฟล์ที่ ${i + 1}: ${list[i].fileName || ""}` });
    content.push(...(await toContentBlocks(list[i])));
  }
  content.push({ type: "text", text: `รวม ${list.length} ไฟล์ — อ่านเฉพาะเนื้อหา (งานที่ทำ + ปัญหาที่พบ) ทั้งหมดเป็นงานเดียว แล้วบันทึกผ่านเครื่องมือ record_service_report` });

  const res = await createMessage(getClient(), {
    model: MODEL,
    max_tokens: 10000,
    system: SYSTEM,
    tools: [SUMMARY_TOOL],
    tool_choice: { type: "auto" },
    messages: [{ role: "user", content }],
  });
  const call = res.content.find((b) => b.type === "tool_use" && b.name === SUMMARY_TOOL.name);
  if (!call) {
    const err = new Error("no tool call");
    err.userMessage = res.stop_reason === "refusal" ? "AI ปฏิเสธการอ่านไฟล์นี้" : "AI ไม่ได้ส่งผลสรุปกลับมา กรุณาลองใหม่";
    throw err;
  }
  return { ...normalize(call.input || {}), fileCount: list.length };
}

/** กันค่าแปลกจากโมเดล/หน้าจอ — ทุกช่องเป็นชนิดที่หน้าจอ/PDF/Excel คาดไว้เสมอ */
function normalize(d) {
  const s = (v, max = 500) => String(v ?? "").trim().slice(0, max);
  const arr = (v) => (Array.isArray(v) ? v : []);
  const sArr = (v, max = 600) => arr(v).map((x) => s(x, max)).filter(Boolean);
  const pick = (v, list, def) => (list.includes(v) ? v : def);
  return {
    found: d.found !== false,
    summary: s(d.summary, 2000),
    workDone: sArr(d.workDone, 800).slice(0, 60),
    issueSummary: s(d.issueSummary, 1500),
    issues: arr(d.issues).map((x) => ({
      location: s(x?.location, 160), problem: s(x?.problem, 300), part: s(x?.part, 160), qty: s(x?.qty, 40),
      status: pick(x?.status, ISSUE_STATUSES, "unknown"),
    })).filter((x) => x.problem || x.part).slice(0, 200),
    reviewNotes: sArr(d.reviewNotes, 300).slice(0, 12),
    confidence: pick(d.confidence, ["high", "medium", "low"], "medium"),
  };
}

module.exports = { scanServiceReport, normalize, scannableFiles, MODEL };
