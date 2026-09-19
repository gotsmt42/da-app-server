/**
 * /api/settings — ตั้งค่าองค์กร (โลโก้ · ข้อมูลบริษัท · ค่าตั้งต้นของเอกสาร)
 *
 * ✅ ผู้ใช้สั่งให้ "ปรับเปลี่ยนได้เองจากหน้าตั้งค่า" — เดิมค่าพวกนี้ฝังอยู่ในโค้ดฝั่งหน้าเว็บ
 * 🔒 อ่านได้ทุกคนที่ล็อกอิน (ต้องใช้วาดหัวเว็บ/หัวกระดาษเอกสาร) · แก้ไขได้เฉพาะ manageAll
 * ⚠️ รูปที่อัปเข้ามาเก็บบน Cloudinary เหมือนไฟล์แนบอื่นๆ ของระบบ ไม่ได้เก็บลงดิสก์ของเซิร์ฟเวอร์
 * (Render ล้างดิสก์ทุกครั้งที่ deploy — เก็บลงดิสก์แล้วโลโก้จะหายเงียบๆ หลัง deploy ถัดไป)
 */
const express = require("express");
const multer = require("multer");
const streamifier = require("streamifier");

const OrgSetting = require("../models/OrgSetting");
const verifyToken = require("../middleware/auth");
const { requireCap } = require("../config/roles");
const { cloudinary } = require("../config/cloudinary");

const router = express.Router();

/** โลโก้/ตราประทับ — รับเฉพาะรูป และเล็กกว่าไฟล์แนบทั่วไป (ไฟล์ใหญ่ทำให้ PDF หนักทุกใบ) */
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMAGE_BYTES, files: 1 },
  fileFilter: (req, file, cb) => {
    // ⚠️ ต้องเป็น PNG/JPG/WebP เท่านั้น — SVG ฝังสคริปต์ได้ และ jsPDF วาด SVG ไม่ได้อยู่แล้ว
    const ok = ["image/png", "image/jpeg", "image/webp"].includes(file.mimetype);
    cb(ok ? null : new Error("รองรับเฉพาะไฟล์รูป PNG / JPG / WebP"), ok);
  },
});

const TEXT_FIELDS = {
  nameTh: 160,
  nameEn: 160,
  address: 300,
  taxId: 120,
  tel: 60,
  email: 120,
  website: 160,
};

/** รูปของแต่ละช่อง — คีย์ที่หน้าจอส่งมา → ฟิลด์ในฐานข้อมูล */
const IMAGE_SLOTS = { app: "logoUrl", letterhead: "letterheadUrl", stamp: "stampUrl" };

const publicShape = (s) => ({
  nameTh: s.nameTh, nameEn: s.nameEn, address: s.address, taxId: s.taxId,
  tel: s.tel || "", email: s.email || "", website: s.website || "",
  logoUrl: s.logoUrl || "", letterheadUrl: s.letterheadUrl || "", stampUrl: s.stampUrl || "",
  advanceClearDays: s.advanceClearDays || OrgSetting.DEFAULTS.advanceClearDays,
  updatedAt: s.updatedAt || null,
  updatedBy: s.updatedBy?.name || "",
});

/**
 * ค่าปัจจุบัน — หน้าจอเรียกตอนเปิดแอปเพื่อวาดโลโก้/ชื่อบริษัท
 * 🔒 เปิดให้อ่านได้โดยไม่ต้องล็อกอิน "โดยตั้งใจ" — หน้าเข้าสู่ระบบต้องวาดโลโก้บริษัทก่อนมี token
 * ⚠️ จึงห้ามใส่อะไรที่เป็นความลับลงใน publicShape() เด็ดขาด — ข้อมูลชุดนี้คือสิ่งที่พิมพ์อยู่บนหัวกระดาษ
 * เอกสารที่ส่งให้ลูกค้าอยู่แล้ว (ชื่อบริษัท ที่อยู่ เลขผู้เสียภาษี โลโก้)
 */
