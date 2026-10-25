/**
 * ServiceReportScan.js — ให้ AI อ่านใบ Service Report ที่ช่างแนบ (รูปถ่าย/สแกน/PDF · ลายมือ) แล้วสรุปเป็นข้อมูลมีโครงสร้าง
 *
 * ✅ (25 ต.ค. 2569 ผู้ใช้: "ทำระบบให้อ่าน Service Report ของช่าง แล้วให้กดสร้างสรุปออกมาเป็น PDF ทำให้สมบูรณ์ที่สุด")
 *    • อ่าน "ทุกไฟล์" ของงานพร้อมกัน (ใบเดียวมักหลายหน้า/หลายรูป · มีแผ่นต่อ · งานหลายวันมีหลายใบ)
 *    • หัวข้อตรงกับฟอร์ม Service Report ใหม่ของบริษัท: ข้อมูลงาน · สถานะระบบก่อน/หลัง · ตรวจเช็คพื้นฐาน ·
 *      รายละเอียดงานที่ทำ · ปัญหาที่พบ/อุปกรณ์ที่ต้องเปลี่ยน · สรุปผล · ลงชื่อ — ใช้ได้กับใบแบบเก่า (เขียนอิสระ) ด้วย
 *    • นอกจากถอดข้อความ ยังเขียน "บทสรุปสำหรับผู้บริหาร/ลูกค้า" + ข้อเสนอแนะ ให้พร้อมใส่ในรายงาน PDF
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

const str = (description) => ({ type: "string", description });
const strArr = (description) => ({ type: "array", items: { type: "string" }, description });

const SUMMARY_TOOL = {
  name: "record_service_report",
  description: "บันทึกข้อมูลที่อ่านได้จากใบ Service Report ทุกไฟล์ของงานนี้ พร้อมบทสรุป",
  input_schema: {
    type: "object",
    properties: {
      found: { type: "boolean", description: "ไฟล์เป็นใบ Service Report/รายงานบริการจริงและอ่านได้หรือไม่" },
      job: {
        type: "object",
        properties: {
          dates: {
            type: "array",
            description: "วันที่เข้างานแต่ละวันตามที่เขียน (งานหลายวันมีหลายแถว)",
            items: {
              type: "object",
              properties: {
                date: str("YYYY-MM-DD (แปลง พ.ศ. เป็น ค.ศ. · ปี 2 หลักเช่น 69 = 2569 = 2026) ไม่ชัดให้ใส่ค่าว่าง"),
                timeIn: str("เวลาเข้า HH:MM (24 ชม.) ไม่มีให้ใส่ค่าว่าง"),
                timeOut: str("เวลาออก HH:MM (24 ชม.) ไม่มีให้ใส่ค่าว่าง"),
              },
              required: ["date", "timeIn", "timeOut"],
            },
          },
          jobType: str("ประเภทงานตามที่ติ๊ก/เขียน เช่น PM · Service · ติดตั้ง · ตรวจสอบ"),
          pmRound: str("ครั้งที่ของ PM เช่น 1/4 ไม่มีให้ใส่ค่าว่าง"),
          project: str("โครงการ/อาคาร/สถานที่"),
          system: str("ระบบ เช่น Fire Alarm (FA) · CCTV"),
          contactName: str("ผู้ติดต่อฝั่งลูกค้า"),
          contactPosition: str("ตำแหน่งผู้ติดต่อ"),
          contactPhone: str("เบอร์โทรผู้ติดต่อ"),
        },
        required: ["dates", "jobType", "pmRound", "project", "system", "contactName", "contactPosition", "contactPhone"],
      },
      systemStatus: {
        type: "array",
        description: "ตัวเลขสถานะระบบ ก่อนเข้า → หลังเสร็จ (เช่น Alarm · Trouble · Disable) ทั้งจากตารางและที่เขียนในเนื้อหา เช่น 'Trouble 291 เหลือ 174'",
        items: {
          type: "object",
          properties: { item: str("ชื่อรายการ"), before: str("ค่าก่อนเข้า (ตามที่เขียน)"), after: str("ค่าหลังเสร็จ (ตามที่เขียน)") },
          required: ["item", "before", "after"],
        },
      },
      checks: {
        type: "array",
        description: "ผลตรวจเช็คพื้นฐาน เช่น ไฟ AC 220V · ไฟ DC 24V · แบตเตอรี่ 12V 40AH 2 ลูก ปีผลิต 8/23",
        items: {
          type: "object",
          properties: {
            item: str("รายการ"),
            value: str("ค่าที่วัด/ข้อมูล"),
            result: { type: "string", enum: ["normal", "abnormal", "unknown"], description: "ผล: ปกติ / ผิดปกติ / ไม่ระบุ" },
          },
          required: ["item", "value", "result"],
        },
      },
      workDone: strArr("งานที่ทำ เรียงตามลำดับ ประโยคละ 1 เรื่อง เขียนให้อ่านรู้เรื่อง สุภาพ (แก้คำย่อ/คำสะกดผิดได้ แต่ห้ามเพิ่มข้อเท็จจริงที่ไม่มีในเอกสาร)"),
      issues: {
        type: "array",
        description: "ปัญหาที่พบ / จุดค้าง / อุปกรณ์ที่ต้องเปลี่ยน — 1 แถวต่อ 1 จุดหรือ 1 รายการอุปกรณ์",
        items: {
          type: "object",
          properties: {
            location: str("ตำแหน่ง อาคาร/ชั้น/ห้อง/Loop ตามที่เขียน ไม่มีให้ใส่ค่าว่าง"),
            problem: str("อาการ/ปัญหา"),
            part: str("อุปกรณ์/รุ่นที่ต้องเปลี่ยน (ตัวพิมพ์ใหญ่ตามรุ่น เช่น SIGA-OSD) ไม่มีให้ใส่ค่าว่าง"),
            qty: str("จำนวน + หน่วย เช่น '85 ตัว' ไม่มีให้ใส่ค่าว่าง"),
            status: { type: "string", enum: ["fixed", "pending", "need_quote", "unknown"], description: "แก้แล้ว / ยังค้าง / ต้องเสนอราคา / ไม่ระบุ" },
          },
          required: ["location", "problem", "part", "qty", "status"],
        },
      },
      result: { type: "string", enum: ["normal", "working_with_issues", "not_working", "unknown"], description: "ผลการทำงานโดยรวม" },
      followUp: {
        type: "object",
        properties: {
          revisit: { type: "boolean", description: "ต้องเข้าอีกหรือไม่" },
          revisitDate: str("วันที่นัดเข้าอีก YYYY-MM-DD ไม่มีให้ใส่ค่าว่าง"),
          needQuotation: { type: "boolean", description: "ต้องทำใบเสนอราคาหรือไม่ (ติ๊กไว้ หรือเขียนว่ารอเสนอราคา/ต้องเปลี่ยนอุปกรณ์)" },
          coordinateWith: str("ประสานงานกับใคร เช่น ช่างโครงการ"),
        },
        required: ["revisit", "revisitDate", "needQuotation", "coordinateWith"],
      },
      customer: {
        type: "object",
        properties: {
          comment: str("ความเห็นลูกค้า ไม่มีให้ใส่ค่าว่าง"),
          signed: { type: "boolean", description: "มีลายเซ็นลูกค้าหรือไม่" },
          name: str("ชื่อลูกค้าที่เขียนในวงเล็บ อ่านไม่ออกให้ใส่ค่าว่าง"),
          signDate: str("วันที่ลูกค้าเซ็น YYYY-MM-DD ไม่มีให้ใส่ค่าว่าง"),
        },
        required: ["comment", "signed", "name", "signDate"],
      },
      technicians: strArr("ชื่อช่างผู้ให้บริการ (อ่านไม่ออกให้ข้าม)"),
      summary: str("บทสรุปสำหรับผู้บริหาร/ลูกค้า ภาษาไทยทางการ 3–5 ประโยค: เข้าทำอะไร ผลเป็นอย่างไร (มีตัวเลขก่อน→หลังถ้ามี) ยังเหลืออะไร ต้องทำอะไรต่อ"),
      highlights: strArr("ประเด็นสำคัญ 2–5 ข้อ สั้นๆ"),
      recommendations: strArr("ข้อเสนอแนะ/สิ่งที่ควรดำเนินการต่อ อิงจากเอกสารเท่านั้น (เช่น เปลี่ยนอุปกรณ์ตามรายการ · นัดเข้าแก้จุดค้าง · ประสานช่างโครงการ)"),
      reviewNotes: strArr("สิ่งที่คนควรตรวจซ้ำ: คำ/ตัวเลขที่อ่านไม่ชัด ลายมือกำกวม ข้อมูลขัดกัน (ภาษาไทยสั้นๆ ระบุว่าไฟล์ไหน)"),
      confidence: { type: "string", enum: ["high", "medium", "low"], description: "ความมั่นใจโดยรวมในการอ่าน" },
    },
    required: ["found", "job", "systemStatus", "checks", "workDone", "issues", "result", "followUp", "customer", "technicians", "summary", "highlights", "recommendations", "reviewNotes", "confidence"],
  },
};

const SYSTEM = `คุณคือวิศวกรผู้ตรวจรายงานของบริษัทรับเหมางานระบบอาคาร (Fire Alarm, CCTV, Access Control ฯลฯ) ในประเทศไทย
จะได้รับไฟล์ใบ Service Report (รายงานบริการ) ของงานเดียวกัน — ส่วนใหญ่เป็นรูปถ่ายใบที่ช่างเขียนด้วยลายมือ อาจหลายหน้า/หลายแผ่น/แผ่นต่อ
แต่ละไฟล์มีป้าย "ไฟล์ที่ N" · รูปยาวอาจถูกตัดเป็นหลายช่วงต่อกันจากบนลงล่าง
ให้อ่านทุกไฟล์รวมกันเป็นงานเดียว แล้วบันทึกผ่านเครื่องมือ record_service_report (ต้องเรียกเครื่องมือเสมอ)

กติกาที่ห้ามพลาด:
- ถอดตามที่เขียนจริงเท่านั้น ห้ามแต่งข้อเท็จจริง ตัวเลข ชื่อรุ่น หรือจำนวนขึ้นเอง · คำที่อ่านไม่ชัดให้ใส่ตามที่อ่านได้แล้วระบุใน reviewNotes
- ตัวเลขสถานะระบบ (Alarm/Trouble/Disable ฯลฯ) ที่เขียนในเนื้อหา เช่น "Trouble 291 point ... เหลือ 174 point" ให้ดึงไปใส่ systemStatus (ก่อน = ค่าแรก หลัง = ค่าสุดท้าย)
- รายการอุปกรณ์ที่ต้องเปลี่ยนพร้อมจำนวน ให้แยกเป็นแถวใน issues คนละแถว · จุดที่ยังค้าง (เช่น Alarm ค้างห้อง 911) ก็เป็นแถวใน issues
- ใบเก่าที่เขียนรวมกันในช่องเดียว ให้แยกเองว่าประโยคไหนคืองานที่ทำ ผลตรวจ ปัญหา หรือสิ่งที่ต้องทำต่อ
- workDone เขียนให้คนนอกอ่านเข้าใจ (แก้คำย่อ/สะกดผิด เช่น "ต.ร.ว." → "ตรวจ") แต่ความหมายต้องตรงต้นฉบับ
- ปี พ.ศ. ต้องลบ 543 เป็น ค.ศ. (ปีย่อ 2 หลัก เช่น 69 = พ.ศ. 2569 = ค.ศ. 2026)
- ไม่ใช่ใบ Service Report หรืออ่านไม่ได้เลย ให้ found = false และอธิบายใน reviewNotes`;

const scannableFiles = (files) => (files || []).filter((f) => f?.fileUrl && (isPdfFile(f) || isImageFile(f))).slice(0, MAX_FILES);

/**
 * @param {Array<{fileName, fileUrl, fileType}>} files ไฟล์ Service Report ทั้งงาน (เรียงตามเวลาแนบ)
 * @returns {Promise<object>} ข้อมูลตาม SUMMARY_TOOL + fileCount
 */
