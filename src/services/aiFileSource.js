/**
 * aiFileSource.js — เตรียมไฟล์บน Cloudinary ให้ Claude อ่าน (ใช้ร่วม InvoiceScan / QuotationScan)
 *
 * 🐛 (19 ต.ค. 2569 ผู้ใช้: "ขึ้นอ่านไม่สำเร็จทุกอัน") เดิมส่ง URL ให้ Claude ไปดึงไฟล์เอง — ไฟล์ "raw" (PDF) บน Cloudinary
 *    และรูปมือถือขนาดใหญ่ (เกิน 5MB/8000px) ถูกปฏิเสธ → ดึงไฟล์ที่เซิร์ฟเวอร์เราเองแล้วส่งเป็น base64 แทน
 *    • รูป: ขอเวอร์ชันย่อจาก Cloudinary (กว้าง 1800px · JPEG) — ตัวหนังสือยังคม ไฟล์เล็ก อ่านเร็ว ประหยัดเครดิต
 *    • PDF: ส่งทั้งไฟล์เป็น document (จำกัด 20MB)
 */
const MAX_PDF = 20 * 1024 * 1024;

const isPdfFile = (f) => /pdf/i.test(f?.fileType || "") || /\.pdf$/i.test(f?.fileName || "") || /\.pdf(\?|$)/i.test(f?.fileUrl || "");
const isImageFile = (f) => /^image\//.test(f?.fileType || "") || /\.(png|jpe?g|webp|gif|heic|heif)$/i.test(f?.fileName || "");

