/**
 * API ของเว็บไซต์บริษัท (da-web) — เนื้อหา + คำขอจากลูกค้า
 *
 *   สาธารณะ  GET  /api/web/content              เนื้อหาที่เผยแพร่แล้วทั้งหมด (เว็บดึงตอน build/อัปเดต)
 *   เว็บเท่านั้น POST /api/web/leads              รับฟอร์มจากเว็บ (ต้องมี x-lead-key)
 *   ผู้ดูแลเนื้อหา  /api/web/admin/*             แก้สินค้า ผลงาน บทความ ยี่ห้อ การแสดงผล (manageWebsite)
 *   ฝ่ายขาย    /api/web/leads*                  คำขอจากเว็บ (viewLeads)
 *
 * ⚠️ ลำดับ route สำคัญ: /leads/summary ต้องประกาศก่อน /leads/:id ไม่งั้น "summary" ถูกตีความเป็น id
 * ⚠️ ทุกครั้งที่เนื้อหาเปลี่ยน ต้องสั่งเว็บดึงใหม่ (revalidateWebsite) ไม่งั้นแก้แล้วเว็บไม่เปลี่ยน
 *    จนกว่าจะครบรอบเวลา ผู้ใช้จะคิดว่าบันทึกไม่ติด
 */
const express = require("express");
const multer = require("multer");
const streamifier = require("streamifier");

const verifyToken = require("../middleware/auth");
const { requireCap, CAPABILITIES } = require("../config/roles");
const { cloudinary } = require("../config/cloudinary");
const OrgSetting = require("../models/OrgSetting");
const DocCounter = require("../models/DocCounter");
const WebProduct = require("../models/WebProduct");
const WebProject = require("../models/WebProject");
const WebArticle = require("../models/WebArticle");
const WebBrand = require("../models/WebBrand");
const WebSetting = require("../models/WebSetting");
const Lead = require("../models/Lead");
const { sendPushToRoles } = require("../services/PushNotify");
const { sendMail, esc } = require("../services/Mailer");

const router = express.Router();

/* ──────────────────────────────────────────────────────────────────────────
 * ส่วนกลาง
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * คอลเลกชันที่แก้ได้จากหลังบ้าน + ช่องที่อนุญาตให้เขียน
 * ⚠️ ไวต์ลิสต์ช่องโดยตั้งใจ — ห้ามส่ง req.body ทั้งก้อนเข้า mongoose ไม่งั้นแก้ updatedBy/createdAt/_id
 *    หรือช่องที่เพิ่มในอนาคตได้โดยไม่ตั้งใจ
 */
const COLLECTIONS = {
  products: {
    Model: WebProduct,
    fields: ["category", "type", "name", "brand", "model", "description", "specs", "images", "datasheet", "status", "featured", "order"],
    sort: { featured: -1, order: 1, createdAt: -1 },
    label: "สินค้า",
  },
  projects: {
    Model: WebProject,
    fields: ["slug", "title", "customer", "location", "systems", "completedAt", "summary", "scope", "challenge", "solution", "result", "images", "status", "featured"],
    sort: { completedAt: -1 },
    label: "ผลงาน",
  },
  articles: {
    Model: WebArticle,
    fields: ["slug", "title", "description", "category", "relatedService", "keywords", "cover", "body", "status"],
    sort: { publishedAt: -1, createdAt: -1 },
    label: "บทความ",
  },
  brands: {
    Model: WebBrand,
    fields: ["name", "category", "logo", "featured", "order", "status"],
    sort: { featured: -1, order: 1, name: 1 },
    label: "ยี่ห้อ",
  },
};

const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => obj[k] !== undefined).map((k) => [k, obj[k]]));
const editorOf = (req) => ({ userId: String(req.userId || ""), name: [req.user?.fname, req.user?.lname].filter(Boolean).join(" ") });

