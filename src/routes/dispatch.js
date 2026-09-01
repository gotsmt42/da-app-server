/**
 * /api/dispatch — ใบมอบหมายงานข้ามแผนก
 *
 * สายงานที่รองรับ (ตามที่ผู้ใช้ระบุ):
 *   เซลปิดการขาย → ส่ง "คำขอ" พร้อมรายละเอียด/รูป/อะไหล่ → แอดมินเลือกช่าง (หลายคนได้) →
 *   ช่างแต่ละคนกดรับทราบ / เริ่มงาน / ปิดงานของตัวเอง → เซลผู้ขอเห็นความคืบหน้ารายคน
 *
 * ⚠️ **ลำดับ route ห้ามสลับ** — path ตายตัว (/my, /summary) ต้องมาก่อน /:id ทั้งหมด
 * ไม่งั้นจะถูกกลืนเงียบๆ กลายเป็นการหาใบมอบหมายที่ id ชื่อ "my" (ตรวจด้วย `npm run check:routes`)
 */
const express = require("express");
const moment = require("moment");
const multer = require("multer");
const streamifier = require("streamifier");

const Dispatch = require("../models/Dispatch");
const User = require("../models/User");
const CalendarEvent = require("../models/Events");
const { thaiDate } = require("../utils/thaiDate");
const JobType = require("../models/JobType");
const SystemType = require("../models/SystemType");
const Customer = require("../models/Customer");
const DocCounter = require("../models/DocCounter");
const verifyToken = require("../middleware/auth");
const { can, SUPERVISOR_ROLES, DEPARTMENT, ROLES } = require("../config/roles");
const { cloudinary } = require("../config/cloudinary");
const { fileFilter, limits } = require("../config/upload");
const { sendPushToUsers, sendPushToRoles } = require("../services/PushNotify");

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), fileFilter, limits });

const actor = (req) => ({
  userId: String(req.user?._id || req.userId || ""),
  name:
    [req.user?.fname, req.user?.lname].filter(Boolean).join(" ") || req.user?.username || "ไม่ทราบชื่อ",
  role: String(req.user?.role || ""),
});

const buddhistYear = () => new Date().getFullYear() + 543;

const nextDispatchNo = async () => {
  const year = buddhistYear();
  const c = await DocCounter.findOneAndUpdate(
    { key: `dispatch:${year}` },
    { $inc: { seq: 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
  return `WO-${String(c.seq).padStart(5, "0")}/${year}`;
};

/**
 * ✅ ขอบเขตข้อมูล — จุดเดียวที่ตัดสินว่าใครเห็นใบไหน
 * ⚠️ ต้องใช้กับทุก query ที่อ่านใบมอบหมาย ไม่มีข้อยกเว้น
 *   • หัวหน้า (assignDispatch) เห็นทั้งหมด — เป็นคนจ่ายงาน ต้องเห็นคิวทั้งคิว
 *   • ผู้ขอ เห็นเฉพาะใบที่ตัวเองขอ  ← ข้อกำหนด "เซลเห็นเฉพาะงานที่ตัวเองส่งให้"
 *   • ผู้รับงาน เห็นเฉพาะใบที่มีชื่อตัวเองอยู่
 * ⚠️ fail closed — ถ้าไม่เข้าเงื่อนไขไหนเลยต้องได้ผลว่าง ไม่ใช่เห็นทุกใบ
 */
const scopeFor = (req) => {
  if (can(req.user, "assignDispatch")) return {};
  const uid = String(req.userId || "");
  return { $or: [{ "requestedBy.userId": uid }, { "assignees.userId": uid }] };
};

const canSeeDoc = (req, doc) => {
  if (can(req.user, "assignDispatch")) return true;
  const uid = String(req.userId || "");
  return (
    String(doc?.requestedBy?.userId || "") === uid ||
    (doc?.assignees || []).some((a) => String(a.userId) === uid)
  );
};

const log = (doc, action, detail, me) => {
  doc.activityLog = doc.activityLog || [];
  doc.activityLog.push({ action, detail, userId: me.userId, userName: me.name, timestamp: new Date() });
};

/**
 * ⚠️ docType มาจากอาร์เรย์คู่ขนานที่ฝั่งจอส่งมา (docTypes[i] ตรงกับ files[i]) — multipart ไม่มี
 * ทางแนบ metadata ไปกับไฟล์แต่ละใบโดยตรง จึงต้องพึ่งลำดับ ถ้าค่าไม่ถูกต้องให้ตกเป็น "other"
 * แทนที่จะโยน error ทิ้งไฟล์ที่อัปสำเร็จไปแล้ว
 */
const uploadToCloud = async (file, folder, uploadedBy = "", docType = "other") => {
  const originalName = Buffer.from(file.originalname, "latin1").toString("utf8");
  const sanitized = originalName.replace(/[^\w\-.]/g, "_");
  const isImage = ["image/jpeg", "image/png", "image/webp"].includes(file.mimetype);
  const result = await new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        resource_type: isImage ? "image" : "raw",
        folder,
        public_id: `${Date.now()}_${isImage ? sanitized.replace(/\.[^.]+$/, "") : sanitized}`,
        use_filename: false, unique_filename: false, overwrite: true,
      },
      (err, uploaded) => (err ? reject(err) : resolve(uploaded))
    );
    streamifier.createReadStream(file.buffer).pipe(stream);
  });
  const safeType = Dispatch.DOC_TYPES.includes(docType) ? docType : "other";
  return { docType: safeType, fileName: originalName, fileUrl: result.secure_url, fileType: file.mimetype, uploadedAt: new Date(), uploadedBy };
};

/** ชนิดเอกสารของไฟล์ลำดับที่ i — ฝั่งจอส่งมาเป็น docTypes[] เรียงตรงกับ files[] */
const docTypeAt = (req, i) => {
  const raw = req.body?.docTypes;
  const arr = Array.isArray(raw) ? raw : (typeof raw === "string" && raw ? [raw] : []);
  return arr[i] || "other";
};

/**
 * รับเฉพาะลิงก์ที่เปิดได้จริงและเป็น http(s) เท่านั้น
 * ⚠️ กันไว้ที่นี่เพราะค่านี้ถูกเอาไปใส่ href บนหน้าจอ — ถ้าปล่อยให้เป็น "javascript:..." ผ่านได้
 * จะกลายเป็นช่องทาง XSS ที่ยิงใส่ช่างทุกคนที่เปิดใบนั้น
 * ⚠️ ไม่จำกัดว่าต้องเป็นโดเมนของ Google — ผู้ใช้บางคนแปะลิงก์จากแอปแผนที่อื่นหรือลิงก์ย่อ
 * ซึ่งก็ยังพาไปที่ถูกต้อง การบล็อกโดเมนอื่นจะสร้างปัญหามากกว่าที่แก้
 */
const safeMapUrl = (raw) => {
  const v = String(raw || "").trim();
  if (!v) return "";
  try {
    const u = new URL(v);
    return ["http:", "https:"].includes(u.protocol) ? v : "";
  } catch {
    return "";
  }
};

