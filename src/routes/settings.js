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
const {
  requireCap, ALL_ROLES, CAPABILITIES, EDITABLE_CAPABILITIES, LOCKED_ROLES,
  setCapabilityOverrides, effectiveCapabilities, rankLabelOf, setRankLabels, getRankLabelOverrides,
  ALL_SYSTEM_ROLES, SYSTEM_ROLE_LABEL, SYSTEM_ROLE_DESC, SYSTEM_CAPABILITIES, DEFAULT_SYSTEM_ROLE,
} = require("../config/roles");
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

/**
 * รูปที่ "ติดมากับแอป" — เลือกใช้ได้เลยโดยไม่ต้องอัปโหลด (✅ ผู้ใช้สั่ง: "วางชุดเดิมไว้ด้วย หรือให้เลือกได้")
 * ⚠️ เป็นไวต์ลิสต์โดยตั้งใจ — ห้ามรับ URL อิสระจาก client เด็ดขาด ไม่งั้นจะมีคนยัดรูปจากเว็บภายนอก
 * มาแปะบนหัวกระดาษเอกสารที่ส่งให้ลูกค้าได้ (และรูปจะหายไปเมื่อเว็บนั้นลบ)
 */
const BUILTIN_IMAGES = {
  app: [
    { key: "flowix", label: "Flowix (โลโก้แอป)", url: "/app-wordmark-light.png", isAppDefault: true },
    { key: "doall", label: "DO ALL (ชุดเดิม)", url: "/logo-dark-2.png" },
  ],
  letterhead: [
    { key: "doall", label: "DO ALL (ชุดเดิม)", url: "/logo-letterhead.png", isAppDefault: true },
  ],
  stamp: [
    { key: "doall", label: "DO ALL (ชุดเดิม)", url: "/stamp.png", isAppDefault: true },
  ],
};

const publicShape = (s) => ({
  nameTh: s.nameTh, nameEn: s.nameEn, address: s.address, taxId: s.taxId,
  tel: s.tel || "", email: s.email || "", website: s.website || "",
  logoUrl: s.logoUrl || "", letterheadUrl: s.letterheadUrl || "", stampUrl: s.stampUrl || "",
  advanceClearDays: s.advanceClearDays || OrgSetting.DEFAULTS.advanceClearDays,
  // ✅ ชื่อ Rank (ตำแหน่งในองค์กร) ที่ตั้งเอง — หน้าจอทุกหน้าใช้แสดง (ไม่ใช่ความลับ)
  rankLabels: s.rankLabels || {},
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
    // builtinImages = รูปที่เลือกได้ทันทีโดยไม่ต้องอัปโหลด (หน้าจอจะได้ไม่ต้องจำพาธไฟล์เอง)
    res.json({ settings: publicShape(await OrgSetting.current()), builtinImages: BUILTIN_IMAGES });
  } catch (err) {
    console.error("❌ ดึงตั้งค่าองค์กรไม่สำเร็จ:", err);
    res.status(500).json({ message: "ดึงการตั้งค่าไม่สำเร็จ" });
  }
});