/** แปลง error ของ mongoose เป็นข้อความภาษาไทยที่ผู้ใช้อ่านรู้เรื่อง */
function sendDbError(res, err, label) {
  if (err?.code === 11000) {
    const keys = Object.keys(err.keyPattern || {});
    if (keys.includes("name") && keys.includes("category")) {
      return res.status(409).json({ message: "ยี่ห้อนี้มีอยู่แล้วในหมวดเดียวกัน" });
    }
    const field = keys[0] || "";
    const what = field === "slug" ? "ลิงก์ (slug)" : field === "name" ? "ชื่อ" : field;
    return res.status(409).json({ message: `${what}นี้มีอยู่แล้วใน${label}อื่น กรุณาใช้ค่าอื่น` });
  }
  if (err?.name === "ValidationError") {
    const first = Object.values(err.errors)[0];
    // ข้อความ enum/type ของ mongoose เป็นภาษาอังกฤษ — แปลงให้คนหน้าจออ่านรู้เรื่อง
    const generic = first?.kind === "enum" || first?.name === "CastError";
    const message = generic ? `ค่าในช่อง "${first.path}" ไม่ถูกต้อง` : first?.message || "ข้อมูลไม่ถูกต้อง";
    return res.status(422).json({ message });
  }
  if (err?.name === "CastError") return res.status(422).json({ message: `รูปแบบข้อมูลช่อง ${err.path} ไม่ถูกต้อง` });
  console.error(`❌ web ${label}:`, err);
  return res.status(500).json({ message: "บันทึกไม่สำเร็จ กรุณาลองใหม่" });
}

/**
 * สั่งเว็บไซต์ดึงเนื้อหาใหม่ทันที — ยิงแล้วไม่รอ (ไม่ให้การบันทึกช้าเพราะรอเว็บ)
 * ⚠️ ไม่ตั้ง WEB_REVALIDATE_URL = เว็บจะอัปเดตเองตามรอบเวลา (ดู da-web/src/lib/cms.ts)
 */
function revalidateWebsite() {
  const url = process.env.WEB_REVALIDATE_URL;
  const secret = process.env.WEB_REVALIDATE_SECRET;
  if (!url || !secret) return;
  fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-revalidate-secret": secret },
    body: JSON.stringify({ tags: ["web-content"] }),
    signal: AbortSignal.timeout(10_000),
  }).catch((err) => console.error("⚠️ สั่งเว็บไซต์อัปเดตไม่สำเร็จ:", err.message));
}

/**
 * ลบรูปที่ไม่ได้ใช้แล้วออกจาก Cloudinary (รูปกำพร้าเสียค่าพื้นที่ฟรีๆ)
 * 🔒 ลบได้เฉพาะไฟล์ในโฟลเดอร์ "website/" เท่านั้น — กันพลาดไปลบไฟล์งาน/ใบเบิกที่อยู่คนละโฟลเดอร์
 */
function destroyAssets(publicIds) {
  publicIds
    .filter((id) => typeof id === "string" && id.startsWith("website/"))
    .forEach((id) => {
      const resource_type = /\.(pdf)$/i.test(id) ? "raw" : "image";
      cloudinary.uploader.destroy(id, { resource_type }).catch((err) => console.error("⚠️ ลบไฟล์เก่าไม่สำเร็จ:", id, err.message));
    });
}

/** publicId ทั้งหมดที่เอกสารหนึ่งอ้างอิงอยู่ (รูป ปก โลโก้ datasheet) */
const assetIdsOf = (doc) =>
  [
    ...(doc?.images || []).map((i) => i.publicId),
    doc?.cover?.publicId,
    doc?.logo?.publicId,
    doc?.datasheet?.publicId,
  ].filter(Boolean);

/* ──────────────────────────────────────────────────────────────────────────
 * สาธารณะ: เนื้อหาทั้งหมดของเว็บ
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * ⚠️ ส่งก้อนเดียวครบทุกอย่างโดยตั้งใจ — เว็บดึงครั้งเดียวต่อรอบ ไม่ต้องยิงหลายเส้น
 *    (เนื้อหาทั้งเว็บหลักสิบ kB) ลดจุดที่ล้มได้ตอน build จาก 6 จุดเหลือจุดเดียว
 * 🔒 ส่งเฉพาะ status: "published" และตัดช่องภายใน (updatedBy, publicId) ออกเสมอ
 */
