/**
 * CloseCheck.js — ตรวจเอกสารประจำงานด้วย AI ก่อน "ขอปิดงาน"
 *
 * ✅ (26 ต.ค. 2569 ผู้ใช้: "เมื่อมีการอัพใบ Service Report ของช่างเข้ามาแล้วให้ AI อ่านอัตโนมัติ ถ้าตรวจพบอุปกรณ์เสีย
 *    หรือต้องเสนอราคา ต้องบังคับให้อัพใบเสนอราคาก่อนเท่านั้นถึงจะปิดงานได้" · "ตรวจสอบเอกสารที่อัพมาผิดประเภทของแต่ละช่อง
 *    บังคับเลยว่าไม่ให้ปิดงาน อธิบายให้ชัดเจน แต่ยังมีช่องทางขอปิดกับแอดมินได้ถ้าเอกสารนั้นไม่มีจริงๆ" · "ให้ประหยัด token ด้วย")
 *    ผู้ใช้เลือก: ตรวจ "ตอนช่างกดขอปิดงาน" ครั้งเดียวต่องาน · ตรวจประเภทเอกสารด้วย Haiku + รูปย่อ
 *
 *    1) ประเภทเอกสารทุกช่อง (Service Report · ใบเสนอราคา · ใบวางบิล · ใบส่งมอบงาน) — Haiku รูปย่อ (ถูกมาก)
 *       ตอบ "ไม่ตรง" เฉพาะที่ชัดเจน · ไม่แน่ใจ = ไม่บล็อก
 *    2) เนื้อหา Service Report — ใช้สรุปเดิมถ้าไฟล์ไม่เปลี่ยน · ไม่มี/ไฟล์เปลี่ยน = ให้ AI อ่านใหม่ 1 ครั้ง (Sonnet ตามเดิม)
 *       มีรายการ "ต้องเสนอราคา" แต่ยังไม่มีไฟล์ใบเสนอราคา = ปิดงานไม่ได้
 *    💰 ผลเก็บพร้อม "ลายนิ้วมือไฟล์" (key) — ไฟล์ไม่เปลี่ยน = ใช้ผลเดิม ไม่เรียก AI ซ้ำ
 */
const crypto = require("crypto");
const Anthropic = require("@anthropic-ai/sdk");
const { createMessage, isPdfFile, isImageFile } = require("./aiFileSource");

const HAIKU = "claude-haiku-5-5";
const MAX_CLASSIFY = 24;

let client = null;
const getClient = () => {
  if (!client) client = new Anthropic.Anthropic();
  return client;
};

/** ช่องเอกสารประจำงาน — ตรงกับ DOCUMENT_TYPES ฝั่งหน้าจอ */
const SLOTS = [
  { key: "reportFiles", label: "Service Report", expect: "ใบ Service Report / รายงานบริการ / ใบรายงานการเข้าปฏิบัติงานของช่าง (มักเขียนด้วยลายมือ)" },
  { key: "quotationFiles", label: "ใบเสนอราคาเพิ่มเติม", expect: "ใบเสนอราคา (Quotation) — มีรายการสินค้า/ค่าแรง ราคา ยอดรวม", applicable: "quotationApplicable" },
  { key: "invoiceFiles", label: "ใบวางบิล", expect: "ใบวางบิล / ใบแจ้งหนี้ / ใบกำกับภาษี / ใบเสร็จ (เอกสารเรียกเก็บเงิน)", applicable: "invoiceApplicable" },
  { key: "completionFiles", label: "ใบส่งมอบงาน", expect: "ใบส่งมอบงาน / ใบรับมอบงาน ที่ลูกค้าเซ็นรับ", applicable: "completionApplicable" },
];

/** ไฟล์ทั้งหมดของทุกช่องในทุกวันของงาน (ไม่ซ้ำ) */
function collectFiles(sessions) {
  const seen = new Set();
  const out = [];
  SLOTS.forEach((slot) => {
    sessions.flatMap((s) => s[slot.key] || []).forEach((f) => {
      if (!f?.fileUrl || f.supersededAt || seen.has(f.fileUrl)) return; // ใบเสนอราคาฉบับเดิม (ถูกแทนแล้ว) ไม่ตรวจซ้ำ
      seen.add(f.fileUrl);
      out.push({ slot: slot.key, slotLabel: slot.label, fileName: f.fileName || "", fileUrl: f.fileUrl, fileType: f.fileType || "" });
    });
  });
  return out;
}

/** ลายนิ้วมือของชุดไฟล์ + การตั้งค่า "ต้องมี/ไม่ต้องมี" — เปลี่ยนเมื่อไหร่ต้องตรวจใหม่ */
function filesKey(sessions) {
  const a = sessions[0] || {};
  const parts = collectFiles(sessions).map((f) => `${f.slot}|${f.fileUrl}`).sort();
  SLOTS.forEach((s) => s.applicable && parts.push(`${s.applicable}=${a[s.applicable]}`));
  parts.push("rules-v2"); // เปลี่ยนเกณฑ์ตรวจ = ผลเดิมใช้ไม่ได้ ต้องตรวจใหม่
  return crypto.createHash("sha1").update(parts.join("\n")).digest("hex").slice(0, 20);
}

