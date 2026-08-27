const express = require("express");
const router = express.Router();

const mongoose = require("mongoose");

const DocCounter = require("../models/DocCounter");
// ✅ ใช้ตรวจว่า "ผู้ขอเลข" เกี่ยวข้องกับงานที่อ้างอิงจริงไหม ตอนคนขอไม่ใช่ admin/manager (ดู POST /next)
const CalendarEvent = require("../models/Events");
const verifyToken = require("../middleware/auth");
const { can } = require("../config/roles");

/**
 * เลขที่เอกสารแบบเดินหน้าอย่างเดียว (running number) — ใช้กับ "ใบส่งมอบงาน" เป็นตัวแรก
 * และเพิ่มชนิดเอกสารอื่นได้ในอนาคตโดยไม่ต้องแก้ route นี้ (แค่ส่ง docType ใหม่เข้ามา)
 *
 * ⚠️ ต้องเป็น POST ไม่ใช่ GET — การขอเลขมี "ผลข้างเคียง" คือกินเลขนั้นไปแล้ว (เลขเดิมจะไม่ถูกแจก
 * ให้ใครอีก) ถ้าทำเป็น GET เบราว์เซอร์/proxy อาจ prefetch หรือ cache แล้วเลขกระโดดหาย/ซ้ำได้
 */

// ชนิดเอกสารที่อนุญาต + ความยาวเลขลำดับของแต่ละชนิด
// ✅ whitelist ไว้ กัน client ส่ง docType มั่วมาจนสร้างตัวนับขยะค้างในฐานข้อมูลไม่รู้จบ
const DOC_TYPES = {
  delivery: { pad: 6, label: "ใบส่งมอบงาน" },
  // ✅ ใบแจ้งเข้าปฏิบัติงาน — ตัวนับแยกจากใบส่งมอบงานคนละชุด (คีย์คือ "<docType>:<ปี>") เอกสารคนละ
  // ชนิดกันต้องมีลำดับของตัวเอง ไม่งั้นเลขของทั้งสองชนิดจะกระโดดข้ามกันไปมาจนตามหาใบไม่เจอ
  notice: { pad: 6, label: "ใบแจ้งเข้าปฏิบัติงาน" },
};

// ปี พ.ศ. — เลขที่เอกสารของบริษัทใช้รูปแบบ <ลำดับ>/<ปี พ.ศ.> (เช่น 050008/2569)
const buddhistYear = () => new Date().getFullYear() + 543;