router.get("/", async (req, res) => {
  try {
    res.json({ settings: publicShape(await OrgSetting.current()) });
  } catch (err) {
    console.error("❌ ดึงตั้งค่าองค์กรไม่สำเร็จ:", err);
    res.status(500).json({ message: "ดึงการตั้งค่าไม่สำเร็จ" });
  }
});

/** แก้ไขข้อมูลบริษัท/ค่าตั้งต้น */
router.put("/", verifyToken, requireCap("manageAll"), async (req, res) => {
  try {
    const update = {};
    Object.entries(TEXT_FIELDS).forEach(([field, max]) => {
      if (req.body[field] === undefined) return;
      update[field] = String(req.body[field] || "").trim().slice(0, max);
    });
    if (req.body.advanceClearDays !== undefined) {
      const days = Math.round(Number(req.body.advanceClearDays));
      if (!Number.isFinite(days) || days < 1 || days > 90) {
        return res.status(400).json({ message: "กำหนดเคลียร์ Advance ต้องอยู่ระหว่าง 1–90 วัน" });
      }
      update.advanceClearDays = days;
    }
    // ✅ ล้างรูปออก (กลับไปใช้โลโก้ที่ติดมากับแอป) — ส่งค่าว่างมาที่ช่องรูปได้
    Object.entries(IMAGE_SLOTS).forEach(([slot, field]) => {
      if (req.body[`clear_${slot}`]) update[field] = "";
    });
    if (!Object.keys(update).length) return res.status(400).json({ message: "ไม่มีข้อมูลที่จะบันทึก" });

    // ⚠️ ชื่อบริษัทภาษาไทยว่าง = หัวกระดาษเอกสารทุกใบไม่มีชื่อบริษัท — กันไว้ตั้งแต่ต้นทาง
    if (update.nameTh !== undefined && !update.nameTh) {
      return res.status(400).json({ message: "กรุณาระบุชื่อบริษัท (ภาษาไทย) — ใช้พิมพ์บนหัวกระดาษทุกใบ" });
    }

    update.updatedBy = { userId: String(req.userId || ""), name: req.user?.fname || "" };
    const saved = await OrgSetting.findOneAndUpdate({ key: "org" }, { $set: update }, { new: true, upsert: true, setDefaultsOnInsert: true }).lean();
    OrgSetting.clearCache();
    res.json({ settings: publicShape(saved) });
  } catch (err) {
    console.error("❌ บันทึกตั้งค่าองค์กรไม่สำเร็จ:", err);
    res.status(500).json({ message: "บันทึกการตั้งค่าไม่สำเร็จ" });
  }
});

/** อัปโหลดรูป 1 ช่อง (โลโก้แอป / โลโก้หัวกระดาษ / ตราประทับ) */
router.post("/image/:slot", verifyToken, requireCap("manageAll"), upload.single("file"), async (req, res) => {
  try {
    const field = IMAGE_SLOTS[String(req.params.slot || "")];
    if (!field) return res.status(400).json({ message: "ไม่รู้จักช่องรูปนี้" });
    if (!req.file) return res.status(400).json({ message: "กรุณาเลือกไฟล์รูป" });

    const uploaded = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          resource_type: "image",
          folder: "org",
          public_id: `${req.params.slot}_${Date.now()}`,
          use_filename: false,
          unique_filename: false,
          overwrite: true,
        },
        (err, out) => (err ? reject(err) : resolve(out))
      );
      streamifier.createReadStream(req.file.buffer).pipe(stream);
    });

    const saved = await OrgSetting.findOneAndUpdate(
      { key: "org" },
      { $set: { [field]: uploaded.secure_url, updatedBy: { userId: String(req.userId || ""), name: req.user?.fname || "" } } },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    ).lean();
    OrgSetting.clearCache();
    res.json({ settings: publicShape(saved) });
  } catch (err) {
    console.error("❌ อัปโหลดรูปองค์กรไม่สำเร็จ:", err);
    res.status(500).json({ message: err.message || "อัปโหลดรูปไม่สำเร็จ" });
  }
});

module.exports = router;
