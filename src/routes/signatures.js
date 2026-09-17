/**
 * /api/signatures — ลายเซ็นอิเล็กทรอนิกส์ของพนักงาน (ตั้งค่าเอง แล้วระบบนำไปใช้กับ PDF)
 *
 * ✅ ผู้ใช้ขอ: "ทำลายเซ็นอิเล็กทรอนิกส์ได้ โดยต้องไปเซ็ตการตั้งค่าของแต่ละ user ไว้ และนำมาใช้กับ
 * เอกสารที่ออกเป็น PDF ได้ทั้งหมด" — ดู models/Signature.js สำหรับเหตุผลการออกแบบที่เก็บ
 *
 * 🔒 กฎความปลอดภัยของทั้งระบบลายเซ็น (สำคัญมาก — ลายเซ็นคนอื่นรั่ว = ปลอมเอกสารได้):
 *   1. ตั้ง/แก้/ลบ ลายเซ็นได้เฉพาะ "ของตัวเอง" เท่านั้น แอดมินก็ตั้งแทนคนอื่นไม่ได้
 *   2. ดึงรูปลายเซ็นได้เฉพาะของตัวเอง (GET /me) — ไม่มี endpoint ไหนคืนรูปของคนอื่นแบบตรงๆ
 *   3. ลายเซ็นของคนอื่นเห็นได้ทางเดียว: อยู่ในเอกสารที่คนนั้น "ลงนามจริงแล้ว" และผู้เรียกมีสิทธิ์
 *      เห็นเอกสารนั้น (ดู GET /api/expenses/:id/signatures)
 *   4. ระบบผนึกลายเซ็นลงเอกสารตอน "ผู้นั้นกดทำรายการเอง" เท่านั้น (ออกใบ / อนุมัติ) —
 *      ไม่มีทางที่ใครจะเอาลายเซ็นคนอื่นไปแปะใบที่คนนั้นไม่ได้แตะ
 */
const crypto = require("crypto");
const express = require("express");

const Signature = require("../models/Signature");
const SignatureImage = require("../models/SignatureImage");
const User = require("../models/User");
const verifyToken = require("../middleware/auth");
const { can } = require("../config/roles");

const router = express.Router();

/** ⚠️ ใหญ่กว่านี้ไม่ใช่ลายเซ็นแล้ว (ลายเซ็นวาด/ครอปแล้วปกติ 5–60KB) และรูปใหญ่ทำให้ PDF อืด */
const MAX_BYTES = 300 * 1024;
const DATA_URL = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/;

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

/**
 * ตรวจ dataURL ที่ client ส่งมา — ต้องเป็น PNG จริงเท่านั้น
 * ⚠️ ห้ามรับ SVG เด็ดขาด: SVG คือไฟล์ข้อความที่ฝัง <script> ได้ ถ้าเอาไปแสดงในเบราว์เซอร์
 * (หรือเปิดเป็นไฟล์ตรงๆ) จะกลายเป็นช่องยิง XSS ด้วยลายเซ็น
 * ⚠️ ตรวจ magic bytes ของ PNG ด้วย ไม่ใช่เชื่อแค่ prefix ที่ client เขียนมาเอง
 */
const readImage = (raw) => {
  const value = String(raw || "").trim();
  const m = value.match(DATA_URL);
  if (!m) return { error: "ไฟล์ลายเซ็นต้องเป็นรูป PNG เท่านั้น" };
  let buf;
  try {
    buf = Buffer.from(m[1], "base64");
  } catch {
    return { error: "ไฟล์ลายเซ็นเสียหาย กรุณาลองใหม่" };
  }
  if (!buf.length) return { error: "ไฟล์ลายเซ็นว่างเปล่า" };
  if (buf.length > MAX_BYTES) return { error: `ไฟล์ลายเซ็นใหญ่เกินไป (${Math.round(buf.length / 1024)} KB) ต้องไม่เกิน ${MAX_BYTES / 1024} KB` };
  const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!buf.subarray(0, 8).equals(PNG_MAGIC)) return { error: "ไฟล์ลายเซ็นไม่ใช่รูป PNG ที่ถูกต้อง" };
  // ขนาดภาพอยู่ใน IHDR chunk (ไบต์ 16–24) — เก็บไว้ให้ฝั่ง PDF คำนวณสัดส่วนได้โดยไม่ต้องโหลดรูปก่อน
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (!width || !height || width > 4000 || height > 4000) return { error: "ขนาดรูปลายเซ็นไม่ถูกต้อง" };
  return { image: value, bytes: buf.length, width, height };
};

const view = (sig, img) => ({
  hash: sig.hash,
  image: img?.image || "",
  width: img?.width || 0,
  height: img?.height || 0,
  method: sig.method,
  consentAt: sig.consentAt,
  updatedAt: sig.updatedAt,
});

/**
 * เก็บรูปลายเซ็นลงคลัง (dedup ด้วย hash) แล้วคืน hash
 * ⚠️ ใช้ทั้งที่นี่และตอนผนึกลงเอกสาร — เอกสารเก็บแค่ hash ไม่ได้ถือสำเนารูป
 */
