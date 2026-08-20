const express = require("express");
const router = express.Router();

const IssuedDocument = require("../models/IssuedDocument");
const verifyToken = require("../middleware/auth");

const DOC_STATUSES = ["issued", "sent", "acknowledged", "cancelled"];
const DOC_TYPES = ["notice", "delivery"];

const isAdminOrManager = (req) => ["admin", "manager"].includes(req.user?.role);

/**
 * ทะเบียนเอกสารที่ออกจริง — ดู models/IssuedDocument.js สำหรับเหตุผลว่าทำไมต้องมีตารางนี้
 *
 * ⚠️ ทุก endpoint ต้องล็อกอิน และการ "เขียน" (บันทึกใบใหม่/เปลี่ยนสถานะ) จำกัดเฉพาะ admin/manager
 * ให้ตรงกับสิทธิ์ออกเลขที่เอกสาร (routes/docNumber.js) — คนที่ออกเอกสารไม่ได้ ก็ไม่ควรแก้ทะเบียนได้
 * ✅ ส่วนการ "อ่าน" เปิดให้ทุก role — ช่างต้องตามหาใบที่เคยออกให้งานของตัวเองได้ (เช่น ลูกค้าถามหา
 * ใบแจ้งเข้างานที่ส่งไปแล้ว) ซึ่งเป็นข้อมูลของบริษัทเอง ไม่ใช่ข้อมูลส่วนตัวของใคร
 */

// GET /api/issued-documents?docType=&status=&q=&from=&to=&page=&limit=
router.get("/", verifyToken, async (req, res) => {
  try {
    const { docType, status, q, from, to } = req.query;
    const page = Math.max(1, Number(req.query.page) || 1);
    // ⚠️ เพดาน 200 — กันคำขอที่ส่ง limit มหาศาลมาดึงทั้งตารางทีเดียวจนหน่วยความจำ server บวม
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));

    // 🐛 BUG ที่แก้ (ตัวเลขบนชิปสถานะเพี้ยนหมดเมื่อกดกรอง): เดิมนับยอดแต่ละสถานะจาก "ชุดที่กรองแล้ว"
    // ซึ่งรวมตัวกรองสถานะเข้าไปด้วย — พอกดชิป "ลูกค้ารับแล้ว" ตัวกรองจะเหลือเฉพาะสถานะนั้น ยอดของ
    // สถานะอื่นทุกตัวจึงกลายเป็น 0 ทันที (และยอด "ทั้งหมด" ก็เหลือเท่าสถานะที่เลือก) ทั้งที่ชิปพวกนั้น
    // มีหน้าที่บอกว่า "ถ้ากดไปจะเจอกี่ใบ" ไม่ใช่ "ในชุดที่กรองอยู่มีกี่ใบ"
    // ✅ แยกเป็น 2 ตัวกรอง: baseFilter (ทุกเงื่อนไข "ยกเว้น" สถานะ) ใช้นับยอดชิป — ยอดจึงคงที่และ
    // ถูกต้องเสมอไม่ว่าจะเลือกชิปไหนอยู่ ส่วน filter (รวมสถานะ) ใช้ดึงรายการจริง
    const baseFilter = {};
    if (docType && DOC_TYPES.includes(docType)) baseFilter.docType = docType;

    // ✅ ช่วงวันที่ "ออกเอกสาร" — to ต้องครอบทั้งวัน (ผู้ใช้เลือก 12/8 ต้องได้ใบที่ออกตอน 23:59 ด้วย)
    if (from || to) {
      baseFilter.issuedAt = {};
      if (from) baseFilter.issuedAt.$gte = new Date(from);
      if (to) {
        const end = new Date(to);
        end.setHours(23, 59, 59, 999);
        baseFilter.issuedAt.$lte = end;
      }
    }

    // ✅ ค้นหาข้ามหลายช่องพร้อมกัน — ผู้ใช้จำได้บ้างไม่ได้บ้างว่าใบนั้นเลขอะไร/ของโครงการไหน
    // ⚠️ escape อักขระพิเศษของ regex ก่อนเสมอ ไม่งั้นพิมพ์ "(" ลงช่องค้นหาแล้ว query พังทั้งคำขอ
    if (q && String(q).trim()) {
      const safe = String(q).trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const rx = new RegExp(safe, "i");
      baseFilter.$or = [
        { docNumber: rx }, { subject: rx }, { site: rx },
        { customerCompany: rx }, { workLabel: rx }, { contractNo: rx },
        { signerName: rx }, { issuedByName: rx }, { note: rx },
      ];
    }

    // ตัวกรองที่ใช้ "ดึงรายการจริง" = baseFilter + สถานะที่เลือกอยู่ (ถ้ามี)
    const filter = { ...baseFilter };
    if (status && DOC_STATUSES.includes(status)) filter.status = status;

    const [items, total] = await Promise.all([
      IssuedDocument.find(filter)
        .sort({ issuedAt: -1, createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      IssuedDocument.countDocuments(filter),
    ]);

    // ✅ นับยอดชิปจาก baseFilter (ไม่รวมตัวกรองสถานะ) — ยอดบนชิปทุกตัวจึงเป็น "ถ้ากดไปจะเจอกี่ใบ"
    // เสมอ ไม่เปลี่ยนไปมาตามชิปที่เลือกอยู่ (ดูเหตุผลเต็มที่ baseFilter ด้านบน)
    // ✅ ยิงพร้อมกับ find/count ในรอบเดียว — เดิม await ต่อกันเป็นทอดๆ ทำให้หน้าโหลดช้ากว่าที่ควรเป็น
    const statusAgg = await IssuedDocument.aggregate([
      { $match: baseFilter },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]);
    const statusCounts = DOC_STATUSES.reduce((acc, s) => ({ ...acc, [s]: 0 }), {});
    statusAgg.forEach((r) => { statusCounts[r._id] = r.count; });
    // ✅ ยอด "ทั้งหมด" ของชิป = ผลรวมทุกสถานะใน baseFilter ไม่ใช่ total ของรายการที่กรองสถานะแล้ว
    const totalAll = Object.values(statusCounts).reduce((a, b) => a + b, 0);

    res.json({ items, total, totalAll, page, limit, statusCounts });
  } catch (err) {
    console.error("❌ ดึงทะเบียนเอกสารไม่สำเร็จ:", err);
    res.status(500).json({ message: "ดึงทะเบียนเอกสารไม่สำเร็จ" });
  }
});