router.get("/content", async (req, res) => {
  try {
    const published = { status: "published" };
    const [products, projects, articles, brands, settings, org] = await Promise.all([
      WebProduct.find(published).sort(COLLECTIONS.products.sort).lean(),
      WebProject.find(published).sort(COLLECTIONS.projects.sort).lean(),
      WebArticle.find(published).sort(COLLECTIONS.articles.sort).lean(),
      WebBrand.find(published).sort(COLLECTIONS.brands.sort).lean(),
      WebSetting.current(),
      OrgSetting.current(),
    ]);
    const img = (i) => (i ? { url: i.url, width: i.width, height: i.height, alt: i.alt } : undefined);
    res.set("Cache-Control", "public, max-age=60");
    res.json({
      products: products.map((p) => ({
        id: String(p._id), category: p.category, type: p.type, name: p.name, brand: p.brand, model: p.model,
        description: p.description, specs: p.specs, images: (p.images || []).map(img), featured: p.featured,
        datasheet: p.datasheet?.url || "",
      })),
      projects: projects.map((p) => ({
        slug: p.slug, title: p.title, customer: p.customer, location: p.location, systems: p.systems,
        completedAt: p.completedAt, summary: p.summary, scope: p.scope, challenge: p.challenge,
        solution: p.solution, result: p.result, images: (p.images || []).map(img), featured: p.featured,
      })),
      articles: articles.map((a) => ({
        slug: a.slug, title: a.title, description: a.description, category: a.category,
        relatedService: a.relatedService, keywords: a.keywords, cover: img(a.cover), body: a.body,
        publishedAt: a.publishedAt || a.createdAt, updatedAt: a.updatedAt,
      })),
      brands: brands.map((b) => ({
        name: b.name, category: b.category, featured: b.featured,
        logo: b.logo?.url ? { url: b.logo.url, width: b.logo.width, height: b.logo.height } : undefined,
      })),
      settings: {
        stats: settings.stats, showStats: settings.showStats, showProjects: settings.showProjects,
        showBrands: settings.showBrands, showArticles: settings.showArticles,
        businessHoursWeekdays: settings.businessHoursWeekdays, businessHoursSaturday: settings.businessHoursSaturday,
        businessHoursClosed: settings.businessHoursClosed, emergencyNote: settings.emergencyNote,
        serviceAreas: settings.serviceAreas, announcement: settings.announcement,
      },
      // ✅ ช่องทางติดต่อใช้ชุดเดียวกับที่ Super Admin ตั้งในแอป (หน้าตั้งค่าองค์กร)
      contact: {
        tel: org.tel || "", email: org.email || "", lineUrl: org.contactLine || "", facebookUrl: org.contactFacebook || "",
      },
    });
  } catch (err) {
    console.error("❌ web content:", err);
    res.status(500).json({ message: "ดึงเนื้อหาเว็บไซต์ไม่สำเร็จ" });
  }
});

/* ──────────────────────────────────────────────────────────────────────────
 * รับคำขอจากเว็บไซต์
 * ────────────────────────────────────────────────────────────────────────── */

const leadUpload = multer({
  storage: multer.memoryStorage(),
  // ⚠️ เว็บจำกัดรวม 4 MB อยู่แล้ว (เพดานของ Vercel) — ตรงนี้คือด่านที่สองเผื่อมีคนยิงตรง
  limits: { fileSize: 10 * 1024 * 1024, files: 5, fields: 5, fieldSize: 64 * 1024 },
});

/** ตรวจชนิดไฟล์จากเนื้อไฟล์จริง — กติกาเดียวกับ da-web/src/lib/lead.ts (ห้ามเชื่อนามสกุล/MIME ที่ส่งมา) */
function detectFileType(buf, filename) {
  const ext = String(filename || "").toLowerCase().split(".").pop();
  const starts = (sig) => sig.every((v, i) => buf[i] === v);
  if (starts([0x25, 0x50, 0x44, 0x46, 0x2d])) return ext === "pdf" ? { ext: "pdf", resourceType: "raw" } : null;
  if (starts([0xff, 0xd8, 0xff])) return ["jpg", "jpeg"].includes(ext) ? { ext: "jpg", resourceType: "image" } : null;
  if (starts([0x89, 0x50, 0x4e, 0x47])) return ext === "png" ? { ext: "png", resourceType: "image" } : null;
  if (starts([0x50, 0x4b, 0x03, 0x04]) && ["docx", "xlsx"].includes(ext)) return { ext, resourceType: "raw" };
  return null;
}

/** กันสแปมชั้นที่สอง — นับตาม IP ของลูกค้าจริง (เว็บส่งมาใน meta) ไม่ใช่ IP ของเครื่องเว็บที่ยิงมา */
const leadHits = new Map();
const LEAD_WINDOW_MS = 10 * 60 * 1000;
const tooMany = (ip) => {
  const now = Date.now();
  const recent = (leadHits.get(ip) || []).filter((t) => now - t < LEAD_WINDOW_MS);
  recent.push(now);
  leadHits.set(ip, recent);
  if (leadHits.size > 5000) for (const [k, v] of leadHits) if (v.every((t) => now - t >= LEAD_WINDOW_MS)) leadHits.delete(k);
  return recent.length > 10;
};

