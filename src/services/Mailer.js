const nodemailer = require("nodemailer");

/**
 * ส่งอีเมล — ใช้กับการแจ้ง "คำขอจากเว็บไซต์" ให้ทีมขาย
 *
 * ⚠️ ไม่ตั้ง SMTP_* = ข้ามการส่งอีเมลเงียบๆ (คืน false) ไม่โยน error
 *    คำขอจากลูกค้ายังถูกบันทึกและแจ้งเตือนในแอปครบ — อีเมลเป็นช่องทางเสริม ห้ามทำให้การรับคำขอพัง
 * ⚠️ สร้าง transporter ครั้งเดียวแล้วใช้ซ้ำ — สร้างใหม่ทุกครั้งเปิดการเชื่อมต่อ SMTP ใหม่ทุกฉบับ ช้าและโดนจำกัด
 */
let transporter = null;

const isConfigured = () =>
  Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);

function getTransporter() {
  if (transporter) return transporter;
  const port = Number(process.env.SMTP_PORT || 587);
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    // 465 = เชื่อมต่อแบบ SSL ตั้งแต่ต้น · พอร์ตอื่น = เริ่มธรรมดาแล้วอัปเกรดเป็น TLS (STARTTLS)
    secure: port === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    // ⚠️ อย่าให้คำขอของลูกค้ารอ SMTP ที่ค้างนานเกินไป
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
  return transporter;
}

/** หนีอักขระ HTML — ข้อความทุกช่องมาจากคนภายนอกผ่านฟอร์มสาธารณะ ห้ามฝังลงอีเมลดิบๆ */
const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/**
 * @param {{ to: string|string[], subject: string, html: string, text: string, replyTo?: string }} mail
 * @returns {Promise<boolean>} ส่งสำเร็จไหม
 */
async function sendMail({ to, subject, html, text, replyTo }) {
  if (!isConfigured()) return false;
  const recipients = (Array.isArray(to) ? to : String(to || "").split(","))
    .map((s) => s.trim())
    .filter(Boolean);
  if (recipients.length === 0) return false;
  try {
    await getTransporter().sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: recipients,
      subject,
      html,
      text,
      ...(replyTo ? { replyTo } : {}),
    });
    return true;
  } catch (err) {
    console.error("❌ ส่งอีเมลไม่สำเร็จ:", err.message);
    return false;
  }
}

module.exports = { sendMail, isConfigured, esc };