/**
 * เก็บค่าที่แจ้งมาเข้าตารางกลาง (ประเภทงาน / ระบบ / ทะเบียนลูกค้า) ตอนอนุมัติ
 *
 * ✅ ทำแบบเดียวกับฟอร์มของช่าง (ดู AddEvent.js ฝั่งหน้าจอ ที่ upsert ตอนสร้างแผนงาน) —
 * ค่าที่พิมพ์ใหม่ต้องกลายเป็นตัวเลือกให้ครั้งถัดไป ไม่งั้นทุกคนต้องพิมพ์ซ้ำเองตลอดไป
 * และชื่อจะสะกดเพี้ยนกันจนกรองงานตามโครงการ/ระบบไม่เจอ
 *
 * ⚠️ ทำตอน *อนุมัติ* ไม่ใช่ตอนส่งคำขอ — คำขอที่ถูกตีกลับไม่ควรทิ้งขยะไว้ในตารางกลาง
 * ⚠️ ห้ามให้พังทั้งการอนุมัติถ้า upsert ไม่สำเร็จ — เป็นผลพลอยได้ ไม่ใช่สาระของการอนุมัติ
 * (ชนกับ unique index เป็นเรื่องปกติเมื่อมีคนกดพร้อมกัน)
 */
async function upsertLookups({ title, system, company, site, ownerId }) {
  const jobs = [];
  if (title) jobs.push(JobType.updateOne({ name: title }, { $setOnInsert: { name: title } }, { upsert: true }));
  if (system) jobs.push(SystemType.updateOne({ name: system }, { $setOnInsert: { name: system } }, { upsert: true }));
  // ⚠️ ทะเบียนลูกค้ามี unique index ที่ (cCompany, cSite) — ต้อง match ด้วยคู่นี้เท่านั้น
  if (company && site) {
    // ⚠️ ต้องใส่ userId ให้แถวใหม่เสมอ — หน้าทะเบียนลูกค้าและ GET /api/customer อ่านฟิลด์นี้
    // แถวไม่มีเจ้าของเคยทำให้ทั้ง endpoint ตอบ 500 มาแล้ว (ดู routes/customer.js)
    jobs.push(Customer.updateOne(
      { cCompany: company, cSite: site },
      { $setOnInsert: { cCompany: company, cSite: site, userId: ownerId } },
      { upsert: true }
    ));
  }
  const results = await Promise.allSettled(jobs);
  results.forEach((r) => {
    if (r.status === "rejected") console.warn("⚠️ upsert ตารางกลางไม่สำเร็จ:", r.reason?.message);
  });
}

/**
 * แนบ "สถานะงานจริง" จากแผนงานที่ผูกไว้ เข้าไปในใบแจ้งงานก่อนส่งกลับหน้าจอ
 *
 * ⚠️ โหลดทีเดียวทั้งชุด ($in) ไม่ใช่ยิงทีละใบ — คิวมีเป็นร้อยใบได้ การ query ในลูปคือ N+1
 * ⚠️ ใบที่ยังไม่อนุมัติไม่มี event จึงไม่มี job — หน้าจอต้องรองรับกรณีนี้เสมอ
 */
async function attachJob(docs) {
  const list = Array.isArray(docs) ? docs : [docs];
  const ids = list.map((d) => d?.eventId).filter(Boolean);
  if (ids.length === 0) return docs;
  const events = await CalendarEvent.find({ _id: { $in: ids } })
    .select("status start end responsiblePerson team date").lean();
  const byId = new Map(events.map((e) => [String(e._id), e]));
  list.forEach((d) => {
    const ev = d?.eventId ? byId.get(String(d.eventId)) : null;
    if (!d) return;
    d.job = ev
      ? {
          status: ev.status,
          start: ev.start || ev.date,
          end: ev.end,
          responsiblePerson: ev.responsiblePerson || ev.team || "",
        }
      : null;
  });
  return docs;
}

const jobLabel = (d) =>
  [d.customer?.company, d.customer?.site, d.title].filter(Boolean).join(" · ") || d.title;