/** ตรวจข้อมูลซ้ำที่ server — เว็บตรวจแล้วก็จริง แต่ใครมีกุญแจหลุดไปก็ยิงตรงได้ */
function validateLead(p) {
  const s = (v, max) => String(v ?? "").trim().slice(0, max);
  const lead = {
    kind: p.kind === "quotation" ? "quotation" : p.kind === "contact" ? "contact" : "",
    name: s(p.name, 100),
    company: s(p.company, 150),
    phone: s(p.phone, 20).replace(/[\s\-().]/g, "").replace(/^\+66/, "0"),
    email: s(p.email, 120),
    subject: s(p.subject, 150),
    serviceType: s(p.serviceType, 60),
    siteLocation: s(p.siteLocation, 200),
    budget: s(p.budget, 40),
    preferredDate: /^\d{4}-\d{2}-\d{2}$/.test(String(p.preferredDate || "")) ? p.preferredDate : "",
    details: s(p.details, 4000),
  };
  if (!lead.kind) return { error: "ชนิดคำขอไม่ถูกต้อง" };
  if (lead.name.length < 2) return { error: "ชื่อไม่ถูกต้อง" };
  if (!/^0\d{8,9}$/.test(lead.phone)) return { error: "เบอร์โทรไม่ถูกต้อง" };
  if (lead.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(lead.email)) return { error: "อีเมลไม่ถูกต้อง" };
  if (lead.details.length < 10) return { error: "รายละเอียดสั้นเกินไป" };
  if (lead.kind === "quotation" && !lead.serviceType) return { error: "ไม่ได้ระบุประเภทงาน" };
  if (lead.kind === "contact" && lead.subject.length < 2) return { error: "ไม่ได้ระบุหัวข้อ" };
  if (p.consent !== true) return { error: "ไม่ได้รับความยินยอมตาม PDPA" };
  return { lead };
}

/** เลขอ้างอิงแบบเดินหน้าอย่างเดียว ต่อปี พ.ศ. — ใช้ DocCounter ตัวเดียวกับเลขเอกสาร (atomic $inc) */
async function nextLeadRef() {
  const year = new Date().getFullYear() + 543;
  const c = await DocCounter.findOneAndUpdate({ key: `web-lead:${year}` }, { $inc: { seq: 1 } }, { new: true, upsert: true });
  return `WEB-${year}-${String(c.seq).padStart(5, "0")}`;
}

const uploadLeadFile = (buf, { ref, index, ext, resourceType }) =>
  new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: "website-leads",
        // 🔒 authenticated = เปิดด้วยลิงก์ตรงไม่ได้ ต้องขอลิงก์ลงนามผ่าน API ที่ตรวจสิทธิ์ (ดู GET /leads/:id)
        type: "authenticated",
        resource_type: resourceType,
        // ไฟล์ raw ต้องมีนามสกุลใน public_id ไม่งั้นดาวน์โหลดมาแล้วเปิดไม่ได้
        public_id: `${ref}-${index + 1}${resourceType === "raw" ? `.${ext}` : ""}`,
      },
      (err, result) => (err ? reject(err) : resolve(result))
    );
    streamifier.createReadStream(buf).pipe(stream);
  });

const SERVICE_LABEL = {
  "fire-alarm": "ระบบแจ้งเหตุเพลิงไหม้ (Fire Alarm)",
  "fire-pump": "ระบบเครื่องสูบน้ำดับเพลิง (Fire Pump)",
  cctv: "กล้องวงจรปิด (CCTV)",
  "access-control": "ระบบควบคุมการเข้าออก",
  network: "ระบบเครือข่าย",
  maintenance: "บำรุงรักษาระบบ (PM/CM)",
  other: "อื่น ๆ",
};