// POST /api/doc-number/next   body: { docType: "delivery" }
router.post("/next", verifyToken, async (req, res) => {
  try {
    // ✅ ช่างออกใบส่งมอบงาน "ของงานตัวเอง" ได้ด้วย (ตามที่ผู้ใช้ขอ) — แต่ต้องพิสูจน์ก่อนว่าเกี่ยวข้องกับ
    // งานนั้นจริง โดยส่ง eventId มาให้ตรวจ ไม่ใช่ให้ใครก็ได้ยิงขอเลขเปล่าๆ
    // ⚠️ ทำไมต้องผูกกับ eventId: เลขที่เอกสารเป็นเลขเดินหน้าของทั้งบริษัท ห้ามซ้ำและ "ห้ามข้าม" —
    // ทุกครั้งที่ขอคือกินเลขไปจริง คืนไม่ได้ ถ้าเปิดให้ขอลอยๆ ได้ เลขจะโดนกินทิ้งจากการกดพลาด/กดเล่น
    // แล้วสมุดทะเบียนเอกสารจะมีช่องโหว่ที่อธิบายไม่ได้ตอนตรวจสอบย้อนหลัง
    // ⚠️ admin/manager ยังขอได้โดยไม่ต้องมี eventId (ออกเอกสารนอกระบบงานได้ตามปกติ)
    const isAdminOrManager = can(req.user, "editDocuments");
    if (!isAdminOrManager) {
      const eventId = req.body?.eventId;
      if (!eventId || !mongoose.isValidObjectId(eventId)) {
        return res.status(403).json({ message: "ออกเลขที่เอกสารได้เฉพาะงานที่คุณเกี่ยวข้องเท่านั้น" });
      }
      const ev = await CalendarEvent.findById(eventId)
        .select("userId resPerson team responsiblePersonId responsiblePerson teamMembers").lean();
      if (!ev) return res.status(404).json({ message: "ไม่พบงานที่อ้างอิง" });
      const uid = String(req.userId);
      const isRelated =
        String(ev.userId) === uid ||
        (ev.resPerson && ev.resPerson === uid) ||
        (ev.team && ev.team === req.user.fname) ||
        (ev.responsiblePersonId && ev.responsiblePersonId === uid) ||
        (ev.responsiblePerson && ev.responsiblePerson === req.user.fname) ||
        (ev.teamMembers || []).some(
          (m) => (m?.userId && m.userId === uid) || (m?.name && m.name === req.user.fname)
        );
      if (!isRelated) {
        return res.status(403).json({ message: "ออกเลขที่เอกสารได้เฉพาะงานที่คุณเกี่ยวข้องเท่านั้น" });
      }
    }

    const docType = String(req.body?.docType || "delivery");
    const cfg = DOC_TYPES[docType];
    if (!cfg) return res.status(400).json({ message: "ชนิดเอกสารไม่ถูกต้อง" });

    const year = buddhistYear();
    const key = `${docType}:${year}`;

    // ⚠️ atomic — upsert + $inc ในคำสั่งเดียว MongoDB การันตีว่าต่อให้ยิงพร้อมกันหลายคน
    // แต่ละคนจะได้ค่า seq ไม่ซ้ำกันแน่นอน (ไม่ต้อง transaction/lock เพิ่ม)
    const counter = await DocCounter.findOneAndUpdate(
      { key },
      { $inc: { seq: 1 } },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    const seq = counter.seq;
    res.json({
      docNumber: `${String(seq).padStart(cfg.pad, "0")}/${year}`,
      seq,
      year,
      docType,
    });
  } catch (err) {
    console.error("❌ ออกเลขที่เอกสารไม่สำเร็จ:", err);
    res.status(500).json({ message: "ออกเลขที่เอกสารไม่สำเร็จ กรุณาลองใหม่อีกครั้ง" });
  }
});

// GET /api/doc-number/peek?docType=delivery
// ✅ ดูว่า "เลขถัดไปจะเป็นอะไร" โดยไม่กินเลข — ใช้เติมให้ในฟอร์มตอนเปิดกล่องออกเอกสาร ผู้ใช้จะได้
// เห็นเลขล่วงหน้าก่อนตัดสินใจกดออกจริง (ถ้าเปิดแล้วปิดไปเฉยๆ เลขจะไม่ถูกกินทิ้งไปฟรีๆ)
// ⚠️ เลขที่ได้จากตรงนี้เป็นแค่ "ตัวอย่าง" ไม่ใช่การจอง — ตอนกดออกจริงต้องเรียก POST /next เสมอ
// เพื่อให้ได้เลขที่การันตีว่าไม่ซ้ำกับใคร
router.get("/peek", verifyToken, async (req, res) => {
  try {
    const docType = String(req.query?.docType || "delivery");
    const cfg = DOC_TYPES[docType];
    if (!cfg) return res.status(400).json({ message: "ชนิดเอกสารไม่ถูกต้อง" });

    const year = buddhistYear();
    const counter = await DocCounter.findOne({ key: `${docType}:${year}` }).lean();
    const nextSeq = (counter?.seq || 0) + 1;

    res.json({
      docNumber: `${String(nextSeq).padStart(cfg.pad, "0")}/${year}`,
      seq: nextSeq,
      year,
      docType,
    });
  } catch (err) {
    console.error("❌ ดูเลขที่เอกสารถัดไปไม่สำเร็จ:", err);
    res.status(500).json({ message: "ดูเลขที่เอกสารถัดไปไม่สำเร็จ" });
  }
});

module.exports = router;