// POST /api/issued-documents  — บันทึกใบที่เพิ่งออกจริง
router.post("/", verifyToken, async (req, res) => {
  try {
    // ✅ บันทึกได้ทุก role — ช่างออก "ใบแจ้งเข้างาน" ได้เองอยู่แล้ว (ใช้เลขที่อ้างอิงของงานแทนเลข
    // เดินหน้าของบริษัท ดู canUseRunningNumber ใน WorkNoticeDialog.js) ถ้าบล็อกการบันทึกไว้ที่
    // admin/manager ใบที่ช่างออกจะหายไปจากทะเบียนเงียบๆ ทั้งที่ส่งถึงลูกค้าไปแล้วจริง — ตามกลับไม่ได้เลย
    // ⚠️ ผู้ออกอ่านจาก token เสมอ (ดูด้านล่าง) ใครบันทึกก็เป็นเจ้าของแถวนั้น แก้ไขได้เฉพาะของตัวเอง
    const b = req.body || {};
    if (!DOC_TYPES.includes(b.docType)) {
      return res.status(400).json({ message: "ชนิดเอกสารไม่ถูกต้อง" });
    }
    if (!String(b.docNumber || "").trim()) {
      return res.status(400).json({ message: "ไม่มีเลขที่เอกสาร" });
    }

    const doc = await IssuedDocument.create({
      docType: b.docType,
      docNumber: String(b.docNumber).trim(),
      issuedAt: b.issuedAt ? new Date(b.issuedAt) : new Date(),
      subject: b.subject || "",
      site: b.site || "",
      customerCompany: b.customerCompany || "",
      workLabel: b.workLabel || "",
      roundLabel: b.roundLabel || "",
      signerName: b.signerName || "",
      eventId: b.eventId || null,
      contractNo: b.contractNo || "",
      formSnapshot: b.formSnapshot || {},
      // ⚠️ ผู้ออกเอกสารอ่านจาก token เท่านั้น ไม่รับจาก body — ไม่งั้นใครก็ส่งชื่อคนอื่นมาสวมได้
      issuedBy: req.user?._id || null,
      issuedByName: [req.user?.fname, req.user?.lname].filter(Boolean).join(" ") || req.user?.username || "",
    });

    res.status(201).json(doc);
  } catch (err) {
    console.error("❌ บันทึกทะเบียนเอกสารไม่สำเร็จ:", err);
    res.status(500).json({ message: "บันทึกทะเบียนเอกสารไม่สำเร็จ" });
  }
});

// PATCH /api/issued-documents/:id  — เปลี่ยนสถานะ / แก้บันทึกเพิ่มเติม
router.patch("/:id", verifyToken, async (req, res) => {
  try {
    // ✅ แอดมิน/ผู้จัดการแก้ได้ทุกใบ ส่วน role อื่นแก้ได้เฉพาะ "ใบที่ตัวเองเป็นคนออก" — ช่างต้องอัปเดต
    // สถานะใบของตัวเองได้ (ส่งให้ลูกค้าแล้ว/ลูกค้ารับแล้ว) ไม่งั้นทะเบียนจะค้างที่ "ออกแล้ว" ตลอดไป
    // และต้องไปรบกวนแอดมินให้กดให้ทุกใบ ⚠️ ตรวจที่ server เสมอ ไม่เชื่อการซ่อนปุ่มฝั่งจอ
    const target = await IssuedDocument.findById(req.params.id);
    if (!target) return res.status(404).json({ message: "ไม่พบเอกสารนี้ในทะเบียน" });
    const isOwner = String(target.issuedBy || "") === String(req.user?._id || "");
    if (!isAdminOrManager(req) && !isOwner) {
      return res.status(403).json({ message: "แก้ไขได้เฉพาะเอกสารที่คุณเป็นผู้ออกเท่านั้น" });
    }
    const update = {};
    if (req.body?.status !== undefined) {
      if (!DOC_STATUSES.includes(req.body.status)) {
        return res.status(400).json({ message: "สถานะไม่ถูกต้อง" });
      }
      update.status = req.body.status;
    }
    if (req.body?.note !== undefined) update.note = String(req.body.note || "");
    if (Object.keys(update).length === 0) {
      return res.status(400).json({ message: "ไม่มีข้อมูลที่จะแก้ไข" });
    }

    const doc = await IssuedDocument.findByIdAndUpdate(req.params.id, update, { new: true });
    if (!doc) return res.status(404).json({ message: "ไม่พบเอกสารนี้ในทะเบียน" });
    res.json(doc);
  } catch (err) {
    console.error("❌ แก้ไขทะเบียนเอกสารไม่สำเร็จ:", err);
    res.status(500).json({ message: "แก้ไขทะเบียนเอกสารไม่สำเร็จ" });
  }
});

module.exports = router;