router.post("/leads", leadUpload.array("files", 5), async (req, res) => {
  // 🔒 กุญแจร่วมกับเว็บไซต์ — ไม่ตั้ง LEAD_API_KEY = ปิดเส้นนี้ทั้งเส้น (ไม่ใช่เปิดให้ทุกคน)
  const key = process.env.LEAD_API_KEY;
  if (!key || req.get("x-lead-key") !== key) return res.status(401).json({ error: "unauthorized" });

  let payload;
  try {
    payload = JSON.parse(req.body.payload || "{}");
  } catch {
    return res.status(400).json({ error: "รูปแบบข้อมูลไม่ถูกต้อง" });
  }
  const ip = String(payload?.meta?.ip || req.ip || "").slice(0, 64);
  if (tooMany(ip)) return res.status(429).json({ error: "ส่งบ่อยเกินไป" });

  const { lead, error } = validateLead(payload);
  if (error) return res.status(422).json({ error });

  const files = req.files || [];
  if (files.length && lead.kind !== "quotation") return res.status(422).json({ error: "ฟอร์มนี้ไม่รองรับไฟล์แนบ" });
  const types = files.map((f) => detectFileType(f.buffer, f.originalname));
  if (types.some((t) => !t)) return res.status(422).json({ error: "มีไฟล์ที่ไม่ใช่ชนิดที่รองรับ" });

  try {
    const ref = await nextLeadRef();
    const uploaded = await Promise.all(
      files.map(async (f, index) => {
        const r = await uploadLeadFile(f.buffer, { ref, index, ...types[index] });
        return { publicId: r.public_id, resourceType: types[index].resourceType, format: types[index].ext, name: f.originalname.slice(0, 200), bytes: f.size };
      })
    );

    const doc = await Lead.create({
      ...lead,
      ref,
      files: uploaded,
      consentAt: new Date(),
      meta: { ip, userAgent: String(payload?.meta?.userAgent || "").slice(0, 400), page: String(payload?.meta?.page || "").slice(0, 400) },
    });

    // ── แจ้งทีม — ทั้งหมดไม่รอ และล้มได้โดยไม่กระทบการบันทึก ──
    const what = lead.kind === "quotation" ? "คำขอใบเสนอราคา" : "ข้อความติดต่อ";
    const service = SERVICE_LABEL[lead.serviceType] || lead.serviceType || lead.subject || "";
    // 🔒 push แสดงบนหน้าจอล็อก — ใส่แค่ชื่อกับเรื่อง ไม่ใส่เบอร์/อีเมลลูกค้า
    sendPushToRoles(CAPABILITIES.viewLeads, {
      title: `📨 ${what}ใหม่จากเว็บไซต์`,
      body: `${lead.name}${lead.company ? ` (${lead.company})` : ""}${service ? ` · ${service}` : ""}`,
      url: `/website/leads?id=${doc._id}`,
      tag: `lead-${doc._id}`,
    }).catch((err) => console.error("⚠️ push คำขอจากเว็บ:", err.message));

    const rows = [
      ["เลขอ้างอิง", ref], ["ประเภท", what], ["ชื่อ", lead.name], ["บริษัท", lead.company], ["โทร", lead.phone],
      ["อีเมล", lead.email], ["หัวข้อ", lead.subject], ["ประเภทงาน", service], ["สถานที่", lead.siteLocation],
      ["งบประมาณ", lead.budget], ["วันที่ต้องการ", lead.preferredDate], ["ไฟล์แนบ", uploaded.length ? `${uploaded.length} ไฟล์ (เปิดดูในแอป)` : ""],
    ].filter(([, v]) => v);
    const appUrl = (process.env.APP_PUBLIC_URL || "").replace(/\/+$/, "");
    sendMail({
      to: process.env.LEAD_NOTIFY_EMAIL,
      replyTo: lead.email || undefined,
      subject: `[เว็บไซต์] ${what}ใหม่ ${ref} — ${lead.name}`,
      text: `${rows.map(([k, v]) => `${k}: ${v}`).join("\n")}\n\nรายละเอียด:\n${lead.details}`,
      html: `<div style="font-family:Tahoma,sans-serif;font-size:14px;color:#0f172a">
        <h2 style="margin:0 0 12px;color:#dc2626">${esc(what)}ใหม่จากเว็บไซต์</h2>
        <table cellpadding="6" style="border-collapse:collapse">${rows.map(([k, v]) => `<tr><td style="color:#64748b;white-space:nowrap">${esc(k)}</td><td><b>${esc(v)}</b></td></tr>`).join("")}</table>
        <p style="margin:16px 0 4px;color:#64748b">รายละเอียด</p>
        <div style="white-space:pre-wrap;border-left:3px solid #dc2626;padding:8px 12px;background:#f8fafc">${esc(lead.details)}</div>
        ${appUrl ? `<p style="margin-top:16px"><a href="${esc(appUrl)}/website/leads?id=${doc._id}">เปิดในระบบ</a></p>` : ""}
      </div>`,
    }).then((ok) => { if (ok) Lead.updateOne({ _id: doc._id }, { $set: { emailed: true } }).catch(() => {}); });

    res.status(201).json({ ref });
  } catch (err) {
    console.error("❌ รับคำขอจากเว็บไม่สำเร็จ:", err);
    res.status(500).json({ error: "บันทึกไม่สำเร็จ" });
  }
});