/** แปลง JSON ที่ส่งมาในรูปแบบ multipart (ค่าเป็นสตริง) ให้กลับเป็น array */
const parseJsonArray = (raw) => {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

// ══ path ตายตัว (ต้องมาก่อน /:id) ══════════════════════════════════════════

/** งานที่มอบหมายให้ฉัน — หน้าของช่าง */
router.get("/my", verifyToken, async (req, res) => {
  try {
    const uid = String(req.userId || "");
    const query = { "assignees.userId": uid };
    // ค่าเริ่มต้นซ่อนใบที่จบ/ยกเลิกแล้ว — ช่างสนใจงานที่ยังต้องทำ
    if (req.query.include !== "all") query.status = { $nin: ["done", "cancelled"] };
    const dispatches = await Dispatch.find(query).sort({ priority: -1, dueAt: 1, requestedAt: -1 }).lean();
    await attachJob(dispatches);
    res.json({ dispatches });
  } catch (err) {
    console.error("❌ ดึงงานที่ได้รับมอบหมายไม่สำเร็จ:", err);
    res.status(500).json({ message: "ดึงงานที่ได้รับมอบหมายไม่สำเร็จ" });
  }
});

/** ตัวเลขสรุปบนหัวกระดานจ่ายงาน */
router.get("/summary", verifyToken, async (req, res) => {
  try {
    const rows = await Dispatch.aggregate([
      { $match: scopeFor(req) },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]);
    const byStatus = { requested: 0, assigned: 0, in_progress: 0, done: 0, cancelled: 0 };
    rows.forEach((r) => { if (byStatus[r._id] !== undefined) byStatus[r._id] = r.count; });

    const urgentOpen = await Dispatch.countDocuments({
      ...scopeFor(req), priority: "urgent", status: { $nin: ["done", "cancelled"] },
    });
    const overdue = await Dispatch.countDocuments({
      ...scopeFor(req), dueAt: { $lt: new Date() }, status: { $nin: ["done", "cancelled"] },
    });
    res.json({ byStatus, urgentOpen, overdue });
  } catch (err) {
    console.error("❌ สรุปใบมอบหมายไม่สำเร็จ:", err);
    res.status(500).json({ message: "ดึงสรุปไม่สำเร็จ" });
  }
});

/** รายชื่อคนที่มอบหมายงานได้ (ตามแผนก) — ใช้เติมตัวเลือกในกล่องจ่ายงาน */
router.get("/assignable", verifyToken, async (req, res) => {
  try {
    if (!can(req.user, "assignDispatch")) {
      return res.status(403).json({ message: "เฉพาะแอดมิน/ผู้จัดการเท่านั้นที่มอบหมายงานได้" });
    }
    // ⚠️ ตอนนี้มีแค่แผนกบริการ (ช่าง) — เพิ่มแผนกใหม่ให้เพิ่ม role ที่ receiveDispatch ใน config/roles.js
    const users = await User.find({ role: ROLES.TECHNICIAN })
      .select("fname lname username role imageUrl").lean();
    res.json({ users });
  } catch (err) {
    console.error("❌ ดึงรายชื่อผู้รับงานไม่สำเร็จ:", err);
    res.status(500).json({ message: "ดึงรายชื่อผู้รับงานไม่สำเร็จ" });
  }
});

/** รายการใบมอบหมาย (กรองตามสิทธิ์) */
router.get("/", verifyToken, async (req, res) => {
  try {
    const query = { ...scopeFor(req) };
    if (req.query.status) query.status = req.query.status;
    else if (req.query.include !== "all") query.status = { $nin: ["cancelled"] };
    if (req.query.department) query.department = req.query.department;

    const dispatches = await Dispatch.find(query).sort({ requestedAt: -1 }).lean();
    await attachJob(dispatches);
    res.json({ dispatches });
  } catch (err) {
    console.error("❌ ดึงใบมอบหมายไม่สำเร็จ:", err);
    res.status(500).json({ message: "ดึงใบมอบหมายไม่สำเร็จ" });
  }
});

/**
 * สร้างคำขอมอบหมายงาน
 * ⚠️ ผู้ขอ "ไม่ได้เลือกช่างเอง" — ตามที่ผู้ใช้เลือกไว้ว่าเซลส่งคำขอแล้วแอดมินเป็นคนจ่ายงาน
 * (แอดมินคือคนเดียวที่เห็นคิวช่างทั้งหมด จึงเป็นคนเดียวที่จ่ายงานโดยไม่ชนคิวได้)
 */
router.post("/", verifyToken, upload.array("files", 10), async (req, res) => {
  try {
    if (!can(req.user, "requestDispatch")) {
      return res.status(403).json({ message: "คุณไม่มีสิทธิ์ส่งคำขอมอบหมายงาน" });
    }
    const title = String(req.body.title || "").trim();
    if (!title) return res.status(400).json({ message: "กรุณาระบุชื่องานที่ต้องการมอบหมาย" });
    // ✅ ที่แก้ (ผู้ใช้ขอ: "แก้ไขฟอร์มการแจ้งงาน ให้บังคับต้องกรอก จากบริษัท เป็นโครงการ"): เดิมบังคับ
    // company (ลูกค้า/บริษัท) — สลับมาบังคับ site (โครงการ/สาขา) แทน เพราะหน้างานจริงระบุด้วยชื่อ
    // โครงการเป็นหลัก ลูกค้าบางรายไม่มี "บริษัท" ที่ชัดเจน (บ้านเดี่ยว/นิติบุคคลอาคารชุด) แต่มีชื่อ
    // โครงการเสมอ — เข้าชุดกับฟอร์มนัดหมายเซลในปฏิทินที่สลับ required แบบเดียวกันไปแล้วก่อนหน้านี้
    const site = String(req.body.site || "").trim();
    if (!site) return res.status(400).json({ message: "กรุณาระบุโครงการ / สาขา" });
    const company = String(req.body.company || "").trim();

    /**
     * ── งานตามสัญญา (ไม่บังคับ) ────────────────────────────────────────
     * ✅ เซลเลือก "ครั้งถัดไปของสัญญาที่มีอยู่แล้ว" ได้ แบบเดียวกับฟอร์มของช่าง
     * ⚠️ ต้องตรวจกับของจริงในฐานข้อมูลเสมอ ห้ามเชื่อค่าที่ส่งมา — ไม่งั้นจะเกิดใบที่ชี้ไปยังสัญญาที่
     * ไม่มีอยู่ (หรือที่ครบจำนวนครั้งไปแล้ว) ซึ่งจะไปพังตอน *อนุมัติ* แทน คือหลังจากที่เซลส่งใบไปแล้ว
     * และแอดมินเสียเวลาตรวจไปแล้ว — ปฏิเสธตั้งแต่ตอนแจ้งตรงนี้ชัดเจนกว่ามาก
     */
    let contractSnapshot = null;
    const contractGroupId = String(req.body.contractGroupId || "").trim();
    if (contractGroupId) {
      const visits = await CalendarEvent.find({ contractGroupId })
        .select("visitCount contractNo time company site system title")
        .lean();
      if (!visits.length) {
        return res.status(400).json({ message: "ไม่พบสัญญาที่เลือก — อาจถูกลบไปแล้ว กรุณาเลือกใหม่" });
      }
      const head = visits.find((v) => v.visitCount) || visits[0];
      const visitCount = head.visitCount || 0;
      // นับ "ครั้งที่ไม่ซ้ำกัน" ให้ตรงกับที่ฝั่งหน้าจอ/endpoint รายชื่อสัญญาใช้ (countUsedRounds)
      const usedRounds = new Set(
        visits
          .filter((v) => v.time !== undefined && v.time !== null && v.time !== "")
          .map((v) => String(v.time))
      );
      if (visitCount > 0 && usedRounds.size >= visitCount) {
        return res.status(409).json({ message: "สัญญานี้ครบจำนวนครั้งแล้ว เลือกสัญญาอื่นหรือแจ้งเป็นงานทั่วไป" });
      }
      contractSnapshot = { groupId: contractGroupId, no: head.contractNo || "", visitCount };
    }

    const me = actor(req);

    const dispatch = new Dispatch({
      dispatchNo: await nextDispatchNo(),
      department: req.body.department || DEPARTMENT.SERVICE,
      status: "requested",
      requestedBy: me,
      requestedAt: new Date(),
      eventId: req.body.eventId || undefined,
      // ผูกกับสัญญาเฉพาะเมื่อเลือกมาจริงและผ่านการตรวจแล้ว (ดู contractSnapshot ด้านบน)
      ...(contractSnapshot ? { contract: contractSnapshot } : {}),
      customer: {
        // ⚠️ เก็บ company ให้มีค่าเสมอเช่นกัน (สลับทิศจากเดิม) — ใบที่ไม่มีชื่อบริษัทเลยยังต้องมี
        // ค่าอะไรสักอย่างให้การ์ด/ตารางแสดงผล ไม่งั้นจะโชว์ช่องว่างเปล่าๆ
        company: company || site,
        site,
        address: String(req.body.address || "").trim(),
        mapUrl: safeMapUrl(req.body.mapUrl),
        contactName: String(req.body.contactName || "").trim(),
        contactTel: String(req.body.contactTel || "").trim(),
      },
      title,
      detail: String(req.body.detail || "").trim(),
      note: String(req.body.note || "").trim(),
      system: String(req.body.system || "").trim(),
      priority: req.body.priority === "urgent" ? "urgent" : "normal",
      dueAt: req.body.dueAt || undefined,
      checklist: (parseJsonArray(req.body.checklist) || [])
        .map((c) => ({ item: String(typeof c === "string" ? c : c?.item || "").trim() }))
        .filter((c) => c.item),
      parts: (parseJsonArray(req.body.parts) || [])
        .map((p) => ({
          name: String(p?.name || "").trim(),
          qty: Number(p?.qty) > 0 ? Number(p.qty) : 1,
          unit: String(p?.unit || "").trim(),
          note: String(p?.note || "").trim(),
        }))
        .filter((p) => p.name),
    });

    for (const [i, f] of (req.files || []).entries()) {
      dispatch.attachments.push(await uploadToCloud(f, `dispatch/${dispatch._id}`, me.name, docTypeAt(req, i)));
    }
    log(dispatch, "dispatch_requested", `ส่งคำขอมอบหมายงาน: ${title}`, me);
    await dispatch.save();


    // ✅ แจ้งหัวหน้าทันที — ใบที่ไม่มีใครเห็นคือใบที่ไม่มีใครจ่ายงาน
    sendPushToRoles(SUPERVISOR_ROLES, {
      title: `🆕 คำขอมอบหมายงานใหม่จาก ${me.name}`,
      body: `${jobLabel(dispatch)}${dispatch.priority === "urgent" ? " · ⚡ ด่วน" : ""}`,
      url: `/dispatch/${dispatch._id}`,
      tag: `dispatch-${dispatch._id}`,
    }).catch((e) => console.error("push dispatch_requested:", e.message));

    res.status(201).json({ dispatch: dispatch.toObject() });
  } catch (err) {
    console.error("❌ สร้างคำขอมอบหมายงานไม่สำเร็จ:", err);
    res.status(500).json({ message: "สร้างคำขอมอบหมายงานไม่สำเร็จ" });
  }
});

// ══ /:id ══════════════════════════════════════════════════════════════════

router.get("/:id", verifyToken, async (req, res) => {
  try {
    const dispatch = await Dispatch.findById(req.params.id).lean();
    if (!dispatch) return res.status(404).json({ message: "ไม่พบใบมอบหมายนี้" });
    if (!canSeeDoc(req, dispatch)) return res.status(403).json({ message: "คุณไม่มีสิทธิ์ดูใบมอบหมายนี้" });
    await attachJob(dispatch);
    res.json({ dispatch });
  } catch (err) {
    console.error("❌ ดึงใบมอบหมายไม่สำเร็จ:", err);
    res.status(500).json({ message: "ดึงใบมอบหมายไม่สำเร็จ" });
  }
});

/**
 * มอบหมายช่าง (หลายคนได้) — หัวใจของ "แยกเป็นแต่ละคน"
 * ⚠️ ส่ง userIds มาทั้งชุดเสมอ = ชุดผู้รับงานล่าสุด (คนที่หายไปจากชุดถือว่าถูกถอดออก)
 * ⚠️ คนที่อยู่เดิมและยังอยู่ในชุดใหม่ ต้อง "คงสถานะ/เวลา/บันทึก/ไฟล์ของเขาไว้ทั้งหมด" —
 * ถ้าสร้างใหม่ทับ ช่างที่ทำงานไปครึ่งทางจะถูกรีเซ็ตกลับเป็น "รอรับทราบ" เงียบๆ
 */
router.post("/:id/assign", verifyToken, async (req, res) => {
  try {
    if (!can(req.user, "assignDispatch")) {
      return res.status(403).json({ message: "เฉพาะแอดมิน/ผู้จัดการเท่านั้นที่มอบหมายงานได้" });
    }
    const dispatch = await Dispatch.findById(req.params.id);
    if (!dispatch) return res.status(404).json({ message: "ไม่พบใบมอบหมายนี้" });
    if (dispatch.status === "cancelled") return res.status(409).json({ message: "ใบนี้ถูกยกเลิกไปแล้ว" });

    const userIds = [...new Set((parseJsonArray(req.body.userIds) || req.body.userIds || []).map(String))];
    if (!userIds.length) return res.status(400).json({ message: "กรุณาเลือกผู้รับงานอย่างน้อย 1 คน" });

    const users = await User.find({ _id: { $in: userIds } }).select("fname lname username role").lean();
    if (users.length !== userIds.length) return res.status(400).json({ message: "มีผู้รับงานบางคนไม่อยู่ในระบบแล้ว" });
    const notReceivers = users.filter((u) => !can(u, "receiveDispatch"));
    if (notReceivers.length) {
      return res.status(400).json({
        message: `มอบหมายให้ ${notReceivers.map((u) => u.fname || u.username).join(", ")} ไม่ได้ — ไม่ใช่ผู้รับงานของแผนกนี้`,
      });
    }

    const me = actor(req);
    const existing = new Map((dispatch.assignees || []).map((a) => [String(a.userId), a]));
    const removed = [...existing.keys()].filter((id) => !userIds.includes(id));

    dispatch.assignees = users.map((u) => {
      const prev = existing.get(String(u._id));
      if (prev) return prev; // ⚠️ คงความคืบหน้าเดิมไว้ ห้ามสร้างใหม่ทับ
      return {
        userId: String(u._id),
        name: [u.fname, u.lname].filter(Boolean).join(" ") || u.username,
        role: u.role,
        assignedAt: new Date(),
        assignedByUserId: me.userId,
        assignedByName: me.name,
        status: "assigned",
      };
    });

    const added = dispatch.assignees.filter((a) => !existing.has(String(a.userId)));
    dispatch.recomputeStatus();
    log(
      dispatch, "dispatch_assigned",
      `มอบหมายให้ ${dispatch.assignees.map((a) => a.name).join(", ")}` +
        (removed.length ? ` (ถอดออก ${removed.length} คน)` : ""),
      me
    );
    await dispatch.save();

    // ✅ แจ้งเฉพาะคนที่ "เพิ่งถูกเพิ่มเข้ามา" ไม่ยิงซ้ำให้คนที่อยู่มาก่อนแล้ว
    if (added.length) {
      sendPushToUsers(added.map((a) => a.userId), {
        title: `📋 คุณได้รับมอบหมายงานใหม่`,
        body: `${jobLabel(dispatch)}${dispatch.priority === "urgent" ? " · ⚡ ด่วน" : ""}`,
        url: `/dispatch/${dispatch._id}`,
        tag: `dispatch-${dispatch._id}`,
      }).catch((e) => console.error("push dispatch_assigned:", e.message));
    }
    // แจ้งผู้ขอว่างานถูกจ่ายแล้ว (ผู้ขอกับผู้จ่ายมักคนละคน)
    if (dispatch.requestedBy?.userId && dispatch.requestedBy.userId !== me.userId) {
      sendPushToUsers(dispatch.requestedBy.userId, {
        title: "✅ งานที่คุณส่งถูกมอบหมายแล้ว",
        body: `${jobLabel(dispatch)} → ${dispatch.assignees.map((a) => a.name).join(", ")}`,
        url: `/sales?tab=dispatch`,
        tag: `dispatch-${dispatch._id}`,
      }).catch((e) => console.error("push assigned→requester:", e.message));
    }

    const out = dispatch.toObject();
    await attachJob(out);
    res.json({ dispatch: out });
  } catch (err) {
    console.error("❌ มอบหมายงานไม่สำเร็จ:", err);
    res.status(500).json({ message: "มอบหมายงานไม่สำเร็จ" });
  }
});

/**
 * ผู้รับงานอัปเดตสถานะ "ของตัวเอง" (รับทราบ / เริ่มงาน / ปิดงาน / ปฏิเสธ)
 * ⚠️ อัปเดตได้เฉพาะช่องของตัวเองเท่านั้น แม้จะอยู่ในใบเดียวกัน — ช่าง A กดปิดงานแทนช่าง B ไม่ได้
 * (หัวหน้าแก้แทนได้ เพราะบางครั้งช่างแจ้งทางโทรศัพท์แล้วหัวหน้าเป็นคนบันทึกให้)
 */
router.patch("/:id/assignees/:userId/status", verifyToken, upload.single("file"), async (req, res) => {
  try {
    const { status, note, declineReason } = req.body;
    const ALLOWED = ["acknowledged", "in_progress", "done", "declined"];
    if (!ALLOWED.includes(status)) return res.status(400).json({ message: "สถานะไม่ถูกต้อง" });

    const dispatch = await Dispatch.findById(req.params.id);
    if (!dispatch) return res.status(404).json({ message: "ไม่พบใบมอบหมายนี้" });
    if (dispatch.status === "cancelled") return res.status(409).json({ message: "ใบนี้ถูกยกเลิกไปแล้ว" });

    const targetId = String(req.params.userId);
    const isSelf = targetId === String(req.userId);
    if (!isSelf && !can(req.user, "assignDispatch")) {
      return res.status(403).json({ message: "อัปเดตได้เฉพาะงานส่วนของคุณเท่านั้น" });
    }

    const a = (dispatch.assignees || []).find((x) => String(x.userId) === targetId);
    if (!a) return res.status(404).json({ message: "ไม่พบผู้รับงานคนนี้ในใบมอบหมาย" });
    if (status === "declined" && !String(declineReason || "").trim()) {
      return res.status(400).json({ message: "กรุณาระบุเหตุผลที่รับงานนี้ไม่ได้" });
    }

    const me = actor(req);
    const now = new Date();
    a.status = status;
    // ⚠️ ปิดงานโดยไม่เคยกดรับทราบ/เริ่มงานเกิดขึ้นได้จริง (ช่างทำเสร็จแล้วค่อยมากด) —
    // เติมเวลาย้อนให้ครบ ไม่งั้นไทม์ไลน์จะขาดช่วงและคำนวณเวลาที่ใช้ไม่ได้
    if (status === "acknowledged" && !a.ackAt) a.ackAt = now;
    if (status === "in_progress") { if (!a.ackAt) a.ackAt = now; a.startedAt = a.startedAt || now; }
    if (status === "done") {
      if (!a.ackAt) a.ackAt = now;
      if (!a.startedAt) a.startedAt = now;
      a.finishedAt = now;
    }
    if (status === "declined") a.declineReason = String(declineReason).trim();
    if (note !== undefined) a.note = String(note).trim();
    if (req.file) a.attachments.push(await uploadToCloud(req.file, `dispatch/${dispatch._id}/${targetId}`, me.name));

    const LABEL = { acknowledged: "รับทราบงาน", in_progress: "เริ่มงาน", done: "ปิดงาน", declined: "ปฏิเสธงาน" };
    dispatch.recomputeStatus();
    log(dispatch, `assignee_${status}`, `${a.name} ${LABEL[status]}`, me);
    await dispatch.save();

    // ✅ แจ้งผู้ขอเมื่อมีความคืบหน้าจริง — ผู้ขอคือคนที่ต้องตอบลูกค้า
    if (dispatch.requestedBy?.userId && dispatch.requestedBy.userId !== me.userId && status !== "acknowledged") {
      const allDone = dispatch.status === "done";
      sendPushToUsers(dispatch.requestedBy.userId, {
        title: allDone ? "🎉 งานที่คุณส่งเสร็จแล้ว" : `🔧 ${a.name} ${LABEL[status]}`,
        body: jobLabel(dispatch),
        url: "/sales?tab=dispatch",
        tag: `dispatch-${dispatch._id}`,
      }).catch((e) => console.error("push assignee status:", e.message));
    }

    const out = dispatch.toObject();
    await attachJob(out);
    res.json({ dispatch: out });
  } catch (err) {
    console.error("❌ อัปเดตสถานะผู้รับงานไม่สำเร็จ:", err);
    res.status(500).json({ message: "อัปเดตสถานะไม่สำเร็จ" });
  }
});

/** ติ๊ก/ยกเลิกติ๊ก รายการที่ต้องทำ */
router.patch("/:id/checklist/:itemId", verifyToken, async (req, res) => {
  try {
    const dispatch = await Dispatch.findById(req.params.id);
    if (!dispatch) return res.status(404).json({ message: "ไม่พบใบมอบหมายนี้" });
    const uid = String(req.userId);
    const isAssignee = (dispatch.assignees || []).some((a) => String(a.userId) === uid);
    if (!isAssignee && !can(req.user, "assignDispatch")) {
      return res.status(403).json({ message: "ติ๊กรายการได้เฉพาะผู้รับงานเท่านั้น" });
    }
    const item = dispatch.checklist.id(req.params.itemId);
    if (!item) return res.status(404).json({ message: "ไม่พบรายการนี้" });

    const me = actor(req);
    item.done = Boolean(req.body.done);
    item.doneByUserId = item.done ? me.userId : undefined;
    item.doneByName = item.done ? me.name : undefined;
    item.doneAt = item.done ? new Date() : undefined;
    await dispatch.save();
    const out = dispatch.toObject();
    await attachJob(out);
    res.json({ dispatch: out });
  } catch (err) {
    console.error("❌ อัปเดตรายการที่ต้องทำไม่สำเร็จ:", err);
    res.status(500).json({ message: "อัปเดตรายการไม่สำเร็จ" });
  }
});

/** แนบไฟล์เพิ่มเข้าใบ (ผู้ขอหรือหัวหน้า) */
router.post("/:id/files", verifyToken, upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: "ไม่พบไฟล์ที่อัปโหลด" });
    const dispatch = await Dispatch.findById(req.params.id);
    if (!dispatch) return res.status(404).json({ message: "ไม่พบใบมอบหมายนี้" });
    const isRequester = String(dispatch.requestedBy?.userId || "") === String(req.userId);
    if (!isRequester && !can(req.user, "assignDispatch")) {
      return res.status(403).json({ message: "แนบไฟล์ได้เฉพาะผู้ขอหรือหัวหน้าเท่านั้น" });
    }
    const me = actor(req);
    dispatch.attachments.push(await uploadToCloud(req.file, `dispatch/${dispatch._id}`, me.name, req.body.docType));
    await dispatch.save();
    const out = dispatch.toObject();
    await attachJob(out);
    res.json({ dispatch: out });
  } catch (err) {
    console.error("❌ แนบไฟล์เข้าใบมอบหมายไม่สำเร็จ:", err);
    res.status(500).json({ message: "แนบไฟล์ไม่สำเร็จ" });
  }
});