/** รูปย่อสำหรับดูประเภทเอกสาร (ไม่ต้องอ่านตัวหนังสือละเอียด) — ประหยัด token */
const tinyUrl = (url, pdf) => {
  if (!/\/image\/upload\//.test(url || "")) return null;
  let u = url.replace("/image/upload/", `/image/upload/${pdf ? "pg_1," : ""}c_limit,w_640,h_900,q_auto:eco,f_jpg/`);
  if (pdf) u = u.replace(/\.pdf(\?|$)/i, ".jpg$1");
  return u;
};
async function tinyBlock(f) {
  const pdf = isPdfFile(f);
  const small = tinyUrl(f.fileUrl, pdf);
  if (small) {
    const r = await fetch(small);
    if (r.ok) return { type: "image", source: { type: "base64", media_type: "image/jpeg", data: Buffer.from(await r.arrayBuffer()).toString("base64") } };
  }
  if (pdf) {
    // PDF แบบ raw ย่อเป็นรูปไม่ได้ — ส่งทั้งไฟล์ (Haiku ราคาถูก) · ใหญ่เกิน 8MB ข้าม
    const r = await fetch(f.fileUrl);
    if (!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 8 * 1024 * 1024) return null;
    return { type: "document", source: { type: "base64", media_type: "application/pdf", data: buf.toString("base64") } };
  }
  return null;
}

const CLASSIFY_TOOL = {
  name: "record_doc_types",
  description: "บันทึกผลตรวจว่าแต่ละไฟล์ตรงกับประเภทเอกสารของช่องที่แนบหรือไม่",
  input_schema: {
    type: "object",
    properties: {
      files: {
        type: "array",
        items: {
          type: "object",
          properties: {
            no: { type: "integer" },
            matches: { type: "string", enum: ["yes", "no", "unsure"], description: "yes = ตรงช่อง · no = เป็นเอกสารคนละชนิดอย่างชัดเจน · unsure = ดูไม่ออก" },
            detected: { type: "string", description: "ไฟล์นี้คืออะไร สั้นๆ เช่น 'ใบเสนอราคา' 'รูปถ่ายหน้างาน' 'ใบ Service Report'" },
          },
          required: ["no", "matches", "detected"],
        },
      },
    },
    required: ["files"],
  },
};

/** ตรวจประเภทเอกสารทุกไฟล์ในการเรียกครั้งเดียว (Haiku) */
async function classify(files) {
  const list = files.filter((f) => isPdfFile(f) || isImageFile(f)).slice(0, MAX_CLASSIFY);
  if (!list.length) return { results: [], usage: null };
  const content = [];
  for (let i = 0; i < list.length; i += 1) {
    const slot = SLOTS.find((s) => s.key === list[i].slot);
    const block = await tinyBlock(list[i]).catch(() => null);
    content.push({ type: "text", text: `ไฟล์ที่ ${i + 1} — แนบในช่อง "${slot.label}" (ควรเป็น: ${slot.expect})${block ? "" : " · โหลดไฟล์ไม่ได้"}` });
    if (block) content.push(block);
  }
  content.push({ type: "text", text: "ตอบผ่านเครื่องมือ record_doc_types ครบทุกไฟล์" });
  const params = {
    model: HAIKU,
    max_tokens: 1500,
    thinking: { type: "disabled" },
    output_config: { effort: "low" },
    system: "คุณตรวจว่าเอกสารที่ช่างแนบ ตรงกับช่องเอกสารประจำงานหรือไม่ (งานระบบอาคารในไทย) ดูภาพรวมของเอกสาร ไม่ต้องอ่านรายละเอียด\n"
      + "yes = เห็นชัดว่าเป็นเอกสารชนิดนั้นจริง (มีหัวเอกสาร/แบบฟอร์ม/เนื้อหาตรงชนิด)\n"
      + "no = เป็นของอย่างอื่น เช่น ภาพร่าง/แบบแปลน/รูปถ่ายหน้างานหรืออุปกรณ์/เอกสารคนละชนิด/ภาพหน้าจอที่ไม่เกี่ยว\n"
      + "unsure = ภาพไม่ชัด เบลอ มืด หรือดูไม่ออก · เรียกเครื่องมือเสมอ ครบทุกไฟล์",
    tools: [CLASSIFY_TOOL],
    tool_choice: { type: "auto" },
    messages: [{ role: "user", content }],
  };
  let res;
  try {
    res = await createMessage(getClient(), params);
  } catch (err) {
    // รุ่นที่ไม่รับการปิดการคิด/ตั้งระดับ — ส่งใหม่แบบค่าเริ่มต้น (ไม่ปล่อยให้การตรวจล้มทั้งชุด)
    if (err?.status !== 400 || !/thinking|effort|output_config/i.test(String(err?.error?.error?.message || err?.message || ""))) throw err;
    const { thinking, output_config: oc, ...rest } = params;
    res = await createMessage(getClient(), rest);
  }
  const call = res.content.find((b) => b.type === "tool_use" && b.name === CLASSIFY_TOOL.name);
  // ⚠️ ทุกไฟล์ต้องมีผล — ไฟล์ที่ AI ไม่ได้ตอบ = ยืนยันไม่ได้ (ไม่ปล่อยผ่านเงียบๆ)
  const answers = call?.input?.files || [];
  const out = list.map((f, i) => {
    const x = answers.find((a) => Number(a?.no) === i + 1);
    return { ...f, matches: x && ["yes", "no", "unsure"].includes(x.matches) ? x.matches : "unsure", detected: String(x?.detected || (x ? "" : "AI ไม่ได้ตอบไฟล์นี้")).slice(0, 80) };
  });
  const u = res.usage || {};
  // 💰 Haiku 5.5: เข้า $0.10 · ออก $0.50 ต่อล้าน token
  return { results: out, usage: { input: u.input_tokens || 0, output: u.output_tokens || 0, costUsd: Math.round(((u.input_tokens || 0) * 0.1 + (u.output_tokens || 0) * 0.5) / 100) / 10000 } };
}

module.exports = { SLOTS, collectFiles, filesKey, classify, HAIKU };