/* ──────────────────────────────────────────────────────────────────────────
 * ฝ่ายขาย: จัดการคำขอจากเว็บไซต์
 * ────────────────────────────────────────────────────────────────────────── */

const leadAuth = [verifyToken, requireCap("viewLeads")];

router.get("/leads/summary", ...leadAuth, async (req, res) => {
  try {
    const rows = await Lead.aggregate([{ $group: { _id: "$status", n: { $sum: 1 } } }]);
    const byStatus = Object.fromEntries(rows.map((r) => [r._id, r.n]));
    res.json({ byStatus, new: byStatus.new || 0 });
  } catch (err) {
    console.error("❌ lead summary:", err);
    res.status(500).json({ message: "ดึงสรุปไม่สำเร็จ" });
  }
});

router.get("/leads", ...leadAuth, async (req, res) => {
  try {
    const { status, kind, q } = req.query;
    const page = Math.max(1, Number(req.query.page) || 1);
    const PAGE = 30;
    const filter = {};
    if (status && Lead.STATUSES.includes(status)) filter.status = status;
    if (kind === "contact" || kind === "quotation") filter.kind = kind;
    if (q && String(q).trim()) {
      const rx = new RegExp(String(q).trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").slice(0, 60), "i");
      filter.$or = [{ name: rx }, { company: rx }, { phone: rx }, { email: rx }, { ref: rx }, { details: rx }];
    }
    const [items, total] = await Promise.all([
      Lead.find(filter).sort({ createdAt: -1 }).skip((page - 1) * PAGE).limit(PAGE).select("-meta -notes").lean(),
      Lead.countDocuments(filter),
    ]);
    res.json({ items, total, page, pages: Math.max(1, Math.ceil(total / PAGE)) });
  } catch (err) {
    console.error("❌ lead list:", err);
    res.status(500).json({ message: "ดึงรายการไม่สำเร็จ" });
  }
});

router.get("/leads/:id", ...leadAuth, async (req, res) => {
  try {
    const lead = await Lead.findById(req.params.id).lean();
    if (!lead) return res.status(404).json({ message: "ไม่พบคำขอนี้" });
    // 🔒 ลิงก์ดาวน์โหลดลงนาม อายุ 10 นาที — หลุดไปก็ใช้ได้ไม่นาน
    const expires_at = Math.floor(Date.now() / 1000) + 600;
    lead.files = (lead.files || []).map((f) => ({
      ...f,
      url: cloudinary.utils.private_download_url(f.publicId, f.resourceType === "raw" ? "" : f.format, {
        resource_type: f.resourceType, type: "authenticated", expires_at, attachment: true,
      }),
    }));
    res.json({ lead });
  } catch (err) {
    if (err?.name === "CastError") return res.status(404).json({ message: "ไม่พบคำขอนี้" });
    console.error("❌ lead detail:", err);
    res.status(500).json({ message: "ดึงข้อมูลไม่สำเร็จ" });
  }
});

router.put("/leads/:id", ...leadAuth, async (req, res) => {
  try {
    const set = {};
    const push = {};
    if (req.body.status !== undefined) {
      if (!Lead.STATUSES.includes(req.body.status)) return res.status(422).json({ message: "สถานะไม่ถูกต้อง" });
      set.status = req.body.status;
    }
    if (req.body.assignee !== undefined) set.assignee = String(req.body.assignee || "").slice(0, 100);
    const note = String(req.body.note || "").trim();
    if (note) push.notes = { at: new Date(), by: editorOf(req).name, text: note.slice(0, 2000) };
    if (!Object.keys(set).length && !Object.keys(push).length) return res.status(422).json({ message: "ไม่มีอะไรให้บันทึก" });
    const lead = await Lead.findByIdAndUpdate(
      req.params.id,
      { ...(Object.keys(set).length ? { $set: set } : {}), ...(Object.keys(push).length ? { $push: push } : {}) },
      { new: true, runValidators: true }
    ).lean();
    if (!lead) return res.status(404).json({ message: "ไม่พบคำขอนี้" });
    res.json({ lead });
  } catch (err) {
    return sendDbError(res, err, "คำขอ");
  }
});

/**
 * ลบคำขอ — ✅ พ.ร.บ.คุ้มครองข้อมูลส่วนบุคคล: ลูกค้ามีสิทธิ์ขอให้ลบข้อมูลของตัวเอง บริษัทต้องทำได้จริง
 * 🔒 ลบได้เฉพาะ manageWebsite (ผู้ดูแล) ไม่ใช่ทุกคนที่เห็นคำขอ — ลบแล้วกู้คืนไม่ได้ รวมไฟล์แนบด้วย
 */
router.delete("/leads/:id", verifyToken, requireCap("manageWebsite"), async (req, res) => {
  try {
    const lead = await Lead.findByIdAndDelete(req.params.id).lean();
    if (!lead) return res.status(404).json({ message: "ไม่พบคำขอนี้" });
    (lead.files || []).forEach((f) =>
      cloudinary.uploader
        .destroy(f.publicId, { resource_type: f.resourceType, type: "authenticated" })
        .catch((err) => console.error("⚠️ ลบไฟล์แนบของคำขอไม่สำเร็จ:", f.publicId, err.message))
    );
    res.json({ ok: true });
  } catch (err) {
    if (err?.name === "CastError") return res.status(404).json({ message: "ไม่พบคำขอนี้" });
    console.error("❌ ลบคำขอ:", err);
    res.status(500).json({ message: "ลบไม่สำเร็จ" });
  }
});

/* ──────────────────────────────────────────────────────────────────────────
 * ผู้ดูแลเนื้อหา: อัปโหลดไฟล์
 * ────────────────────────────────────────────────────────────────────────── */

const adminAuth = [verifyToken, requireCap("manageWebsite")];

const assetUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    // 🔒 ไม่รับ SVG — ฝังสคริปต์ได้ และรูปพวกนี้ขึ้นเว็บสาธารณะ
    const ok = ["image/jpeg", "image/png", "image/webp", "application/pdf"].includes(file.mimetype);
    cb(ok ? null : new Error("รองรับเฉพาะรูป JPG / PNG / WebP และเอกสาร PDF"), ok);
  },
});