/**
 * ยกเลิกใบ
 * ⚠️ ยกเลิก ไม่ใช่ลบ — ใบที่จ่ายงานไปแล้วมีคนเห็นและอาจออกเดินทางไปแล้ว ต้องเหลือร่องรอยว่า
 * ใครยกเลิกเมื่อไหร่เพราะอะไร (ลบทิ้งจะกลายเป็นงานที่หายไปเฉยๆ จากหน้าจอช่าง)
 */
/**
 * ── ขั้นตอนร่วมระหว่างแผนก ──────────────────────────────────────────────
 *   เซลส่งงาน (POST /)  →  ผู้จัดการ/แอดมินตรวจสอบ
 *      ├─ อนุมัติ  (POST /:id/approve) → สร้างแผนงานใน /event ให้เลย + เลือกผู้รับผิดชอบ
 *      └─ ไม่อนุมัติ (POST /:id/reject) → แนบเหตุผล ตีกลับให้เซลแก้ แล้วกดส่งใหม่ (POST /:id/resubmit)
 *
 * ⚠️ ทำไมอนุมัติแล้วต้องสร้าง CalendarEvent ให้เลย ไม่ใช่ให้ไปสร้างเองทีหลัง:
 * ถ้าแยกเป็น 2 ขั้น จะเกิดใบที่ "อนุมัติแล้ว" แต่ไม่มีวันนัดอยู่ในระบบ — ซึ่งไม่ต่างอะไรกับยังไม่อนุมัติ
 * ในสายตาช่างและลูกค้า และไม่มีใครรู้ว่าตกหล่นจนกว่าลูกค้าจะโทรมาถาม
 */