/** แก้ไขข้อมูลบริษัท/ค่าตั้งต้น */
router.put("/", verifyToken, requireCap("manageSystem"), async (req, res) => {
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
    // ✅ หรือเลือกรูปที่ติดมากับแอป (preset_<slot>) — ชุดเดิมที่เคยใช้อยู่ก็กลับมาได้ทุกเมื่อ
    Object.entries(IMAGE_SLOTS).forEach(([slot, field]) => {
      if (req.body[`clear_${slot}`]) update[field] = "";
      const presetKey = String(req.body[`preset_${slot}`] || "").trim();
      if (!presetKey) return;
      const hit = (BUILTIN_IMAGES[slot] || []).find((b) => b.key === presetKey);
      if (!hit) return res.status(400).json({ message: "ไม่รู้จักรูปที่เลือก" });
      update[field] = hit.url;
      return undefined;
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
router.post("/image/:slot", verifyToken, requireCap("manageSystem"), upload.single("file"), async (req, res) => {
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

// ══ ตั้งค่าสิทธิ์ (ใครเห็นเมนูอะไร / จัดการอะไรได้) ══════════════════════════
/**
 * ✅ ผู้ใช้สั่ง: "อยากให้ตั้งค่ากำหนดสิทธิ์ได้ด้วยว่าอยากให้ใครมองเห็นเมนูอะไร และจัดการอะไรได้บ้าง เอาพอสังเขป"
 *
 * 🔒 กติกากันล็อกตัวเอง/กันยกระดับตัวเอง (บังคับที่ server เสมอ ไม่ใช่แค่ซ่อนปุ่ม):
 *   1. แก้ได้เฉพาะผู้มีสิทธิ์ manageAll
 *   2. กรรมการผู้จัดการ (LOCKED_ROLES) แก้ไม่ได้ — ต้องเหลือทางกลับเข้าหน้านี้เสมอ
 *   3. ปิด "จัดการระบบ" (manageAll) ของ role ตัวเองไม่ได้ — กันเผลอตัดสิทธิ์ตัวเองแล้วเข้ามาแก้คืนไม่ได้
 *   4. ปรับได้เฉพาะสิทธิ์ในรายการ EDITABLE_CAPABILITIES (ที่เหลือเป็นกฎควบคุมภายใน ตายตัวในโค้ด)
 */
router.get("/permissions", verifyToken, requireCap("manageSystem"), async (req, res) => {
  try {
    const doc = await OrgSetting.current({ fresh: true });
    res.json({
      // ── Role = ตำแหน่งในระบบ (Super Admin / Admin / Member) — คงที่ เปลี่ยนชื่อไม่ได้
      // ค่าของแต่ละชั้นอยู่ใต้คีย์ systemRole เพราะเป็นค่าที่หน้าจอส่งกลับมาลงที่ user.systemRole ตรงๆ
      roles: ALL_SYSTEM_ROLES.map((r) => ({
        systemRole: r,
        label: SYSTEM_ROLE_LABEL[r],
        desc: SYSTEM_ROLE_DESC[r],
        capabilities: Object.entries(SYSTEM_CAPABILITIES).filter(([, list]) => list.includes(r)).map(([cap]) => cap),
      })),
      // ── Rank = ตำแหน่งในองค์กร — เปลี่ยนชื่อได้ และติ๊กสิทธิ์งานได้เอง
      ranks: ALL_ROLES.map((r) => ({
        rank: r,
        label: rankLabelOf(r),
        locked: LOCKED_ROLES.includes(r),
        defaultSystemRole: DEFAULT_SYSTEM_ROLE[r],
      })),
      rankLabels: getRankLabelOverrides(),
      capabilities: EDITABLE_CAPABILITIES,
      defaults: Object.fromEntries(EDITABLE_CAPABILITIES.map((c) => [c, CAPABILITIES[c] || []])),
      overrides: doc?.capabilityOverrides || {},
      effective: Object.fromEntries(EDITABLE_CAPABILITIES.map((c) => [c, effectiveCapabilities()[c]])),
    });
  } catch (err) {
    console.error("❌ ดึงตารางสิทธิ์ไม่สำเร็จ:", err);
    res.status(500).json({ message: "ดึงตารางสิทธิ์ไม่สำเร็จ" });
  }
});

router.put("/permissions", verifyToken, requireCap("manageSystem"), async (req, res) => {
  try {
    // ✅ ตารางนี้คือสิทธิ์ของ "Rank" (ตำแหน่งในองค์กร) — รับคีย์เก่า role ด้วยเพื่อหน้าจอรุ่นเก่า
    const role = String(req.body?.rank || req.body?.role || "").toLowerCase();
    const capability = String(req.body?.capability || "");
    const allowed = req.body?.allowed;

    if (!ALL_ROLES.includes(role)) return res.status(400).json({ message: "ไม่รู้จักตำแหน่ง (Rank) นี้" });
    if (LOCKED_ROLES.includes(role)) {
      return res.status(403).json({ message: `${rankLabelOf(role)} ต้องมีสิทธิ์เต็มเสมอ — แก้ไม่ได้ (กันไม่ให้ไม่เหลือใครเข้าหน้าตั้งค่า)` });
    }
    if (!EDITABLE_CAPABILITIES.includes(capability)) {
      // ⚠️ สิทธิ์ระดับระบบ (จัดการผู้ใช้/ตั้งค่าระบบ) ไม่ได้อยู่ในตารางนี้ — ตั้งที่ "สิทธิ์ในระบบ" ของผู้ใช้รายคนแทน
      const hint = Object.prototype.hasOwnProperty.call(SYSTEM_CAPABILITIES, capability)
        ? " — สิทธิ์นี้เป็นสิทธิ์ระดับระบบ ตั้งได้ที่ Role ของผู้ใช้รายคน"
        : "";
      return res.status(400).json({ message: `สิทธิ์นี้ปรับจากตารางนี้ไม่ได้${hint}` });
    }
    if (typeof allowed !== "boolean") return res.status(400).json({ message: "ค่าที่ส่งมาไม่ถูกต้อง" });

    const doc = await OrgSetting.current({ fresh: true });
    const overrides = { ...(doc?.capabilityOverrides || {}) };
    const forRole = { ...(overrides[role] || {}) };
    // ✅ ตรงกับค่าเริ่มต้นอยู่แล้ว = ลบส่วนต่างทิ้ง (ตารางจะได้ไม่บวมด้วยค่าที่ไม่ได้ต่างอะไร)
    if ((CAPABILITIES[capability] || []).includes(role) === allowed) delete forRole[capability];
    else forRole[capability] = allowed;

    if (Object.keys(forRole).length) overrides[role] = forRole;
    else delete overrides[role];

    await OrgSetting.updateOne(
      { key: "org" },
      { $set: { capabilityOverrides: overrides, updatedBy: { userId: String(req.userId || ""), name: req.user?.fname || "" } } },
      { upsert: true }
    );
    OrgSetting.clearCache();
    setCapabilityOverrides(overrides); // มีผลกับคำขอถัดไปทันที ไม่ต้องรอรอบรีเฟรช
    res.json({ overrides, effective: Object.fromEntries(EDITABLE_CAPABILITIES.map((c) => [c, effectiveCapabilities()[c]])) });
  } catch (err) {
    console.error("❌ บันทึกตารางสิทธิ์ไม่สำเร็จ:", err);
    res.status(500).json({ message: "บันทึกตารางสิทธิ์ไม่สำเร็จ" });
  }
});

/**
 * ตารางสิทธิ์ที่ "ใช้จริง" สำหรับฝั่งหน้าจอ — ทุกคนที่ล็อกอินอ่านได้ (ใช้วาดเมนูของตัวเอง)
 * ⚠️ เป็นแค่ข้อมูลว่า role ไหนทำอะไรได้ ไม่ใช่ความลับ — และ server ยังกันทุก route ด้วย can() เหมือนเดิม
 */
router.get("/permissions/effective", verifyToken, (req, res) => {
  res.json({ effective: effectiveCapabilities() });
});

/**
 * เปลี่ยน "ชื่อที่แสดง" ของตำแหน่งในองค์กร — ✅ ผู้ใช้ขอ: "ในองค์กรให้สามารถเปลี่ยนชื่อได้"
 * ⚠️ เปลี่ยนแค่ชื่อ ไม่ใช่คีย์ — คีย์ (admin/manager/...) ถูกอ้างในบัญชีผู้ใช้ทุกคนและในตารางสิทธิ์
 * ⚠️ ส่งชื่อว่างมา = กลับไปใช้ชื่อเริ่มต้นของระบบ
 */
router.put("/rank-labels", verifyToken, requireCap("manageSystem"), async (req, res) => {
  try {
    const input = req.body?.labels;
    if (!input || typeof input !== "object") return res.status(400).json({ message: "ไม่มีข้อมูลที่จะบันทึก" });

    const doc = await OrgSetting.current({ fresh: true });
    const labels = { ...(doc?.rankLabels || {}) };
    for (const [rawRole, rawLabel] of Object.entries(input)) {
      const role = String(rawRole || "").toLowerCase();
      if (!ALL_ROLES.includes(role)) return res.status(400).json({ message: `ไม่รู้จักตำแหน่ง (Rank) "${rawRole}"` });
      const label = String(rawLabel ?? "").trim().slice(0, 60);
      if (label) labels[role] = label;
      else delete labels[role];
    }
    // ⚠️ ชื่อซ้ำกันสองตำแหน่ง = คนอ่านแยกไม่ออกว่าใครเป็นใครในทุกหน้าจอ/ทุกเอกสาร
    const effectiveLabels = ALL_ROLES.map((r) => labels[r] || rankLabelOf(r));
    const dup = effectiveLabels.find((l, i) => effectiveLabels.indexOf(l) !== i);
    if (dup) return res.status(400).json({ message: `ชื่อ "${dup}" ซ้ำกับตำแหน่งอื่น — ตั้งชื่อให้ไม่ซ้ำกัน` });

    await OrgSetting.updateOne(
      { key: "org" },
      { $set: { rankLabels: labels, updatedBy: { userId: String(req.userId || ""), name: req.user?.fname || "" } } },
      { upsert: true }
    );
    OrgSetting.clearCache();
    setRankLabels(labels);
    res.json({ rankLabels: labels, ranks: ALL_ROLES.map((r) => ({ rank: r, label: rankLabelOf(r) })) });
  } catch (err) {
    console.error("❌ เปลี่ยนชื่อตำแหน่งไม่สำเร็จ:", err);
    res.status(500).json({ message: "เปลี่ยนชื่อตำแหน่งไม่สำเร็จ" });
  }
});

module.exports = router;