router.post("/admin/upload", ...adminAuth, (req, res) => {
  assetUpload.single("file")(req, res, async (uploadErr) => {
    if (uploadErr) {
      const msg = uploadErr.code === "LIMIT_FILE_SIZE" ? "ไฟล์ใหญ่เกิน 10 MB" : uploadErr.message;
      return res.status(422).json({ message: msg });
    }
    if (!req.file) return res.status(422).json({ message: "ไม่พบไฟล์" });
    const isPdf = req.file.mimetype === "application/pdf";
    // ตรวจเนื้อไฟล์ซ้ำ — MIME ที่เบราว์เซอร์ส่งมาปลอมได้
    const b = req.file.buffer;
    const real = isPdf ? b.slice(0, 5).toString() === "%PDF-" : (b[0] === 0xff && b[1] === 0xd8) || (b[0] === 0x89 && b[1] === 0x50) || b.slice(8, 12).toString() === "WEBP";
    if (!real) return res.status(422).json({ message: "เนื้อไฟล์ไม่ตรงกับชนิดไฟล์" });
    try {
      const result = await new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          isPdf
            ? { folder: "website/files", resource_type: "raw", use_filename: true, unique_filename: true, filename_override: req.file.originalname }
            : {
                folder: "website/images",
                resource_type: "image",
                // ✅ ย่อรูปยักษ์จากกล้องมือถือตั้งแต่ตอนเก็บ — เว็บไม่ต้องใช้รูปกว้างเกิน 2400px
                transformation: [{ width: 2400, height: 2400, crop: "limit", quality: "auto" }],
              },
          (err, r) => (err ? reject(err) : resolve(r))
        );
        streamifier.createReadStream(b).pipe(stream);
      });
      res.status(201).json({
        url: result.secure_url, publicId: result.public_id, width: result.width || 0, height: result.height || 0,
        name: req.file.originalname, bytes: result.bytes || req.file.size,
      });
    } catch (err) {
      console.error("❌ อัปโหลดไฟล์เว็บไซต์:", err);
      res.status(500).json({ message: "อัปโหลดไม่สำเร็จ" });
    }
  });
});

/* ──────────────────────────────────────────────────────────────────────────
 * ผู้ดูแลเนื้อหา: การแสดงผลของเว็บ
 * ────────────────────────────────────────────────────────────────────────── */

const SETTING_FIELDS = [
  "stats", "showStats", "showProjects", "showBrands", "showArticles", "businessHoursWeekdays",
  "businessHoursSaturday", "businessHoursClosed", "emergencyNote", "serviceAreas", "announcement",
];

router.get("/admin/settings", ...adminAuth, async (req, res) => {
  try {
    res.json({ settings: await WebSetting.current() });
  } catch (err) {
    console.error("❌ web settings:", err);
    res.status(500).json({ message: "ดึงการตั้งค่าไม่สำเร็จ" });
  }
});

