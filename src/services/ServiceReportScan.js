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
 * 💰 (25 ต.ค. 2569 ผู้ใช้: "ทำให้ประหยัดขึ้น 2 เท่า" · "แต่ยังอ่านรายละเอียดชัด ไม่เพี้ยนนะ")
 *    ส่วนที่แพงที่สุดคือ "ข้อความขาออก" ($10/ล้าน token เทียบขาเข้า $2) ไม่ใช่รูป จึงลดตรงนั้น:
 *    • การคิดก่อนตอบ: adaptive + effort "medium" (เดิมค่าเริ่มต้น high คิดยาวทุกครั้ง) — ยังคิดได้เมื่อใบยาก
 *    • ผลลัพธ์กระชับ: ห้ามเขียนซ้ำระหว่างสรุปกับรายข้อ · จุดที่ต้องตรวจเฉพาะที่สงสัยจริง
 *    • คำสั่ง/คำอธิบายช่องสั้นลง (ส่งทุกครั้ง)
 *    • ⚠️ "ไม่ย่อรูป" โดยตั้งใจ — ลายมือ/ตัวเลขเล็กต้องคมเท่าเดิม
 *    • บันทึก token และค่าใช้จ่ายจริงทุกครั้ง (usage) — หน้าจอแสดงให้เห็น ใช้ตรวจว่าประหยัดได้จริง
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
  description: "บันทึกเนื้อหางานที่ทำและปัญหาที่พบ จาก Service Report ทุกไฟล์ของงานนี้",
  input_schema: {
    type: "object",
    properties: {
      found: { type: "boolean", description: "เป็นใบ Service Report และอ่านเนื้อหาได้" },
      summary: str("สรุปงานที่ทำ 1–2 ประโยค (มีตัวเลขก่อน/หลังถ้าเขียนไว้)"),
      workDone: strArr("งานที่ทำตามลำดับ ข้อละ 1 ประโยคสั้น ไม่ซ้ำกับ summary"),
      issueSummary: str("สรุปปัญหาที่พบ 1–2 ประโยค · ไม่มีปัญหาให้ค่าว่าง"),
      issues: {
        type: "array",
        description: "1 แถว = 1 จุด หรือ 1 รายการอุปกรณ์",
        items: {
          type: "object",
          properties: {
            location: str("ตำแหน่ง ไม่มีให้ค่าว่าง"),
            problem: str("อาการ/ปัญหา"),
            part: str("อุปกรณ์/รุ่น ไม่มีให้ค่าว่าง"),
            qty: str("จำนวน+หน่วย เช่น '85 ตัว' ไม่มีให้ค่าว่าง"),
            status: { type: "string", enum: ISSUE_STATUSES, description: "แก้แล้ว/ยังค้าง/ต้องเสนอราคา/ไม่ระบุ" },
          },
          required: ["location", "problem", "part", "qty", "status"],
        },
      },
      reviewNotes: strArr("เฉพาะจุดที่อ่านไม่ชัด/กำกวมจริง ระบุไฟล์ สั้นๆ ไม่เกิน 5 ข้อ"),
      confidence: { type: "string", enum: ["high", "medium", "low"] },
    },
    required: ["found", "summary", "workDone", "issueSummary", "issues", "reviewNotes", "confidence"],
  },
};

const SYSTEM = `คุณถอดใบ Service Report (ลายมือ งานระบบอาคาร Fire Alarm/CCTV ฯลฯ) ของงานเดียวกัน อาจหลายไฟล์/หลายแผ่น (ป้าย "ไฟล์ที่ N" · รูปยาวถูกตัดเป็นช่วงบนลงล่าง)
อ่านทุกไฟล์รวมเป็นงานเดียว แล้วเรียกเครื่องมือ record_service_report เสมอ

อ่านเฉพาะเนื้อหา: งานที่ทำ ผลตรวจ ตัวเลขสถานะระบบ ปัญหา อุปกรณ์ที่ต้องเปลี่ยน จุดค้าง
ข้าม: หัวกระดาษ (บริษัท เลขที่ โครงการ วันที่ เวลา ผู้ติดต่อ ช่องติ๊ก) และท้ายกระดาษ (ลายเซ็น ชื่อช่าง/ลูกค้า ความเห็นลูกค้า) รวมถึงหัว/ท้ายของแผ่นต่อ

กติกา:
- ถอดตามที่เขียนจริง ตัวเลข/รุ่น/จำนวนต้องตรงต้นฉบับ ห้ามเดา · ไม่ชัดให้ใส่ตามที่อ่านได้แล้วบอกใน reviewNotes
- เขียนให้คนนอกอ่านเข้าใจ (แก้คำย่อ/สะกดผิดได้) กระชับ ไม่ซ้ำความ · คงตัวเลขเช่น "Trouble 291 เหลือ 174 จุด"
- อุปกรณ์ที่ต้องเปลี่ยนแยกแถวละรุ่นใน issues · จุดค้างก็เป็นแถว
- ไม่ใช่ Service Report หรืออ่านไม่ได้ ให้ found = false`;

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

  const params = {
    model: MODEL,
    max_tokens: 8000,
    thinking: { type: "adaptive" },
    output_config: { effort: "medium" },
    system: SYSTEM,
    tools: [SUMMARY_TOOL],
    tool_choice: { type: "auto" },
    messages: [{ role: "user", content }],
  };
  let res;
  try {
    res = await createMessage(getClient(), params);
  } catch (err) {
    // กันรุ่นที่ไม่รับการตั้งระดับการคิด — อ่านต่อได้แบบค่าเริ่มต้น (แพงขึ้นแต่ไม่พัง)
    if (err?.status !== 400 || !/effort|output_config|thinking/i.test(String(err?.error?.error?.message || err?.message || ""))) throw err;
    const { thinking, output_config: oc, ...rest } = params;
    res = await createMessage(getClient(), rest);
  }
  const call = res.content.find((b) => b.type === "tool_use" && b.name === SUMMARY_TOOL.name);
  if (!call) {
    const err = new Error("no tool call");
    err.userMessage = res.stop_reason === "refusal" ? "AI ปฏิเสธการอ่านไฟล์นี้" : "AI ไม่ได้ส่งผลสรุปกลับมา กรุณาลองใหม่";
    throw err;
  }
  return { ...normalize(call.input || {}), fileCount: list.length, usage: usageOf(res.usage) };
}

/** token ที่ใช้จริง + ค่าใช้จ่าย (USD) ตามราคา Sonnet 5.5: เข้า $2 · ออก $10 · เขียนแคช $2.5 · อ่านแคช $0.2 ต่อล้าน token */
function usageOf(u = {}) {
  const input = u.input_tokens || 0;
  const output = u.output_tokens || 0;
  const cacheWrite = u.cache_creation_input_tokens || 0;
  const cacheRead = u.cache_read_input_tokens || 0;
  const costUsd = (input * 2 + output * 10 + cacheWrite * 2.5 + cacheRead * 0.2) / 1e6;
  return { input, output, cacheWrite, cacheRead, costUsd: Math.round(costUsd * 10000) / 10000 };
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
