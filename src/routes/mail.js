/**
 * ส่งเอกสาร (PDF) ทางอีเมลจากในแอป
 *
 * ✅ ผู้ใช้สั่ง (3 ต.ค. 2569): "เพิ่มระบบส่งอีเมลของเอกสารต่างๆ ให้สามารถแก้ไขรายละเอียดที่จะส่งได้ด้วย"
 *    หน้าเว็บสร้าง PDF เอง (jsPDF ชุดเดียวกับปุ่มพิมพ์/ดาวน์โหลด) แล้วส่งไฟล์ + ผู้รับ/หัวเรื่อง/ข้อความ
 *    ที่ผู้ใช้แก้แล้วมาที่นี่ — server แค่ตรวจ ส่ง และบันทึกประวัติ (models/EmailLog.js)
 *
 *   GET  /api/mail/status    ตั้งค่า SMTP แล้วหรือยัง + ที่อยู่ผู้ส่ง
 *   POST /api/mail/document  ส่งเอกสาร (multipart: file + to/cc/subject/body/docType/docNo/refId/copyMe)
 *   GET  /api/mail/log       ประวัติการส่งของเอกสาร (?refId= หรือ ?docNo=)
 *
 * ⚠️ ข้อความจากผู้ใช้ถูกหนี HTML ทุกตัวก่อนใส่ลงอีเมล — ห้ามรับ HTML ดิบจากหน้าเว็บ
 * ⚠️ ชื่อผู้ส่งเป็นชื่อพนักงาน แต่ที่อยู่ผู้ส่งคือบัญชี SMTP เสมอ · ตอบกลับ (Reply-To) ไปหาพนักงานคนนั้น
 */
const express = require("express");
const multer = require("multer");

const verifyToken = require("../middleware/auth");
const EmailLog = require("../models/EmailLog");
const OrgSetting = require("../models/OrgSetting");
const { sendMailDetailed, isConfigured, fromAddress, esc } = require("../services/Mailer");

const router = express.Router();

const MAX_PDF_MB = 10;
const MAX_RECIPIENTS = 10;
// ✅ กันกดส่งรัวหรือสคริปต์ยิงซ้ำจนบัญชี SMTP โดนระงับ — นับจากประวัติจริงในฐานข้อมูล ไม่หายตอนรีสตาร์ท
const MAX_PER_HOUR = 40;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_PDF_MB * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    const isPdf = file.mimetype === "application/pdf" || /\.pdf$/i.test(file.originalname || "");
    cb(isPdf ? null : new Error("แนบได้เฉพาะไฟล์ PDF"), isPdf);
  },
});

const EMAIL_RE = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]{2,}$/;

/** รับได้ทั้ง array และข้อความคั่นด้วย , ; หรือขึ้นบรรทัด → รายการที่ตัดซ้ำแล้ว (ตัวพิมพ์เล็ก) */
function parseList(v) {
  const raw = Array.isArray(v) ? v : String(v || "").split(/[,;\n]/);
  return [...new Set(raw.map((s) => String(s).trim().toLowerCase()).filter(Boolean))];
}

const fullName = (u) => [u?.fname, u?.lname].filter(Boolean).join(" ").trim() || u?.username || "";

/** ข้อความธรรมดา → HTML (หนีอักขระ + ขึ้นบรรทัด) ห่อด้วยแม่แบบเรียบๆ อ่านง่ายทุกโปรแกรมอีเมล */
function renderHtml({ body, org, attachmentName }) {
  const paragraphs = esc(body).replace(/\r\n/g, "\n").replace(/\n/g, "<br>");
  const orgLine = [org?.nameTh, org?.tel && `โทร ${org.tel}`, org?.email, org?.website].filter(Boolean).map(esc).join(" · ");
  return `<!doctype html><html><body style="margin:0;padding:0;background:#f1f5f9;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:24px 12px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:620px;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;">
<tr><td style="padding:28px 32px;font-family:Tahoma,'Segoe UI',Arial,sans-serif;font-size:15px;line-height:1.7;color:#0f172a;">${paragraphs}</td></tr>
${attachmentName ? `<tr><td style="padding:0 32px 24px;font-family:Tahoma,'Segoe UI',Arial,sans-serif;">
<table role="presentation" cellpadding="0" cellspacing="0" style="border:1px solid #e2e8f0;border-radius:8px;background:#f8fafc;"><tr>
<td style="padding:10px 14px;font-size:13px;color:#334155;">📎 ไฟล์แนบ: <b>${esc(attachmentName)}</b></td></tr></table></td></tr>` : ""}
${orgLine ? `<tr><td style="padding:14px 32px;border-top:1px solid #e2e8f0;font-family:Tahoma,'Segoe UI',Arial,sans-serif;font-size:12px;color:#64748b;">${orgLine}</td></tr>` : ""}
</table></td></tr></table></body></html>`;
}

router.get("/status", verifyToken, (req, res) => {
  res.json({ configured: isConfigured(), from: fromAddress(), maxRecipients: MAX_RECIPIENTS, maxMb: MAX_PDF_MB });
});