router.put("/admin/settings", ...adminAuth, async (req, res) => {
  try {
    const doc = await WebSetting.findOneAndUpdate(
      { key: "web" },
      { $set: { ...pick(req.body || {}, SETTING_FIELDS), updatedBy: editorOf(req) } },
      { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true }
    ).lean();
    revalidateWebsite();
    res.json({ settings: doc });
  } catch (err) {
    return sendDbError(res, err, "การตั้งค่า");
  }
});

/* ──────────────────────────────────────────────────────────────────────────
 * ผู้ดูแลเนื้อหา: สินค้า / ผลงาน / บทความ / ยี่ห้อ
 * ────────────────────────────────────────────────────────────────────────── */

const colOf = (req, res) => {
  const col = COLLECTIONS[req.params.col];
  if (!col) res.status(404).json({ message: "ไม่พบหมวดนี้" });
  return col;
};

/** กฎเฉพาะของแต่ละชนิดก่อนบันทึก — คืนข้อความ error หรือ null */
function businessRules(colName, data) {
  // ✅ บริษัทสั่ง: "สินค้าต้องมีรูปภาพด้วย" — ร่างไม่มีรูปได้ แต่เผยแพร่ต้องมีอย่างน้อย 1 รูป
  if (colName === "products" && data.status === "published" && !(data.images || []).length) {
    return "สินค้าต้องมีรูปอย่างน้อย 1 รูปก่อนเผยแพร่ (บันทึกเป็นฉบับร่างไว้ก่อนได้)";
  }
  if (colName === "projects" && data.status === "published" && !String(data.summary || "").trim()) {
    return "ผลงานต้องมีสรุปย่อก่อนเผยแพร่";
  }
  return null;
}

router.get("/admin/:col", ...adminAuth, async (req, res) => {
  const col = colOf(req, res);
  if (!col) return;
  try {
    res.json({ items: await col.Model.find({}).sort(col.sort).lean() });
  } catch (err) {
    return sendDbError(res, err, col.label);
  }
});

router.post("/admin/:col", ...adminAuth, async (req, res) => {
  const col = colOf(req, res);
  if (!col) return;
  const data = pick(req.body || {}, col.fields);
  const ruleError = businessRules(req.params.col, data);
  if (ruleError) return res.status(422).json({ message: ruleError });
  try {
    if (req.params.col === "articles" && data.status === "published") data.publishedAt = new Date();
    const doc = await col.Model.create({ ...data, updatedBy: editorOf(req) });
    revalidateWebsite();
    res.status(201).json({ item: doc.toObject() });
  } catch (err) {
    return sendDbError(res, err, col.label);
  }
});

router.put("/admin/:col/:id", ...adminAuth, async (req, res) => {
  const col = colOf(req, res);
  if (!col) return;
  try {
    const before = await col.Model.findById(req.params.id).lean();
    if (!before) return res.status(404).json({ message: `ไม่พบ${col.label}นี้` });
    const data = pick(req.body || {}, col.fields);
    const ruleError = businessRules(req.params.col, { ...before, ...data });
    if (ruleError) return res.status(422).json({ message: ruleError });
    // วันที่เผยแพร่ตั้งครั้งแรกครั้งเดียว — แก้คำผิดทีหลังไม่ทำให้บทความเก่ากลายเป็น "ใหม่"
    if (req.params.col === "articles" && data.status === "published" && !before.publishedAt) data.publishedAt = new Date();
    const doc = await col.Model.findByIdAndUpdate(
      req.params.id,
      { $set: { ...data, updatedBy: editorOf(req) } },
      { new: true, runValidators: true }
    ).lean();
    // ลบรูปที่ถูกเอาออกจากเอกสารนี้ออกจาก Cloudinary ด้วย
    const kept = new Set(assetIdsOf(doc));
    destroyAssets(assetIdsOf(before).filter((id) => !kept.has(id)));
    revalidateWebsite();
    res.json({ item: doc });
  } catch (err) {
    return sendDbError(res, err, col.label);
  }
});

router.delete("/admin/:col/:id", ...adminAuth, async (req, res) => {
  const col = colOf(req, res);
  if (!col) return;
  try {
    const doc = await col.Model.findByIdAndDelete(req.params.id).lean();
    if (!doc) return res.status(404).json({ message: `ไม่พบ${col.label}นี้` });
    destroyAssets(assetIdsOf(doc));
    revalidateWebsite();
    res.json({ ok: true });
  } catch (err) {
    return sendDbError(res, err, col.label);
  }
});

module.exports = router;