/** อนุมัติ + จัดลงแผนงาน + เลือกผู้รับผิดชอบ (ทำในคำขอเดียว) */
router.post("/:id/approve", verifyToken, async (req, res) => {
  try {
    if (!can(req.user, "assignDispatch")) {
      return res.status(403).json({ message: "เฉพาะแอดมิน/ผู้จัดการเท่านั้นที่ตรวจสอบใบแจ้งงานได้" });
    }
    const dispatch = await Dispatch.findById(req.params.id);
    if (!dispatch) return res.status(404).json({ message: "ไม่พบใบแจ้งงานนี้" });
    if (dispatch.status === "cancelled") return res.status(409).json({ message: "ใบนี้ถูกยกเลิกไปแล้ว" });
    if (dispatch.eventId) return res.status(409).json({ message: "ใบนี้ถูกอนุมัติและลงแผนงานไปแล้ว" });

    const { start, end, responsiblePersonId } = req.body;
    if (!start) return res.status(400).json({ message: "กรุณาระบุวันที่เข้างาน" });
    const startAt = new Date(start);
    const endAt = end ? new Date(end) : startAt;
    if (Number.isNaN(startAt.getTime()) || Number.isNaN(endAt.getTime())) {
      return res.status(400).json({ message: "วันที่เข้างานไม่ถูกต้อง" });
    }
    if (endAt < startAt) return res.status(400).json({ message: "วันที่สิ้นสุดต้องไม่ก่อนวันที่เริ่ม" });

    // ผู้รับผิดชอบ (ไม่บังคับ — บางทีนัดวันได้ก่อนแล้วค่อยเลือกคน)
    let responsible = null;
    if (responsiblePersonId) {
      responsible = await User.findById(responsiblePersonId).select("fname lname username role").lean();
      if (!responsible) return res.status(400).json({ message: "ไม่พบผู้รับผิดชอบที่เลือก" });
      if (!can(responsible, "receiveDispatch")) {
        return res.status(400).json({ message: "ผู้รับผิดชอบต้องเป็นผู้รับงานของแผนกช่าง" });
      }
    }
    const responsibleName = responsible
      ? [responsible.fname, responsible.lname].filter(Boolean).join(" ") || responsible.username
      : "";

    const me = actor(req);
    const c = dispatch.customer || {};

    /**
     * ── ถ้าใบนี้ผูกกับสัญญา ให้ลงเป็น "ครั้งถัดไปของสัญญา" ไม่ใช่งานทั่วไป ──────────────
     * ⚠️ ต้องคำนวณ "ครั้งที่" ตอนอนุมัติ ไม่ใช่ตอนที่เซลแจ้ง — ระหว่างที่ใบรอตรวจอยู่ ช่างอาจเพิ่ม
     * ครั้งนั้นเข้าสัญญาไปแล้วเอง ถ้าจองไว้ล่วงหน้าจะได้ครั้งที่ซ้ำกันสองงาน
     * ⚠️ ถ้าสัญญาเต็มไปแล้วต้องปฏิเสธ ไม่ใช่เงียบๆ ลงเป็นงานทั่วไปแทน — คนอนุมัติจะไม่มีทางรู้เลย
     * ว่างานหลุดออกจากสัญญาไป และจำนวนครั้งในหน้า "ภาพรวมงาน" จะเพี้ยนโดยไม่มีใครสังเกต
     */
    let contractFields = {};
    const linkedGroupId = dispatch.contract?.groupId || "";
    if (linkedGroupId) {
      const visits = await CalendarEvent.find({ contractGroupId: linkedGroupId })
        .select("visitCount contractNo quotationNo contractStart contractEnd intervalMonths jobValue time")
        .lean();
      if (!visits.length) {
        return res.status(409).json({ message: "สัญญาที่ผูกกับใบนี้ถูกลบไปแล้ว — ตีกลับให้ผู้แจ้งเลือกใหม่" });
      }
      const head = visits.find((v) => v.visitCount) || visits[0];
      const visitCount = head.visitCount || 0;
      const used = new Set(
        visits
          .filter((v) => v.time !== undefined && v.time !== null && v.time !== "")
          .map((v) => String(v.time))
      );
      let nextRound = null;
      for (let i = 1; i <= visitCount; i += 1) {
        if (!used.has(String(i))) { nextRound = i; break; }
      }
      if (!nextRound) {
        return res.status(409).json({ message: "สัญญานี้ครบจำนวนครั้งแล้วระหว่างที่ใบรอตรวจ — ตีกลับให้ผู้แจ้งเลือกใหม่" });
      }
      contractFields = {
        contractGroupId: linkedGroupId,
        contractNo: head.contractNo || dispatch.contract?.no || "",
        quotationNo: head.quotationNo || "",
        contractStart: head.contractStart || undefined,
        contractEnd: head.contractEnd || undefined,
        intervalMonths: head.intervalMonths,
        jobValue: head.jobValue,
        visitCount,
        time: nextRound,
        // 🐛 ที่แก้ (ทดสอบจับได้): เดิมใส่ jobClassification: "contract" ซึ่ง **ไม่มีใน enum**
        // (models/Events.js รับแค่ "" | "general" | "project") ทำให้ Mongoose ตีตก ValidationError
        // แล้วการอนุมัติล้มทั้งรายการ — งานตามสัญญาถูกระบุด้วย contractGroupId ต่างหาก ไม่ใช่ฟิลด์นี้
        // (ดู classifyJob ฝั่งหน้าจอที่เช็ค contractGroupId ก่อนเป็นอันดับแรก) จึงต้องเป็นค่าว่าง
        jobClassification: "",
        // ล้างธงงานทั่วไปให้ตรงความหมาย — ไม่งั้นงานสัญญาจะถูกนับเป็น "งานทั่วไปที่ยืนยันแล้ว"
        isConfirmedGeneral: false,
      };
    }

    // ⚠️ department = service เสมอ — ใบนี้ถูกส่งมาให้ฝ่ายช่างทำ ไม่ใช่แผนงานของฝ่ายขาย
    // ถ้าประทับตาม role ของคนกดอนุมัติ งานจะไปโผล่ผิดฝั่งทันทีที่เซลได้สิทธิ์อนุมัติในอนาคต
    const event = await new CalendarEvent({
      department: DEPARTMENT.SERVICE,
      company: c.company || dispatch.title,
      // ⚠️ site เป็น required ใน models/Events.js แต่ฟอร์มแจ้งงานไม่บังคับกรอกโครงการ/สาขา
      // (ลูกค้าหลายรายไม่มีสาขา) — ต้องมีค่าสำรองเสมอ ไม่งั้น validation ไม่ผ่านแล้วตกเป็น 500
      site: c.site || c.company || dispatch.title,
      title: dispatch.title,
      system: dispatch.system || "",
      description: dispatch.detail || "",
      date: startAt,
      start: startAt,
      // ⚠️ end ของงาน allDay เก็บแบบ exclusive (+1 วัน) ตามแบบแผนของทั้งแอป — ฝั่งจอลบคืน
      // 1 วันตอนแสดงผลเสมอ (formatEventDateRange) ถ้าเก็บวันจริงตรงๆ จะโชว์เป็น
      // "24 – 23 ส.ค." คือสิ้นสุดก่อนวันเริ่ม
      end: moment(endAt).add(1, "day").toDate(),
      allDay: true,
      backgroundColor: "#0891b2",
      textColor: "#ffffff",
      fontSize: 14,
      // ✅ ผ่านการตรวจสอบของหัวหน้ามาแล้ว = ยืนยันแล้วจริง ไม่ใช่ "กำลังรอยืนยัน"
      // 🐛 ที่แก้: เดิมตั้งเป็น "กำลังรอยืนยัน" ทำให้งานที่หัวหน้าเพิ่งอนุมัติไปเอง กลับไปกองอยู่ใน
      // กลุ่ม "รอยืนยัน" ของหน้าการดำเนินงานอีกรอบ เหมือนยังไม่มีใครตัดสินใจอะไรเลย
      status: "ยืนยันแล้ว",
      // งานที่ผ่านการตรวจสอบมาแล้วถือว่าอนุมัติแล้ว ไม่ต้องเข้าคิวอนุมัติซ้ำอีกชั้น
      approvalStatus: "approved",
      userId: me.userId,

      // ── ฟิลด์ที่ทำให้เป็น "งานช่างเต็มรูปแบบ" เหมือนที่สร้างจากฟอร์มของช่างเอง ──────
      // ⚠️ resPerson คือฟิลด์ที่หน้าการดำเนินงานและ GET /event-op ใช้กรอง "งานของฉัน" ของช่าง
      // (ดู jobParticipantViewClauses) — ขาดตัวนี้ไปงานจะโผล่แค่ทาง team ซึ่งเป็นการเทียบ *ชื่อ*
      // ที่พังทันทีถ้าช่างเปลี่ยนชื่อ ส่วน responsiblePerson เป็นคนละแนวคิด (เจ้าของงานโดยรวม)
      resPerson: responsible ? String(responsible._id) : undefined,
      team: responsibleName,
      responsiblePerson: responsibleName,
      responsiblePersonId: responsible ? String(responsible._id) : undefined,
      // ⚠️ teamMembers ใช้แสดง "ใครเข้างานบ้าง" ในการ์ด/ตาราง และเป็นอีกทางที่ช่างมองเห็นงาน
      teamMembers: responsible
        ? [{ userId: String(responsible._id), name: responsibleName }]
        : [],
      // ⚠️ งานจากใบแจ้งงานเป็นงานครั้งเดียว ไม่ผูกสัญญา — ต้องระบุให้ชัด ไม่งั้นตัวจัดหมวดหมู่
      // (classifyJob) คืนค่าว่าง แล้วการ์ดขึ้นเป็น "ไม่ระบุ" ทั้งที่รู้อยู่แล้วว่าเป็นงานทั่วไป
      jobClassification: "general",
      isConfirmedGeneral: true,
      // ⚠️ ต้องกระจายท้ายสุด — งานตามสัญญาต้องทับ jobClassification/visitCount ของงานทั่วไปด้านบน
      // (ว่างเปล่าเมื่อใบนี้ไม่ได้ผูกสัญญา จึงไม่กระทบเส้นทางเดิมเลย)
      ...contractFields,
    }).save();

    // ✅ ค่าที่แจ้งมากลายเป็นตัวเลือกให้ครั้งถัดไป (เหมือนที่ฟอร์มของช่างทำตอนสร้างแผนงาน)
    await upsertLookups({
      title: dispatch.title,
      system: dispatch.system,
      company: c.company,
      site: c.site,
      ownerId: req.userId,
    });

    dispatch.eventId = event._id;
    dispatch.status = "assigned";
    dispatch.reviewedBy = { userId: me.userId, name: me.name };
    dispatch.reviewedAt = new Date();
    dispatch.rejectedReason = "";
    if (responsible) {
      dispatch.assignees = [{
        userId: String(responsible._id),
        name: responsibleName,
        role: responsible.role,
        assignedAt: new Date(),
        assignedByUserId: me.userId,
        assignedByName: me.name,
        status: "assigned",
      }];
    }
    log(dispatch, "dispatch_approved",
      `อนุมัติและลงแผนงานวันที่ ${thaiDate(startAt)}${responsibleName ? ` · ผู้รับผิดชอบ ${responsibleName}` : ""}`,
      me);
    await dispatch.save();

    if (responsible) {
      sendPushToUsers([String(responsible._id)], {
        title: "📋 คุณได้รับมอบหมายงานใหม่",
        body: `${jobLabel(dispatch)}${dispatch.priority === "urgent" ? " · ⚡ ด่วน" : ""}`,
        url: `/operation/${event._id}`,
        tag: `dispatch-${dispatch._id}`,
      }).catch((e) => console.error("push approve→assignee:", e.message));
    }
    if (dispatch.requestedBy?.userId && dispatch.requestedBy.userId !== me.userId) {
      sendPushToUsers([dispatch.requestedBy.userId], {
        title: "✅ งานที่คุณแจ้งได้รับการอนุมัติแล้ว",
        body: `${jobLabel(dispatch)} · เข้างาน ${thaiDate(startAt)}${responsibleName ? ` · ${responsibleName}` : ""}`,
        url: "/sales",
        tag: `dispatch-${dispatch._id}`,
      }).catch((e) => console.error("push approve→requester:", e.message));
    }

    // ⚠️ ต้องแนบ job ให้ response ของ approve ด้วย — หน้าจออัปเดตการ์ดจากค่าที่คืนตรงนี้
    // ถ้าไม่แนบ ป้ายสถานะจะหายไปทันทีหลังกดอนุมัติ จนกว่าจะรีเฟรชหน้า
    const approved = dispatch.toObject();
    await attachJob(approved);
    res.json({ dispatch: approved, event: event.toObject() });
  } catch (err) {
    console.error("❌ อนุมัติใบแจ้งงานไม่สำเร็จ:", err);
    // ⚠️ ข้อมูลไม่ครบเป็นความผิดของคำขอ ไม่ใช่ของเซิร์ฟเวอร์ — ตอบ 400 พร้อมบอกว่าช่องไหนขาด
    // ไม่งั้นผู้ใช้เห็นแค่ 500 แล้วไม่รู้ว่าต้องแก้อะไร (อาการเดิม: กดอนุมัติแล้วเงียบ)
    if (err?.name === "ValidationError") {
      const fields = Object.keys(err.errors || {}).join(", ");
      return res.status(400).json({
        message: `ข้อมูลไม่ครบ ลงแผนงานไม่ได้${fields ? ` — ขาด: ${fields}` : ""} กรุณาแก้ไขใบแจ้งงานก่อน`,
      });
    }
    res.status(500).json({ message: "อนุมัติใบแจ้งงานไม่สำเร็จ" });
  }
});