router.get("/log", verifyToken, async (req, res) => {
  try {
    const refId = String(req.query.refId || "").trim();
    const docNo = String(req.query.docNo || "").trim();
    if (!refId && !docNo) return res.json([]);
    const or = [];
    if (refId) or.push({ refId });
    if (docNo) or.push({ docNo });
    const rows = await EmailLog.find({ $or: or })
      .sort({ createdAt: -1 })
      .limit(20)
      .select("senderName docType docNo to cc subject attachment status error createdAt")
      .lean();
    res.json(rows);
  } catch (err) {
    console.error("❌ mail log error:", err);
    res.status(500).json({ message: "โหลดประวัติการส่งไม่สำเร็จ" });
  }
});

router.post("/document", verifyToken, (req, res, next) => {
  // ⚠️ ดัก error ของ multer ที่นี่เอง — ข้อความเฉพาะของเส้นนี้ (PDF / 10 MB) ไม่ใช่ข้อความกลาง 15 MB
  upload.single("file")(req, res, (err) => {
    if (!err) return next();
    if (err.code === "LIMIT_FILE_SIZE") return res.status(413).json({ message: `ไฟล์ใหญ่เกิน ${MAX_PDF_MB} MB` });
    return res.status(400).json({ message: err.message || "ไฟล์แนบไม่ถูกต้อง" });
  });
}, async (req, res) => {
  try {
    if (!isConfigured()) {
      return res.status(503).json({ message: "ยังไม่ได้ตั้งค่าเซิร์ฟเวอร์อีเมล — แจ้งผู้ดูแลระบบให้ตั้งค่า SMTP" });
    }
    const to = parseList(req.body.to);
    const cc = parseList(req.body.cc).filter((e) => !to.includes(e));
    const subject = String(req.body.subject || "").trim().slice(0, 250);
    const body = String(req.body.body || "").trim().slice(0, 20000);

    if (!to.length) return res.status(400).json({ message: "ระบุอีเมลผู้รับอย่างน้อย 1 คน" });
    const bad = [...to, ...cc].filter((e) => !EMAIL_RE.test(e));
    if (bad.length) return res.status(400).json({ message: `รูปแบบอีเมลไม่ถูกต้อง: ${bad.join(", ")}` });
    if (to.length + cc.length > MAX_RECIPIENTS) {
      return res.status(400).json({ message: `ส่งได้ครั้งละไม่เกิน ${MAX_RECIPIENTS} ที่อยู่ (รวมสำเนา)` });
    }
    if (!subject) return res.status(400).json({ message: "ระบุหัวเรื่อง" });
    if (!body) return res.status(400).json({ message: "ระบุข้อความ" });
    if (!req.file?.buffer?.length) return res.status(400).json({ message: "ไม่พบไฟล์เอกสารแนบ" });

    const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const recent = await EmailLog.countDocuments({ sender: req.userId, createdAt: { $gte: hourAgo } });
    if (recent >= MAX_PER_HOUR) {
      return res.status(429).json({ message: "ส่งอีเมลถี่เกินไป — รอสักครู่แล้วลองใหม่" });
    }

    const org = await OrgSetting.current().catch(() => null);
    const senderName = fullName(req.user);
    const senderEmail = EMAIL_RE.test(String(req.user?.email || "")) ? req.user.email : "";
    // ✅ "ส่งสำเนาถึงฉัน" = BCC ผู้ส่งเอง (ผู้รับไม่เห็น) — ไว้เก็บหลักฐานในกล่องอีเมลของพนักงาน
    const copyMe = ["1", "true", "on"].includes(String(req.body.copyMe || "").toLowerCase());
    const bcc = copyMe && senderEmail && !to.includes(senderEmail) && !cc.includes(senderEmail) ? [senderEmail] : [];
    // ⚠️ ชื่อไฟล์มาจากเบราว์เซอร์ — ตัดอักขระที่ใช้ในชื่อไฟล์ไม่ได้ทิ้ง กันหัวอีเมลเพี้ยน
    const fileName = String(req.file.originalname || "document.pdf").replace(/[\\/:*?"<>|\r\n]+/g, "_").slice(0, 150) || "document.pdf";

    const result = await sendMailDetailed({
      to,
      cc,
      bcc,
      subject,
      text: body,
      html: renderHtml({ body, org, attachmentName: fileName }),
      replyTo: senderEmail || undefined,
      fromName: [senderName, org?.nameTh].filter(Boolean).join(" · ") || undefined,
      attachments: [{ filename: fileName, content: req.file.buffer, contentType: "application/pdf" }],
    });

    await EmailLog.create({
      sender: req.userId,
      senderName,
      docType: String(req.body.docType || "").slice(0, 80),
      docNo: String(req.body.docNo || "").slice(0, 80),
      refId: String(req.body.refId || "").slice(0, 80),
      to,
      cc,
      subject,
      attachment: { name: fileName, size: req.file.size },
      status: result.ok ? "sent" : "failed",
      error: result.ok ? "" : result.error,
    }).catch((e) => console.error("❌ บันทึกประวัติอีเมลไม่สำเร็จ:", e.message));

    if (!result.ok) return res.status(502).json({ message: result.error });
    res.json({ ok: true, to, cc });
  } catch (err) {
    console.error("❌ mail document error:", err);
    res.status(500).json({ message: "ส่งอีเมลไม่สำเร็จ" });
  }
});

module.exports = router;