/** URL รูปย่อของ Cloudinary (image/upload เท่านั้น) */
const shrinkUrl = (url) => (/\/image\/upload\//.test(url || "") ? url.replace("/image/upload/", "/image/upload/c_limit,w_1800,h_2600,q_auto:good,f_jpg/") : url);

/**
 * @returns {Promise<object>} content block ของ Claude (image/document แบบ base64)
 */
async function toContentBlock(file) {
  let pdf = isPdfFile(file);
  let res = await fetch(pdf ? file.fileUrl : shrinkUrl(file.fileUrl));
  // บัญชี Cloudinary ที่ปิด "ส่งไฟล์ PDF" จะตอบ 401 — ขอหน้าแรกเป็นรูป JPEG แทน (Cloudinary แปลงให้ได้)
  if (pdf && !res.ok && /\/image\/upload\//.test(file.fileUrl || "")) {
    res = await fetch(shrinkUrl(file.fileUrl.replace("/image/upload/", "/image/upload/pg_1/")).replace(/\.pdf(\?|$)/i, ".jpg$1"));
    pdf = false;
  }
  if (!res.ok) throw Object.assign(new Error(`ดึงไฟล์ไม่สำเร็จ (${res.status})`), { userMessage: "ดึงไฟล์จากที่เก็บไม่สำเร็จ" });
  const buf = Buffer.from(await res.arrayBuffer());
  if (pdf) {
    if (buf.length > MAX_PDF) throw Object.assign(new Error("PDF ใหญ่เกิน"), { userMessage: "ไฟล์ PDF ใหญ่เกิน 20MB" });
    return { type: "document", source: { type: "base64", media_type: "application/pdf", data: buf.toString("base64") } };
  }
  let mediaType = (res.headers.get("content-type") || "").split(";")[0];
  if (!/^image\/(jpeg|png|gif|webp)$/.test(mediaType)) mediaType = "image/jpeg";
  return { type: "image", source: { type: "base64", media_type: mediaType, data: buf.toString("base64") } };
}

/**
 * 🐛 (19 ต.ค. 2569 ผู้ใช้: "ราคาไม่ตรงมั่ว · เลขที่ด้วย") ภาพหน้าจอมือถือแนวตั้งยาว ถูก AI ย่อเหลือด้านยาว ~1568px
 *    ตัวเลขเล็กจนอ่านผิด → ตัดรูปยาวเป็นช่วงๆ (ซ้อนกันเล็กน้อย) ส่งทีละช่วงให้ตัวหนังสือใหญ่พอ
 *    ขนาดจริงของรูปถามจาก Cloudinary (fl_getinfo) · ตัดด้วย c_crop ที่ Cloudinary ไม่ต้องมีไลบรารีรูปในเซิร์ฟเวอร์
 */
async function imageSize(url) {
  if (!/\/image\/upload\//.test(url || "")) return null;
  try {
    const r = await fetch(url.replace("/image/upload/", "/image/upload/fl_getinfo/"));
    if (!r.ok) return null;
    const j = await r.json();
    return j?.input?.width && j?.input?.height ? { w: j.input.width, h: j.input.height } : null;
  } catch { return null; }
}

const fetchImageBlock = async (url) => {
  const res = await fetch(url);
  if (!res.ok) throw Object.assign(new Error(`ดึงไฟล์ไม่สำเร็จ (${res.status})`), { userMessage: "ดึงไฟล์จากที่เก็บไม่สำเร็จ" });
  return { type: "image", source: { type: "base64", media_type: "image/jpeg", data: Buffer.from(await res.arrayBuffer()).toString("base64") } };
};

/**
 * @returns {Promise<object[]>} content blocks ของไฟล์เดียว — รูปยาวได้หลายช่วง (บนลงล่าง) · PDF/รูปปกติได้ 1 ชิ้น
 */
async function toContentBlocks(file) {
  if (isPdfFile(file)) return [await toContentBlock(file)];
  const size = await imageSize(file.fileUrl);
  if (!size || size.h / size.w <= 1.5) return [await toContentBlock(file)];
  const tileH = Math.round(size.w * 1.2);
  const overlap = Math.round(size.w * 0.12);
  const ys = [];
  for (let y = 0; y < size.h - overlap && ys.length < 5; y += tileH - overlap) ys.push(Math.min(y, Math.max(0, size.h - tileH)));
  return Promise.all([...new Set(ys)].map((y) => fetchImageBlock(file.fileUrl.replace("/image/upload/",
    `/image/upload/c_crop,x_0,y_${y},w_${size.w},h_${Math.min(tileH, size.h - y)}/c_limit,w_1400,h_1700,q_auto:good,f_jpg/`))));
}

/** เรียก AI · ถ้ารุ่นไม่รับการบังคับเครื่องมือ (tool_choice) ลองใหม่แบบ auto อีกครั้ง */
async function createMessage(client, params) {
  try {
    return await client.messages.create(params);
  } catch (err) {
    const msg = String(err?.error?.error?.message || err?.message || "");
    if (err?.status === 400 && params.tool_choice && /tool_choice|tool choice/i.test(msg)) {
      return client.messages.create({ ...params, tool_choice: { type: "auto" } });
    }
    throw err;
  }
}

/** ข้อความ error ที่ปลอดภัยให้หน้าจอ (ไม่มีคีย์/รายละเอียดคำขอ) */
const safeAiError = (err) => {
  if (err?.userMessage) return err.userMessage;
  const status = err?.status;
  if (status === 401) return "คีย์ AI ไม่ถูกต้อง (ANTHROPIC_API_KEY)";
  if (status === 402 || /credit balance/i.test(err?.message || "")) return "เครดิต AI หมด — เติมเครดิตที่ console.anthropic.com";
  if (status === 404) return "ไม่พบรุ่น AI ที่ตั้งไว้";
  if (status === 429) return "ใช้งาน AI ถี่เกินไป ลองใหม่อีกครั้ง";
  // 🐛 (19 ต.ค. 2569 ผู้ใช้: "อ่านไม่ได้ซักไฟล์") ข้อความจาก API (ภาษาอังกฤษ) ไม่มีคีย์ปน — แนบท้ายให้เห็นสาเหตุจริง
  const apiMsg = String(err?.error?.error?.message || "").replace(/sk-ant-[\w-]+/g, "***").slice(0, 180);
  if (status === 400) return `AI อ่านไฟล์นี้ไม่ได้${apiMsg ? ` (${apiMsg})` : ""}`;
  return `อ่านไฟล์ไม่สำเร็จ${status ? ` [${status}]` : ""}${apiMsg ? ` (${apiMsg})` : ""} กรุณาลองใหม่หรือกรอกเอง`;
};

module.exports = { toContentBlock, toContentBlocks, createMessage, isPdfFile, isImageFile, safeAiError };