async function scanServiceReport(files) {
  const list = scannableFiles(files);
  if (!list.length) return { found: false, fileCount: 0, reviewNotes: ["ไม่มีไฟล์รูปหรือ PDF ให้อ่าน"] };
  const content = [];
  for (let i = 0; i < list.length; i += 1) {
    content.push({ type: "text", text: `ไฟล์ที่ ${i + 1}: ${list[i].fileName || ""}` });
    content.push(...(await toContentBlocks(list[i])));
  }
  content.push({ type: "text", text: `รวม ${list.length} ไฟล์ — อ่านทั้งหมดเป็นงานเดียว แล้วบันทึกผ่านเครื่องมือ record_service_report` });

  const res = await createMessage(getClient(), {
    model: MODEL,
    max_tokens: 12000,
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

/** กันค่าแปลกจากโมเดล — ทุกช่องเป็นชนิดที่หน้าจอ/PDF คาดไว้เสมอ */
function normalize(d) {
  const s = (v, max = 500) => String(v ?? "").trim().slice(0, max);
  const arr = (v) => (Array.isArray(v) ? v : []);
  const sArr = (v, max = 600) => arr(v).map((x) => s(x, max)).filter(Boolean);
  const pick = (v, list, def) => (list.includes(v) ? v : def);
  const job = d.job || {};
  return {
    found: d.found !== false,
    job: {
      dates: arr(job.dates).map((x) => ({ date: s(x?.date, 10), timeIn: s(x?.timeIn, 5), timeOut: s(x?.timeOut, 5) })).filter((x) => x.date || x.timeIn || x.timeOut),
      jobType: s(job.jobType, 60), pmRound: s(job.pmRound, 20), project: s(job.project, 200), system: s(job.system, 120),
      contactName: s(job.contactName, 120), contactPosition: s(job.contactPosition, 120), contactPhone: s(job.contactPhone, 40),
    },
    systemStatus: arr(d.systemStatus).map((x) => ({ item: s(x?.item, 80), before: s(x?.before, 40), after: s(x?.after, 40) })).filter((x) => x.item),
    checks: arr(d.checks).map((x) => ({ item: s(x?.item, 120), value: s(x?.value, 160), result: pick(x?.result, ["normal", "abnormal", "unknown"], "unknown") })).filter((x) => x.item),
    workDone: sArr(d.workDone),
    issues: arr(d.issues).map((x) => ({
      location: s(x?.location, 160), problem: s(x?.problem, 300), part: s(x?.part, 160), qty: s(x?.qty, 40),
      status: pick(x?.status, ["fixed", "pending", "need_quote", "unknown"], "unknown"),
    })).filter((x) => x.problem || x.part),
    result: pick(d.result, ["normal", "working_with_issues", "not_working", "unknown"], "unknown"),
    followUp: {
      revisit: Boolean(d.followUp?.revisit), revisitDate: s(d.followUp?.revisitDate, 10),
      needQuotation: Boolean(d.followUp?.needQuotation), coordinateWith: s(d.followUp?.coordinateWith, 160),
    },
    customer: { comment: s(d.customer?.comment, 600), signed: Boolean(d.customer?.signed), name: s(d.customer?.name, 120), signDate: s(d.customer?.signDate, 10) },
    technicians: sArr(d.technicians, 80).slice(0, 8),
    summary: s(d.summary, 2000),
    highlights: sArr(d.highlights, 300).slice(0, 8),
    recommendations: sArr(d.recommendations, 400).slice(0, 10),
    reviewNotes: sArr(d.reviewNotes, 300).slice(0, 12),
    confidence: pick(d.confidence, ["high", "medium", "low"], "medium"),
  };
}

module.exports = { scanServiceReport, normalize, scannableFiles, MODEL };