/** ไม่อนุมัติ — ต้องมีเหตุผลเสมอ แล้วตีกลับให้ผู้ขอแก้ */
router.post("/:id/reject", verifyToken, async (req, res) => {
  try {
    if (!can(req.user, "assignDispatch")) {
      return res.status(403).json({ message: "เฉพาะแอดมิน/ผู้จัดการเท่านั้นที่ตรวจสอบใบแจ้งงานได้" });
    }
    const dispatch = await Dispatch.findById(req.params.id);
    if (!dispatch) return res.status(404).json({ message: "ไม่พบใบแจ้งงานนี้" });
    if (dispatch.eventId) return res.status(409).json({ message: "ใบนี้ลงแผนงานไปแล้ว ตีกลับไม่ได้" });

    // ⚠️ บังคับเหตุผล — ตีกลับเปล่าๆ ทำให้ผู้ขอส่งกลับมาเหมือนเดิมแล้ววนอยู่อย่างนั้น
    const reason = String(req.body.reason || "").trim();
    if (!reason) return res.status(400).json({ message: "กรุณาระบุเหตุผลที่ไม่อนุมัติ เพื่อให้ผู้แจ้งแก้ไขได้ถูกจุด" });

    const me = actor(req);
    dispatch.status = "rejected";
    dispatch.rejectedReason = reason;
    dispatch.reviewedBy = { userId: me.userId, name: me.name };
    dispatch.reviewedAt = new Date();
    log(dispatch, "dispatch_rejected", `ไม่อนุมัติ: ${reason}`, me);
    await dispatch.save();

    if (dispatch.requestedBy?.userId) {
      sendPushToUsers([dispatch.requestedBy.userId], {
        title: "↩️ ใบแจ้งงานถูกตีกลับให้แก้ไข",
        body: `${jobLabel(dispatch)} — ${reason}`,
        url: "/sales",
        tag: `dispatch-${dispatch._id}`,
        renotify: true,
      }).catch((e) => console.error("push reject→requester:", e.message));
    }

    const out = dispatch.toObject();
    await attachJob(out);
    res.json({ dispatch: out });
  } catch (err) {
    console.error("❌ ตีกลับใบแจ้งงานไม่สำเร็จ:", err);
    res.status(500).json({ message: "ตีกลับใบแจ้งงานไม่สำเร็จ" });
  }
});

