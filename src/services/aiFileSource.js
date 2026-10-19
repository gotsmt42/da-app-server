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

/** ข้อความ error ที่ปลอดภัยให้หน้าจอ (ไม่มีคีย์/รายละเอียดคำขอ) */
const safeAiError = (err) => {
  if (err?.userMessage) return err.userMessage;
  const status = err?.status;
  if (status === 401) return "คีย์ AI ไม่ถูกต้อง (ANTHROPIC_API_KEY)";
  if (status === 402 || /credit balance/i.test(err?.message || "")) return "เครดิต AI หมด — เติมเครดิตที่ console.anthropic.com";
  if (status === 404) return "ไม่พบรุ่น AI ที่ตั้งไว้";
  if (status === 429) return "ใช้งาน AI ถี่เกินไป ลองใหม่อีกครั้ง";
  if (status === 400) return `AI อ่านไฟล์นี้ไม่ได้${/image|pdf|document/i.test(err?.message || "") ? " (รูปแบบ/ขนาดไฟล์)" : ""}`;
  return "อ่านไฟล์ไม่สำเร็จ กรุณาลองใหม่หรือกรอกเอง";
};

module.exports = { toContentBlock, isPdfFile, isImageFile, safeAiError };