const storeImage = async (userId, img) => {
  const hash = sha256(img.image);
  await SignatureImage.updateOne(
    { hash },
    { $setOnInsert: { hash, userId, image: img.image, bytes: img.bytes, width: img.width, height: img.height } },
    { upsert: true }
  );
  return hash;
};

/** ลายเซ็นปัจจุบันของตัวเอง (พร้อมรูป) — ใช้ในหน้าตั้งค่า และตอนออกเอกสารที่ตัวเองเป็นผู้ลงนาม */
router.get("/me", verifyToken, async (req, res) => {
  try {
    const sig = await Signature.findOne({ userId: String(req.userId) }).lean();
    if (!sig) return res.json({ signature: null });
    const img = await SignatureImage.findOne({ hash: sig.hash }).lean();
    res.json({ signature: view(sig, img) });
  } catch (err) {
    console.error("❌ ดึงลายเซ็นไม่สำเร็จ:", err);
    res.status(500).json({ message: "ดึงลายเซ็นไม่สำเร็จ" });
  }
});

/**
 * ตั้ง/เปลี่ยนลายเซ็นของตัวเอง
 * ⚠️ ต้องมี consent = true ทุกครั้ง — การกดยอมรับคือหลักฐานว่าเจ้าตัวยินยอมให้ระบบใช้ลายเซ็นนี้
 * แทนการเซ็นด้วยมือ (จำเป็นเมื่อเอกสารถูกใช้ทางการเงิน/ส่งให้ลูกค้า)
 */
router.put("/me", verifyToken, async (req, res) => {
  try {
    if (req.body.consent !== true && req.body.consent !== "true") {
      return res.status(400).json({ message: "กรุณายอมรับเงื่อนไขการใช้ลายเซ็นอิเล็กทรอนิกส์ก่อน" });
    }
    const img = readImage(req.body.image);
    if (img.error) return res.status(400).json({ message: img.error });

    const userId = String(req.userId);
    const hash = await storeImage(userId, img);
    const method = req.body.method === "upload" ? "upload" : "draw";
    const me = { userId, name: String(req.user?.fname || req.user?.username || "").trim() };
    const sig = await Signature.findOneAndUpdate(
      { userId },
      { $set: { hash, method, consentAt: new Date(), setBy: me } },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    ).lean();
    const stored = await SignatureImage.findOne({ hash }).lean();
    res.json({ signature: view(sig, stored) });
  } catch (err) {
    console.error("❌ บันทึกลายเซ็นไม่สำเร็จ:", err);
    res.status(500).json({ message: "บันทึกลายเซ็นไม่สำเร็จ" });
  }
});

/**
 * เลิกใช้ลายเซ็นกับใบใหม่
 * ⚠️ ไม่ลบรูปในคลัง (SignatureImage) — เอกสารที่เซ็นไว้แล้วยังอ้างถึงรูปนั้นอยู่ ต้องพิมพ์ซ้ำได้เหมือนเดิม
 */
router.delete("/me", verifyToken, async (req, res) => {
  try {
    await Signature.deleteOne({ userId: String(req.userId) });
    res.json({ ok: true });
  } catch (err) {
    console.error("❌ ลบลายเซ็นไม่สำเร็จ:", err);
    res.status(500).json({ message: "ลบลายเซ็นไม่สำเร็จ" });
  }
});

/**
 * ใครตั้งลายเซ็นไว้แล้วบ้าง (ไม่มีรูป มีแต่สถานะ) — ผู้จัดการใช้ตามคนที่ยังไม่ได้ตั้ง
 * 🔒 ไม่คืนรูปเด็ดขาด แม้เป็นแอดมิน — สถานะพอสำหรับงานติดตาม ส่วนรูปไม่มีเหตุผลให้คนอื่นเห็น
 */
router.get("/status", verifyToken, async (req, res) => {
  try {
    if (!can(req.user, "manageMasterData")) {
      return res.status(403).json({ message: "คุณไม่มีสิทธิ์ดูสถานะลายเซ็นของพนักงาน" });
    }
    const [rows, users] = await Promise.all([
      Signature.find({}).select("userId updatedAt method").lean(),
      User.find({}).select("_id fname lname role").lean(),
    ]);
    const byUser = new Map(rows.map((r) => [String(r.userId), r]));
    res.json({
      users: users.map((u) => {
        const sig = byUser.get(String(u._id));
        return {
          userId: String(u._id),
          name: [u.fname, u.lname].filter(Boolean).join(" ") || "",
          role: u.role || "",
          hasSignature: Boolean(sig),
          updatedAt: sig?.updatedAt || null,
        };
      }),
    });
  } catch (err) {
    console.error("❌ ดึงสถานะลายเซ็นไม่สำเร็จ:", err);
    res.status(500).json({ message: "ดึงสถานะลายเซ็นไม่สำเร็จ" });
  }
});

module.exports = router;