/**
 * ผู้ขอแก้ไขแล้วส่งตรวจใหม่
 * ⚠️ ส่งใหม่ได้เฉพาะใบที่ถูกตีกลับ และเฉพาะเจ้าของใบ (หรือแอดมิน) — กันคนอื่นดันใบของคนอื่น
 * กลับเข้าคิวโดยที่เจ้าของยังไม่ได้แก้อะไร
 */
router.post("/:id/resubmit", verifyToken, upload.array("files", 10), async (req, res) => {
  try {
    const dispatch = await Dispatch.findById(req.params.id);
    if (!dispatch) return res.status(404).json({ message: "ไม่พบใบแจ้งงานนี้" });
    if (dispatch.status !== "rejected") {
      return res.status(409).json({ message: "ส่งใหม่ได้เฉพาะใบที่ถูกตีกลับเท่านั้น" });
    }
    const me = actor(req);
    const isOwner = String(dispatch.requestedBy?.userId || "") === String(me.userId);
    if (!isOwner && !can(req.user, "assignDispatch")) {
      return res.status(403).json({ message: "ส่งใหม่ได้เฉพาะใบที่คุณเป็นคนแจ้งเท่านั้น" });
    }

    // แก้ข้อมูลได้เท่าที่ส่งมา — ช่องที่ไม่ส่งมาให้คงค่าเดิม (ผู้ขออาจแก้แค่จุดเดียวตามที่ถูกตีกลับ)
    const t = (v) => String(v || "").trim();
    if (req.body.title !== undefined && t(req.body.title)) dispatch.title = t(req.body.title);
    if (req.body.detail !== undefined) dispatch.detail = t(req.body.detail);
    if (req.body.note !== undefined) dispatch.note = t(req.body.note);
    if (req.body.system !== undefined) dispatch.system = t(req.body.system);
    if (req.body.priority !== undefined) dispatch.priority = t(req.body.priority) || dispatch.priority;
    ["company", "site", "address", "contactName", "contactTel"].forEach((k) => {
      if (req.body[k] !== undefined) dispatch.customer[k] = t(req.body[k]);
    });
    if (req.body.mapUrl !== undefined) dispatch.customer.mapUrl = safeMapUrl(req.body.mapUrl);
    for (const [i, f] of (req.files || []).entries()) {
      dispatch.attachments.push(await uploadToCloud(f, `dispatch/${dispatch._id}`, me.name, docTypeAt(req, i)));
    }

    dispatch.status = "requested";
    dispatch.resubmitCount = (dispatch.resubmitCount || 0) + 1;
    // ⚠️ ล้างผลการตรวจรอบก่อน — ไม่งั้นหน้าจอจะยังโชว์แถบแดง "ไม่อนุมัติเพราะ..." ทั้งที่แก้แล้วส่งใหม่
    // (ประวัติการตีกลับยังอยู่ครบใน activityLog ไม่ได้หายไปไหน)
    dispatch.rejectedReason = "";
    dispatch.reviewedBy = { userId: "", name: "" };
    dispatch.reviewedAt = undefined;
    log(dispatch, "dispatch_resubmitted", `แก้ไขแล้วส่งตรวจใหม่ (รอบที่ ${dispatch.resubmitCount + 1})`, me);
    await dispatch.save();

    sendPushToRoles(SUPERVISOR_ROLES, {
      title: "🔄 ใบแจ้งงานที่แก้ไขแล้ว รอตรวจสอบอีกครั้ง",
      body: `${jobLabel(dispatch)} · จาก ${dispatch.requestedBy?.name || "ผู้แจ้ง"}`,
      url: "/dispatch",
      tag: `dispatch-${dispatch._id}`,
      renotify: true,
    }).catch((e) => console.error("push resubmit:", e.message));

    const out = dispatch.toObject();
    await attachJob(out);
    res.json({ dispatch: out });
  } catch (err) {
    console.error("❌ ส่งใบแจ้งงานใหม่ไม่สำเร็จ:", err);
    res.status(500).json({ message: "ส่งใบแจ้งงานใหม่ไม่สำเร็จ" });
  }
});

