/**
 * signatureSeal — ผนึกลายเซ็นอิเล็กทรอนิกส์ลงเอกสาร และดึงรูปของลายเซ็นที่ผนึกไว้
 *
 * ✅ ใช้ร่วมกันทุก route ที่มีเอกสารต้องลงนาม (ใบเบิก Advance / ใบเคลม / ใบสำรองจ่าย)
 * ดูกฎความปลอดภัยทั้งหมดที่ routes/signatures.js
 *
 * ⚠️ เอกสารเก็บแค่ hash + ชื่อ + เวลา ไม่ได้ถือสำเนารูป (models/SignatureImage.js อธิบายเหตุผล)
 */
const Signature = require("../models/Signature");
const SignatureImage = require("../models/SignatureImage");

/**
 * ผนึกลายเซ็นของ "ผู้ที่กดทำรายการเอง" ลงเอกสาร
 * @param {string} userId  ต้องเป็น req.userId ของผู้กดเท่านั้น — ห้ามส่ง id ที่ client เลือกมาเอง
 *   ไม่งั้นจะเปิดช่องให้เอาลายเซ็นคนอื่นไปแปะใบที่คนนั้นไม่ได้แตะ
 * @returns {Promise<{userId, name, position, signedAt, hash} | null>} null = ยังไม่ได้ตั้งลายเซ็น
 */
const sealFor = async (userId, { name = "", position = "" } = {}) => {
  const id = String(userId || "");
  if (!id) return null;
  const sig = await Signature.findOne({ userId: id }).lean();
  if (!sig) return null;
  return { userId: id, name, position, signedAt: new Date(), hash: sig.hash };
};

/** @returns {Promise<Map<string, {hash, image, width, height}>>} รูปของ hash ที่ผนึกไว้ในเอกสาร */
const imagesFor = async (seals = []) => {
  const hashes = [...new Set(seals.filter((s) => s?.hash).map((s) => s.hash))];
  if (!hashes.length) return new Map();
  const rows = await SignatureImage.find({ hash: { $in: hashes } }).select("hash image width height").lean();
  return new Map(rows.map((r) => [r.hash, r]));
};

module.exports = { sealFor, imagesFor };