router.post("/:id/cancel", verifyToken, async (req, res) => {
  try {
    const dispatch = await Dispatch.findById(req.params.id);
    if (!dispatch) return res.status(404).json({ message: "ไม่พบใบมอบหมายนี้" });
    const isRequester = String(dispatch.requestedBy?.userId || "") === String(req.userId);
    if (!isRequester && !can(req.user, "assignDispatch")) {
      return res.status(403).json({ message: "ยกเลิกได้เฉพาะผู้ขอหรือหัวหน้าเท่านั้น" });
    }
    if (dispatch.status === "done") return res.status(409).json({ message: "ใบที่ปิดงานแล้วยกเลิกไม่ได้" });
    const reason = String(req.body.reason || "").trim();
    if (!reason) return res.status(400).json({ message: "กรุณาระบุเหตุผลที่ยกเลิก" });

    const me = actor(req);
    dispatch.status = "cancelled";
    dispatch.cancelReason = reason;
    log(dispatch, "dispatch_cancelled", `ยกเลิกใบมอบหมาย: ${reason}`, me);
    await dispatch.save();

    const notify = (dispatch.assignees || []).map((a) => a.userId).filter((id) => id !== me.userId);
    if (notify.length) {
      sendPushToUsers(notify, {
        title: "🚫 งานที่ได้รับมอบหมายถูกยกเลิก",
        body: `${jobLabel(dispatch)} — ${reason}`,
        url: "/technician/jobs",
        tag: `dispatch-${dispatch._id}`,
      }).catch((e) => console.error("push cancel:", e.message));
    }
    const out = dispatch.toObject();
    await attachJob(out);
    res.json({ dispatch: out });
  } catch (err) {
    console.error("❌ ยกเลิกใบมอบหมายไม่สำเร็จ:", err);
    res.status(500).json({ message: "ยกเลิกไม่สำเร็จ" });
  }
});

module.exports = router;
