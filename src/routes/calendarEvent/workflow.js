/**
 * การเปลี่ยนสถานะเชิงกระบวนการ — ติดตามใบเสนอราคา จัดหมวดงาน อนุมัติปิดงาน
 *
 * แยกออกมาจาก routes/calendarEvent.js เดิมที่ยาว 2,708 บรรทัดในไฟล์เดียว (29 route)
 * ⚠️ ลำดับการประกาศ route ภายในไฟล์นี้ = ลำดับเดิม ห้ามสลับ (ดูเหตุผลที่ index.js)
 */
const {
  CalendarEvent,
  verifyToken,
  can,
  upload,
  cloudinary,
  streamifier,
  sendPushToUsers,
  sendPushToRoles,
  SUPERVISOR_ROLES,
  isJobParticipant,
} = require("./shared");

const FOLLOWUP_CHANNELS = ["phone", "line", "email", "visit", "other"];
/** "YYYY-MM-DD" → เที่ยงวัน UTC (กันวันเลื่อนข้ามโซนเวลา) · withTime = รับ ISO เต็มด้วย · ว่าง/ผิด = null */
const parseDay = (v, withTime = false) => {
  const s = String(v ?? "").trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return new Date(`${s}T12:00:00.000Z`);
  if (!withTime) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
};

module.exports = (router) => {
  // ✅ บันทึกการติดตามลูกค้าเรื่องใบเสนอราคาแบบเป็นครั้งๆ (ครั้งที่ 1, 2, 3...) พร้อมหลักฐานแนบได้ถ้ามี
  // (หน้า /quotations) — ผู้ใช้ต้องการให้เป็นสิทธิ์ของ "ผู้รับผิดชอบ" (responsiblePerson) โดยเฉพาะ ไม่ใช่
  // "ทีมที่เข้างาน" (team) เหมือนเดิมอีกต่อไป (หัวหน้าทีมเข้างานไม่มีสิทธิ์จัดการส่วนนี้แล้ว) — เจ้าของ
  // (คนสร้างงาน)/ผู้รับผิดชอบ/admin/manager จัดการได้ — ใช้ effectiveResponsiblePerson (fallback ไปที่
  // team/resPerson เฉพาะงานที่ยังไม่เคยตั้งค่าผู้รับผิดชอบแยกไว้เลย กันงานเก่าพังกะทันหัน)
  router.put("/:id/quotation-followup", verifyToken, upload.single("file"), async (req, res) => {
    try {
      const { id } = req.params;
      const userId = req.userId;
      const { note } = req.body;

      const existingEvent = await CalendarEvent.findById(id);
      if (!existingEvent) {
        return res.status(404).json({ message: "ไม่พบงานนี้" });
      }

      // ⚠️ BUG ที่แก้: เดิมเช็คแค่ req.user.role !== "admin" (ไม่รวม manager เหมือนทุกจุดอื่น) และเดิม
      // เช็คแค่ team/resPerson (ทีมที่เข้างาน) ไม่ใช่ผู้รับผิดชอบ — เปลี่ยนมาเช็คผู้รับผิดชอบแทนตามที่ขอ
      // ✅ ขยายให้ "หัวหน้าทีมที่เข้างาน" และ "ลูกทีม" บันทึกการติดตามใบเสนอราคาของงานตัวเองได้ด้วย
      // (ตามที่ผู้ใช้ระบุสำหรับหน้า /finance) — เดิมรับแค่เจ้าของงานกับผู้รับผิดชอบ ทำให้ช่างที่ไปหน้างาน
      // และคุยกับลูกค้าเองบันทึกความคืบหน้าไม่ได้ ต้องฝากคนอื่นบันทึกให้ทุกครั้ง
      const isAdminOrManager = can(req.user, "editFinance");
      if (!isAdminOrManager && !isJobParticipant(existingEvent, userId, req.user.fname)) {
        return res.status(403).json({ message: "บันทึกการติดตามได้เฉพาะงานที่คุณเกี่ยวข้องเท่านั้น" });
      }

      if (!note || !note.trim()) {
        return res.status(400).json({ message: "กรุณากรอกรายละเอียดการติดตาม" });
      }
      const channel = FOLLOWUP_CHANNELS.includes(req.body.channel) ? req.body.channel : "";
      const nextAt = parseDay(req.body.nextFollowUpAt);

      const followUp = {
        attemptNumber: (existingEvent.quotationFollowUps?.length || 0) + 1,
        note: note.trim(),
        channel,
        contactedAt: new Date(),
        userId,
        userName: [req.user.fname, req.user.lname].filter(Boolean).join(" ") || req.user.username,
      };

      // ✅ แนบหลักฐานได้ถ้ามี (ไม่บังคับ) — อัพโหลดขึ้น Cloudinary รูปแบบเดียวกับ PUT /upload/:id
      // เติม timestamp นำหน้าชื่อไฟล์กันไฟล์ชื่อซ้ำกันข้ามแต่ละครั้งทับกันเอง (ต่างจาก /upload/:id ที่
      // ตั้งใจให้ overwrite ไฟล์ประเภทเดิม แต่หลักฐานแต่ละครั้งของการติดตามต้องแยกจากกันชัดเจน)
      if (req.file) {
        const originalName = Buffer.from(req.file.originalname, "latin1").toString("utf8");
        const sanitizedName = originalName.replace(/[^\w\-.]/g, "_");
        const result = await new Promise((resolve, reject) => {
          const stream = cloudinary.uploader.upload_stream(
            {
              resource_type: "raw",
              folder: `events/${id}/quotation-followups`,
              public_id: `${Date.now()}_${sanitizedName}`,
              use_filename: false,
              unique_filename: false,
              overwrite: true,
            },
            (error, result) => (error ? reject(error) : resolve(result)),
          );
          streamifier.createReadStream(req.file.buffer).pipe(stream);
        });
        followUp.evidenceFileName = originalName;
        followUp.evidenceFileUrl = result.secure_url;
        followUp.evidenceFileType = req.file.mimetype;
      }

      const logEntry = {
        action: "quotation_followup",
        detail: `บันทึกการติดตามครั้งที่ ${followUp.attemptNumber}`,
        userId,
        userName: followUp.userName,
        timestamp: followUp.contactedAt,
      };

      const updatedEvent = await CalendarEvent.findByIdAndUpdate(
        id,
        // ✅ นัดติดตามครั้งถัดไป — ไม่ระบุ = ล้างทิ้ง (กลับไปใช้เกณฑ์ 7 วันหลังติดต่อล่าสุด)
        { $push: { quotationFollowUps: followUp, activityLog: logEntry }, $set: { quotationNextFollowUpAt: nextAt } },
        { new: true },
      );

      res.status(200).json({ event: updatedEvent });
    } catch (err) {
      console.error("❌ Error adding quotation follow-up:", err);
      res.status(500).json({ message: "บันทึกการติดตามไม่สำเร็จ" });
    }
  });

  /**
   * ✅ ข้อมูล + สถานะใบเสนอราคา (หน้า /finance → ติดตามใบเสนอราคา) — ผู้ใช้สั่ง 2 ต.ค. 2569
   *    "ข้อมูลไม่สมบูรณ์ ปรับปรุงให้สมบูรณ์และมืออาชีพ"
   *    เดิมหน้าจอยิง PUT /:id ทีละวันของงานแล้วต่อ activityLog เอง — ไม่มีการตรวจค่า และเพิ่มฟิลด์ใหม่
   *    ต้องไปแก้ route ใหญ่ที่คุมงานทั้งหมด ตอนนี้แยกเป็น route เฉพาะ ตรวจค่า + บันทึกทั้งกลุ่มวันเดียวกัน
   *
   * body: { action?: "send"|"approve"|"reject"|"reset", ...ฟิลด์ข้อมูลใบเสนอราคา }
   * สิทธิ์: ผู้เกี่ยวข้องกับงาน หรือ editFinance · มูลค่า/ย้อนสถานะ = editFinance เท่านั้น
   */
  /**
   * ✅ (19 ต.ค. 2569 ผู้ใช้: "วิเคราะห์ข้อมูลในภาพหรือไฟล์อัตโนมัติว่าราคารวมเท่าไร") — ให้ AI อ่านไฟล์ใบเสนอราคา
   * ⚠️ ไม่บันทึกอะไรเลย คืนค่าให้หน้าจอแสดงแล้วคนกด "ใช้ค่านี้" · รับเฉพาะ fileId ที่แนบกับงานนี้จริง (กัน SSRF/เผาโควตา)
   */
  router.post("/:id/quotation/scan", verifyToken, async (req, res) => {
    try {
      const QuotationScan = require("../../services/QuotationScan");
      if (!QuotationScan.isEnabled()) return res.status(503).json({ message: "ยังไม่ได้เปิดใช้งานการอ่านเอกสารด้วย AI (ไม่พบ ANTHROPIC_API_KEY)" });
      const ev = await CalendarEvent.findById(req.params.id)
        .select("_id quotationFiles userId team resPerson responsiblePerson responsiblePersonId teamMembers").lean();
      if (!ev) return res.status(404).json({ message: "ไม่พบงานนี้" });
      if (!can(req.user, "editFinance") && !isJobParticipant(ev, req.userId, req.user.fname)) {
        return res.status(403).json({ message: "อ่านใบเสนอราคาได้เฉพาะงานที่คุณเกี่ยวข้องเท่านั้น" });
      }
      const { isPdfFile, isImageFile } = require("../../services/aiFileSource");
      if (!(ev.quotationFiles || []).some((f) => isPdfFile(f) || isImageFile(f))) return res.status(400).json({ message: "อ่านได้เฉพาะรูปภาพหรือ PDF" });
      // 🔁 อ่าน "ทุกไฟล์" ของงานพร้อมกัน (ใบเดียวอาจแยกหลายไฟล์ · งานเดียวอาจมีหลายใบ)
      // apply = เติมให้เลย (ช่องว่าง/ช่องที่ AI เติมไว้เอง) · ไม่ส่ง = คืนแค่ผลอ่าน
      if (req.body.apply) {
        const out = await QuotationScan.autoFillQuotation(ev._id);
        return res.json({ result: out?.result || null, filled: out?.filled || [] });
      }
      const result = await QuotationScan.scanQuotationFiles(ev.quotationFiles);
      res.json({ result });
    } catch (err) {
      console.error("❌ อ่านใบเสนอราคาด้วย AI ไม่สำเร็จ:", err?.status, err?.message);
      res.status(502).json({ message: require("../../services/aiFileSource").safeAiError(err) });
    }
  });

  // ─── สรุป Service Report ด้วย AI ────────────────────────────────────────────
  /**
   * ✅ (25 ต.ค. 2569 ผู้ใช้: "ทำระบบให้อ่าน Service Report ของช่าง แล้วกดสร้างสรุปออกมาเป็น PDF ให้สมบูรณ์ที่สุด")
   *    GET  /:id/service-report-summary        — สรุปที่บันทึกไว้ (ถ้ามี) + ไฟล์ Service Report ทั้งงาน
   *    POST /:id/service-report-summary/scan   — ให้ AI อ่านทุกไฟล์แล้วบันทึกเป็น "ร่าง" (ทับร่างที่คนแก้/ยืนยันแล้ว ต้องส่ง force)
   *    PUT  /:id/service-report-summary        — บันทึกที่คนแก้ · confirm = ยืนยันสรุป (ใช้ออก PDF ฉบับจริง)
   *    งานหลายวัน = สรุปเดียวทั้งงาน (jobGroupId) อ่านไฟล์จากทุกวันรวมกัน
   *    สิทธิ์: ดู/สั่งอ่าน = ผู้เกี่ยวข้องกับงาน · viewAllJobs · editAnyJob  ·  แก้/ยืนยัน = ผู้เกี่ยวข้อง · editAnyJob
   */
  const SR_SELECT = "_id jobGroupId reportFiles userId team resPerson responsiblePerson responsiblePersonId teamMembers start end allDay startTime endTime";
  const srContext = async (req) => {
    const ev = await CalendarEvent.findById(req.params.id).select(SR_SELECT).lean();
    if (!ev) return { error: [404, "ไม่พบงานนี้"] };
    const sessions = ev.jobGroupId
      ? await CalendarEvent.find({ jobGroupId: ev.jobGroupId }).select(SR_SELECT).sort({ start: 1 }).lean()
      : [ev];
    const participant = sessions.some((x) => isJobParticipant(x, req.userId, req.user.fname));
    const canView = participant || can(req.user, "viewAllJobs") || can(req.user, "editAnyJob");
    const canEdit = participant || can(req.user, "editAnyJob");
    if (!canView) return { error: [403, "ดูสรุป Service Report ได้เฉพาะงานที่คุณเกี่ยวข้องเท่านั้น"] };
    const seen = new Set();
    const files = sessions.flatMap((x) => x.reportFiles || [])
      .filter((f) => f?.fileUrl && !seen.has(f.fileUrl) && seen.add(f.fileUrl))
      .sort((a, b) => new Date(a.uploadedAt || 0) - new Date(b.uploadedAt || 0))
      .map((f) => ({ fileName: f.fileName || "", fileUrl: f.fileUrl, fileType: f.fileType || "" }));
    return { ev, sessions, files, canEdit, jobKey: String(ev.jobGroupId || ev._id), eventIds: sessions.map((x) => String(x._id)) };
  };
  const srActor = (req) => [req.user.fname, req.user.lname].filter(Boolean).join(" ") || req.user.username || "";
  /**
   * 💰 (25 ต.ค. 2569 ผู้ใช้: "บังคับไม่ให้อ่านใหม่ได้เกิน 3 รอบต่อวัน") — นับต่องาน ตามวันเวลาไทย
   *    ครั้งแรก (ยังไม่มีสรุป) ไม่นับ · "อ่านใหม่" ได้ 3 ครั้งต่อวัน ขึ้นวันใหม่นับใหม่
   */
  const SR_RESCAN_PER_DAY = 3;
  const srToday = () => new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);
  const srRescanLeft = (s) => (!s ? SR_RESCAN_PER_DAY
    : s.rescanDay === srToday() ? Math.max(0, SR_RESCAN_PER_DAY - (s.rescansToday || 0)) : SR_RESCAN_PER_DAY);
  const srMark = (ids, status, by) => CalendarEvent.updateMany({ _id: { $in: ids } }, { $set: { serviceReportAi: { status, at: new Date(), by } } });

  /**
   * POST /service-report-summaries  { jobKeys: [] } — สรุปหลายงานพร้อมกัน สำหรับส่งออก Excel หน้าการดำเนินงาน
   * ✅ (25 ต.ค. 2569 ผู้ใช้: "สามารถเอาไปลงรายงานสรุปใน excel ได้จริง")
   * ⚠️ ส่งเฉพาะ data ที่ใช้ทำรายงาน (ไม่ส่ง aiData/ไฟล์) · คนที่ไม่มีสิทธิ์ดูทุกงาน ได้เฉพาะงานที่ตัวเองเกี่ยวข้อง
   */
  router.post("/service-report-summaries", verifyToken, async (req, res) => {
    try {
      const keys = [...new Set((Array.isArray(req.body?.jobKeys) ? req.body.jobKeys : []).map(String))].slice(0, 3000);
      if (!keys.length) return res.json({ summaries: [] });
      const ServiceReportSummary = require("../../models/ServiceReportSummary");
      let list = await ServiceReportSummary.find({ jobKey: { $in: keys } })
        .select("jobKey eventIds status data scannedAt confirmedAt confirmedBy editedAt").lean();
      if (!can(req.user, "viewAllJobs") && !can(req.user, "editAnyJob")) {
        const ids = [...new Set(list.flatMap((x) => x.eventIds || []))];
        const evs = await CalendarEvent.find({ _id: { $in: ids } }).select(SR_SELECT).lean();
        const mine = new Set(evs.filter((e) => isJobParticipant(e, req.userId, req.user.fname)).map((e) => String(e._id)));
        list = list.filter((x) => (x.eventIds || []).some((id) => mine.has(String(id))));
      }
      res.json({ summaries: list.map(({ eventIds, ...x }) => x) });
    } catch (err) {
      console.error("❌ โหลดสรุป Service Report หลายงานไม่สำเร็จ:", err?.message);
      res.status(500).json({ message: "โหลดสรุป Service Report ไม่สำเร็จ" });
    }
  });

  /** บันทึกผล AI อ่าน Service Report เป็น "ร่าง" (ใช้ทั้งกดอ่านเอง และตรวจอัตโนมัติตอนขอปิดงาน) */
  const srSaveScan = async (ctx, files, scanned, by) => {
    const ServiceReportScan = require("../../services/ServiceReportScan");
    const ServiceReportSummary = require("../../models/ServiceReportSummary");
    const { usage, ...result } = scanned;
    const summary = await ServiceReportSummary.findOneAndUpdate(
      { jobKey: ctx.jobKey },
      {
        $set: {
          eventIds: ctx.eventIds, status: "draft", aiData: result, data: result,
          files: files.map((f) => ({ fileName: f.fileName, fileUrl: f.fileUrl })),
          model: ServiceReportScan.MODEL, scannedAt: new Date(), scannedBy: by,
          editedAt: null, editedBy: "", confirmedAt: null, confirmedBy: "",
          usage: usage || null,
        },
        // 💰 ค่าใช้จ่ายสะสมของงานนี้ (อ่านใหม่ = จ่ายเพิ่ม) — แสดงในหน้าต่างสรุป
        $inc: { scanCount: 1, totalCostUsd: usage?.costUsd || 0 },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    ).lean();
    await srMark(ctx.eventIds, "draft", by);
    return summary;
  };

  /**
   * POST /:id/close-check — ตรวจเอกสารประจำงานด้วย AI ก่อนขอปิดงาน (ดู services/CloseCheck.js)
   * ✅ (26 ต.ค. 2569 ผู้ใช้) ประเภทเอกสารผิดช่อง · Service Report อ่านไม่ได้ · พบรายการต้องเสนอราคาแต่ยังไม่มีใบเสนอราคา = ไม่ผ่าน
   *    💰 ไฟล์ไม่เปลี่ยนจากครั้งก่อน = ส่งผลเดิมกลับ (ไม่เรียก AI) · Service Report ใช้สรุปเดิมถ้าไฟล์ชุดเดียวกัน
   *    ผลเก็บที่ทุกวันของงาน (closeCheck) — PUT /:id ใช้ผลนี้ตัดสินว่าขอปิดงานได้ไหม
   */
  router.post("/:id/close-check", verifyToken, async (req, res) => {
    try {
      const ctx = await srContext(req);
      if (ctx.error) return res.status(ctx.error[0]).json({ message: ctx.error[1] });
      if (!ctx.canEdit && !can(req.user, "approveJobs")) return res.status(403).json({ message: "ตรวจเอกสารได้เฉพาะผู้เกี่ยวข้องกับงาน หรือผู้อนุมัติปิดงาน" });
      if (!require("../../services/InvoiceScan").isEnabled()) return res.json({ check: { ok: true, skipped: true, problems: [] } });
      const CloseCheck = require("../../services/CloseCheck");
      const ids = ctx.eventIds;
      const sessions = await CalendarEvent.find({ _id: { $in: ids } })
        .select("reportFiles quotationFiles invoiceFiles completionFiles quotationApplicable invoiceApplicable completionApplicable closeCheck").lean();
      const key = CloseCheck.filesKey(sessions);
      const prev = sessions.find((s) => s.closeCheck?.key)?.closeCheck;
      if (prev?.key === key && !req.body?.force) return res.json({ check: prev, cached: true });

      // 1) ประเภทเอกสารทุกช่อง (Haiku รูปย่อ)
      const { results, usage: clsUsage } = await CloseCheck.classify(CloseCheck.collectFiles(sessions));
      // 🔁 (26 ต.ค. 2569 ผู้ใช้: "กดขอปิดงานแล้วไม่มีการตรวจเลย ... ต้องตรวจทั้งหมด") เข้มขึ้น:
      //    ไม่ตรงชัดเจน = ผิดประเภท · AI ยืนยันไม่ได้ (ภาพไม่ชัด/ดูไม่ออก) ก็ไม่ผ่าน — มีทางขอแอดมินพิจารณาอยู่แล้ว
      const problems = results.filter((r) => r.matches !== "yes").map((r) => ({
        code: r.matches === "no" ? "wrong_type" : "unsure_type", slot: r.slot, slotLabel: r.slotLabel, fileName: r.fileName, fileUrl: r.fileUrl,
        text: r.matches === "no"
          ? `ไฟล์ “${r.fileName || "ไม่มีชื่อ"}” ดูเป็น ${r.detected || "เอกสารอื่น"} — ไม่ใช่${r.slotLabel} ให้ลบแล้วแนบไฟล์ที่ถูกต้อง`
          : `AI ยืนยันไม่ได้ว่าไฟล์ “${r.fileName || "ไม่มีชื่อ"}” เป็น${r.slotLabel} (ดูเหมือน: ${r.detected || "ไม่ชัด"}) — ตรวจว่าแนบถูกช่องและถ่ายให้ชัด`,
      }));

      // 2) เนื้อหา Service Report (อ่านอัตโนมัติ ถ้ายังไม่เคยอ่านหรือไฟล์เปลี่ยน)
      const ServiceReportScan = require("../../services/ServiceReportScan");
      const ServiceReportSummary = require("../../models/ServiceReportSummary");
      const srFiles = ServiceReportScan.scannableFiles(ctx.files);
      let summary = await ServiceReportSummary.findOne({ jobKey: ctx.jobKey }).lean();
      const same = summary && srFiles.length === (summary.files || []).length
        && srFiles.every((f) => (summary.files || []).some((x) => x.fileUrl === f.fileUrl));
      let srCost = 0;
      if (srFiles.length && !same) {
        const scanned = await ServiceReportScan.scanServiceReport(srFiles);
        srCost = scanned.usage?.costUsd || 0;
        summary = await srSaveScan(ctx, srFiles, scanned, `${srActor(req)} (ตรวจอัตโนมัติตอนขอปิดงาน)`);
      }
      // AI อ่านแล้วบอกว่าไม่ใช่ใบ Service Report (เช่น แนบภาพร่าง/รูปหน้างานมาแทน) — ไม่ผ่าน
      if (summary && summary.aiData && summary.aiData.found === false && !problems.some((p) => p.slot === "reportFiles")) {
        problems.push({
          code: "sr_not_found", slot: "reportFiles", slotLabel: "Service Report",
          text: "ไฟล์ในช่อง Service Report ไม่ใช่ใบ Service Report (AI อ่านแล้วไม่พบรายงานการเข้าปฏิบัติงาน) — แนบใบ Service Report ที่ช่างเขียนจริง",
        });
      }
      if (summary) {
        ServiceReportScan.unreadableFiles(summary.aiData).forEach((x) => problems.push({
          code: "sr_unreadable", slot: "reportFiles", slotLabel: "Service Report",
          text: `Service Report ไฟล์ที่ ${x.no} ${x.status === "unreadable" ? "อ่านไม่ได้" : "อ่านได้ไม่ครบ"} (${x.note || "ภาพไม่ชัด"}) — ถ่ายใหม่ให้ชัดแล้วแนบแทน`,
        }));
      }
      const quoteItems = (summary?.data?.issues || []).filter((x) => x.status === "need_quote")
        .map((x) => [x.part, x.problem].filter(Boolean).join(" — ") + (x.qty ? ` จำนวน ${x.qty}` : "") + (x.location ? ` (${x.location})` : ""));
      const hasQuoteFile = sessions.some((s) => (s.quotationFiles || []).length > 0);
      if (quoteItems.length && !hasQuoteFile) {
        problems.push({
          code: "need_quote", slot: "quotationFiles", slotLabel: "ใบเสนอราคาเพิ่มเติม", items: quoteItems.slice(0, 12),
          text: `AI อ่าน Service Report แล้วพบรายการที่ต้องเปลี่ยนอุปกรณ์/เสนอราคา ${quoteItems.length} รายการ — ต้องแนบใบเสนอราคาเพิ่มเติมก่อนจึงจะขอปิดงานได้`,
        });
      }
      const check = {
        key, at: new Date(), by: srActor(req), ok: problems.length === 0, problems,
        // ผลรายไฟล์ (ให้หน้าจอแสดงว่า AI เห็นอะไร — ผ่านก็เห็นว่าตรวจจริง)
        files: results.map((r) => ({ slotLabel: r.slotLabel, fileName: r.fileName, matches: r.matches, detected: r.detected })),
        srFound: summary ? summary.aiData?.found !== false : null,
        needQuote: quoteItems.length > 0, quoteItems: quoteItems.slice(0, 12),
        costUsd: Math.round(((clsUsage?.costUsd || 0) + srCost) * 10000) / 10000,
      };
      await CalendarEvent.updateMany({ _id: { $in: ids } }, { $set: { closeCheck: check } });
      res.json({ check });
    } catch (err) {
      console.error("❌ ตรวจเอกสารก่อนปิดงานไม่สำเร็จ:", err?.status, err?.message);
      res.status(502).json({ message: require("../../services/aiFileSource").safeAiError(err) });
    }
  });

  router.get("/:id/service-report-summary", verifyToken, async (req, res) => {
    try {
      const ctx = await srContext(req);
      if (ctx.error) return res.status(ctx.error[0]).json({ message: ctx.error[1] });
      const ServiceReportSummary = require("../../models/ServiceReportSummary");
      const summary = await ServiceReportSummary.findOne({ jobKey: ctx.jobKey }).lean();
      // ✅ วันเข้างาน/ทีมของทุกวันในงาน — หัวรายงาน PDF ใช้ข้อมูลจากระบบ (ไม่อ่านหัวกระดาษ Service Report)
      const sessions = ctx.sessions.map((x) => ({ start: x.start, end: x.end, allDay: x.allDay, startTime: x.startTime || "", endTime: x.endTime || "", team: x.team || "", teamMembers: (x.teamMembers || []).map((m) => ({ name: m?.name || "" })) }));
      res.json({ enabled: require("../../services/InvoiceScan").isEnabled(), canEdit: ctx.canEdit, files: ctx.files, sessions, summary, rescanLeft: srRescanLeft(summary), rescanPerDay: SR_RESCAN_PER_DAY });
    } catch (err) {
      console.error("❌ โหลดสรุป Service Report ไม่สำเร็จ:", err?.message);
      res.status(500).json({ message: "โหลดสรุปไม่สำเร็จ" });
    }
  });

  router.post("/:id/service-report-summary/scan", verifyToken, async (req, res) => {
    try {
      if (!require("../../services/InvoiceScan").isEnabled()) {
        return res.status(503).json({ message: "ยังไม่ได้เปิดใช้งานการอ่านเอกสารด้วย AI (ไม่พบ ANTHROPIC_API_KEY ที่เซิร์ฟเวอร์)" });
      }
      const ctx = await srContext(req);
      if (ctx.error) return res.status(ctx.error[0]).json({ message: ctx.error[1] });
      const ServiceReportScan = require("../../services/ServiceReportScan");
      const files = ServiceReportScan.scannableFiles(ctx.files);
      if (!files.length) return res.status(400).json({ message: "ยังไม่มีไฟล์ Service Report (รูปหรือ PDF) ในงานนี้" });
      const ServiceReportSummary = require("../../models/ServiceReportSummary");
      const prev = await ServiceReportSummary.findOne({ jobKey: ctx.jobKey }).select("status editedAt").lean();
      // กันกดพลาดทับงานที่คนตรวจแล้ว — หน้าจอถามยืนยันก่อน แล้วส่ง force มา
      if (prev && (prev.status === "confirmed" || prev.editedAt) && !req.body?.force) {
        return res.status(409).json({
          message: prev.status === "confirmed" ? "สรุปนี้ยืนยันแล้ว อ่านใหม่จะทับข้อมูลเดิม" : "สรุปนี้มีการแก้ไขแล้ว อ่านใหม่จะทับข้อมูลที่แก้",
          needForce: true,
        });
      }
      // 💰 จองสิทธิ์อ่านใหม่แบบ atomic ก่อนเรียก AI (กดรัว/หลายเครื่องพร้อมกันก็ไม่เกินโควตา) · AI พลาด = คืนสิทธิ์
      const today = srToday();
      let reserved = false;
      if (prev) {
        const r = await ServiceReportSummary.updateOne(
          { jobKey: ctx.jobKey, $or: [{ rescanDay: { $ne: today } }, { rescansToday: { $lt: SR_RESCAN_PER_DAY } }] },
          [{ $set: { rescansToday: { $cond: [{ $eq: ["$rescanDay", today] }, { $add: [{ $ifNull: ["$rescansToday", 0] }, 1] }, 1] }, rescanDay: today } }],
        );
        if (!r.matchedCount) {
          return res.status(429).json({ message: `อ่านใหม่ครบ ${SR_RESCAN_PER_DAY} ครั้งของวันนี้แล้ว (จำกัดเพื่อประหยัดค่า AI) — แก้ไขสรุปเองได้ หรืออ่านใหม่ได้พรุ่งนี้`, rescanLeft: 0 });
        }
        reserved = true;
      }
      let scanned;
      try {
        scanned = await ServiceReportScan.scanServiceReport(files);
      } catch (err) {
        if (reserved) await ServiceReportSummary.updateOne({ jobKey: ctx.jobKey, rescanDay: today }, { $inc: { rescansToday: -1 } }).catch(() => {});
        throw err;
      }
      const summary = await srSaveScan(ctx, files, scanned, srActor(req));
      res.json({ summary, rescanLeft: srRescanLeft(summary) });
    } catch (err) {
      console.error("❌ สรุป Service Report ด้วย AI ไม่สำเร็จ:", err?.status, err?.message);
      res.status(502).json({ message: require("../../services/aiFileSource").safeAiError(err) });
    }
  });

  router.put("/:id/service-report-summary", verifyToken, async (req, res) => {
    try {
      const ctx = await srContext(req);
      if (ctx.error) return res.status(ctx.error[0]).json({ message: ctx.error[1] });
      if (!ctx.canEdit) return res.status(403).json({ message: "แก้ไขสรุปได้เฉพาะผู้เกี่ยวข้องกับงาน" });
      const ServiceReportSummary = require("../../models/ServiceReportSummary");
      const prev = await ServiceReportSummary.findOne({ jobKey: ctx.jobKey }).lean();
      if (!prev) return res.status(404).json({ message: "ยังไม่มีสรุป — กด “สรุปด้วย AI” ก่อน" });
      const { normalize, unreadableFiles } = require("../../services/ServiceReportScan");
      const by = srActor(req);
      const now = new Date();
      const confirm = Boolean(req.body?.confirm);
      // ⛔ ไฟล์ที่ AI อ่านไม่ได้/ไม่ครบ (ถ่ายไม่ชัด) — ยืนยันไม่ได้ ต้องถ่ายใหม่แล้วอ่านใหม่ (ผู้ใช้ 25 ต.ค. 2569)
      const bad = unreadableFiles(prev.aiData);
      if (confirm && bad.length) {
        return res.status(409).json({ message: `ยืนยันไม่ได้ — AI อ่านไฟล์ที่ ${bad.map((x) => x.no).join(", ")} ไม่ได้/ไม่ครบ (ถ่ายไม่ชัด) ให้ถ่ายใหม่ให้ชัด แนบแทน แล้วกดอ่านใหม่` });
      }
      const $set = { status: confirm ? "confirmed" : "draft", eventIds: ctx.eventIds };
      if (req.body?.data) {
        Object.assign($set, { data: { ...normalize(req.body.data), fileCount: prev.data?.fileCount || prev.files?.length || 0 }, editedAt: now, editedBy: by });
      }
      if (confirm) Object.assign($set, { confirmedAt: now, confirmedBy: by });
      else Object.assign($set, { confirmedAt: null, confirmedBy: "" });
      const summary = await ServiceReportSummary.findOneAndUpdate({ jobKey: ctx.jobKey }, { $set }, { new: true }).lean();
      await srMark(ctx.eventIds, $set.status, by);
      res.json({ summary });
    } catch (err) {
      console.error("❌ บันทึกสรุป Service Report ไม่สำเร็จ:", err?.message);
      res.status(500).json({ message: "บันทึกสรุปไม่สำเร็จ" });
    }
  });

  // ✅ ผลใบเสนอราคา (ได้งาน/ไม่ได้งาน) — ใช้ทั้งแอดมินบันทึกเอง และอนุมัติตามคำขอ
  const applyDecision = (d, decidedBy, approvedBy, now) => ({
    quotationStatus: d.action === "approve" ? "approved" : "rejected",
    quotationDecisionAt: d.decidedAt || now, quotationDecisionBy: decidedBy,
    quotationDecisionNote: d.note || "", quotationPoNo: d.action === "approve" ? d.poNo || "" : "",
    quotationNextFollowUpAt: null, quotationDecisionRequest: null,
    quotationDecisionApprovedBy: approvedBy, quotationDecisionApprovedAt: now,
  });
  // ผู้อนุมัติผล = ระดับที่มีสิทธิ์ editFinance (ตั้งในตารางสิทธิ์) · ไม่มีการตั้ง = หัวหน้า/ผู้จัดการ
  const financeRanks = () => require("../../config/roles").effectiveCapabilities().editFinance || SUPERVISOR_ROLES;

  router.put("/:id/quotation", verifyToken, async (req, res) => {
    try {
      const anchor = await CalendarEvent.findById(req.params.id);
      if (!anchor) return res.status(404).json({ message: "ไม่พบงานนี้" });
      const isFinance = can(req.user, "editFinance");
      if (!isFinance && !isJobParticipant(anchor, req.userId, req.user.fname)) {
        return res.status(403).json({ message: "แก้ไขใบเสนอราคาได้เฉพาะงานที่คุณเกี่ยวข้องเท่านั้น" });
      }
      const body = req.body || {};
      const actorName = [req.user.fname, req.user.lname].filter(Boolean).join(" ") || req.user.username;
      const now = new Date();
      const $set = {};
      const changes = [];
      const str = (v, max) => String(v ?? "").trim().slice(0, max);

      if (body.quotationNo !== undefined) { $set.quotationNo = str(body.quotationNo, 60); changes.push("เลขที่"); }
      if (body.quotationDate !== undefined) { $set.quotationDate = parseDay(body.quotationDate); changes.push("วันที่ใบเสนอราคา"); }
      if (body.quotationValidUntil !== undefined) { $set.quotationValidUntil = parseDay(body.quotationValidUntil); changes.push("ยืนราคา"); }
      if (body.quotationVatIncluded !== undefined) $set.quotationVatIncluded = body.quotationVatIncluded === true || body.quotationVatIncluded === "true";
      if (body.quotationContact !== undefined) {
        const c = body.quotationContact || {};
        $set.quotationContact = { name: str(c.name, 120), phone: str(c.phone, 40), email: str(c.email, 120) };
        changes.push("ผู้ติดต่อ");
      }
      // ✅ (19 ต.ค. 2569) แก้/เติมรายละเอียดผลภายหลังได้ (เลข PO · วันที่ลูกค้าตอบ · หมายเหตุ/เหตุผล) โดยไม่เปลี่ยนสถานะ
      if (body.quotationPoNo !== undefined) { $set.quotationPoNo = str(body.quotationPoNo, 60); changes.push("เลข PO"); }
      if (body.quotationDecisionNote !== undefined) {
        $set.quotationDecisionNote = str(body.quotationDecisionNote, 500);
        if (anchor.quotationStatus === "rejected" && !$set.quotationDecisionNote) return res.status(400).json({ message: "กรุณาระบุเหตุผลที่ไม่ได้งาน" });
        changes.push(anchor.quotationStatus === "rejected" ? "เหตุผล" : "หมายเหตุผล");
      }
      if (body.quotationDecisionAt !== undefined) {
        const d = parseDay(body.quotationDecisionAt, true);
        if (d) { $set.quotationDecisionAt = d; changes.push("วันที่ลูกค้าตอบ"); }
      }
      if (body.quotationNextFollowUpAt !== undefined) { $set.quotationNextFollowUpAt = parseDay(body.quotationNextFollowUpAt); changes.push("นัดติดตาม"); }
      if (body.quotationAmount !== undefined) {
        if (!isFinance) return res.status(403).json({ message: "แก้มูลค่าใบเสนอราคาได้เฉพาะฝ่ายบริหาร/การเงิน" });
        const amount = body.quotationAmount === null || body.quotationAmount === "" ? null : Number(body.quotationAmount);
        if (amount !== null && (!Number.isFinite(amount) || amount < 0)) return res.status(400).json({ message: "มูลค่าใบเสนอราคาไม่ถูกต้อง" });
        $set.quotationAmount = amount === null ? null : Math.round(amount * 100) / 100;
        changes.push("มูลค่า");
      }
      const qDate = $set.quotationDate !== undefined ? $set.quotationDate : anchor.quotationDate;
      const qValid = $set.quotationValidUntil !== undefined ? $set.quotationValidUntil : anchor.quotationValidUntil;
      if (qDate && qValid && qValid < qDate) return res.status(400).json({ message: "วันยืนราคาต้องไม่ก่อนวันที่ใบเสนอราคา" });

      // ช่องที่คนแก้เอง = ตรวจแล้ว → เอาออกจากรายการที่ AI เติม (ป้าย "AI" หายเฉพาะช่องนั้น)
      if (anchor.quotationAiFilled?.fields?.length) {
        const touched = ["quotationNo", "quotationDate", "quotationValidUntil", "quotationAmount", "quotationContact"].filter((key) => body[key] !== undefined);
        if (touched.length) $set["quotationAiFilled.fields"] = anchor.quotationAiFilled.fields.filter((f) => !touched.includes(f));
      }
      let log = changes.length ? ["quotation_updated", `แก้ข้อมูลใบเสนอราคา (${changes.join(" · ")})`] : null;
      let pushAfter = null;
      const action = String(body.action || "");
      if (action) {
        const hasFiles = (anchor.quotationFiles || []).length > 0;
        if (action === "send") {
          if (!hasFiles) return res.status(409).json({ message: "ต้องแนบไฟล์ใบเสนอราคาก่อนบันทึกว่าส่งลูกค้าแล้ว" });
          Object.assign($set, {
            quotationStatus: "sent", quotationSentAt: parseDay(body.sentAt, true) || now,
            quotationDecisionAt: null, quotationDecisionBy: null, quotationDecisionNote: "", quotationPoNo: "",
            quotationDecisionRequest: null, quotationDecisionApprovedBy: "", quotationDecisionApprovedAt: null,
          });
          log = ["quotation_sent", anchor.quotationStatus ? "ส่งใบเสนอราคา (ฉบับแก้ไข) ให้ลูกค้าอีกครั้ง" : "ส่งใบเสนอราคาให้ลูกค้า"];
        } else if (action === "approve" || action === "reject") {
          if (!anchor.quotationStatus) return res.status(409).json({ message: "ยังไม่ได้บันทึกว่าส่งใบเสนอราคาให้ลูกค้า" });
          if (["approved", "rejected"].includes(anchor.quotationStatus)) return res.status(409).json({ message: "ใบนี้บันทึกผลแล้ว" });
          const note = str(body.decisionNote, 500);
          if (action === "reject" && !note) return res.status(400).json({ message: "กรุณาระบุเหตุผลที่ลูกค้าปฏิเสธ" });
          const decision = { action, decidedAt: parseDay(body.decidedAt, true) || now, poNo: action === "approve" ? str(body.poNo, 60) : "", note };
          const label = action === "approve" ? "ได้งาน" : "ไม่ได้งาน";
          if (!isFinance) {
            // ✅ ไม่ใช่แอดมิน = ส่งคำขอ รออนุมัติ — สถานะใบยังไม่เปลี่ยน (ยังนับติดตามต่อ)
            if (anchor.quotationDecisionRequest?.action) return res.status(409).json({ message: "มีคำขอบันทึกผลรออนุมัติอยู่แล้ว — ยกเลิกคำขอเดิมก่อน" });
            $set.quotationDecisionRequest = { ...decision, by: actorName, byId: String(req.userId), at: now };
            log = ["quotation_decision_requested", `ขอบันทึกผล "${label}" — รอแอดมินอนุมัติ${decision.poNo ? ` (PO ${decision.poNo})` : ""}${note ? ` · ${note}` : ""}`];
            pushAfter = () => sendPushToRoles(financeRanks(), {
              title: `🧾 ${actorName} ขออนุมัติผลใบเสนอราคา: ${label}`,
              body: `${[anchor.company, anchor.site].filter(Boolean).join(" · ") || anchor.title || "ใบเสนอราคา"}${anchor.quotationNo ? ` · ${anchor.quotationNo}` : ""}${note ? ` · ${note}` : ""}`,
              url: `/finance?tab=quotations&jobId=${anchor._id}`,
              tag: `quotation-decision-${anchor._id}`,
              renotify: true,
            }, [String(req.userId)]);
          } else {
            Object.assign($set, applyDecision(decision, actorName, actorName, now));
            log = action === "approve"
              ? ["quotation_approved", `ลูกค้าอนุมัติใบเสนอราคา${decision.poNo ? ` (PO ${decision.poNo})` : ""}`]
              : ["quotation_rejected", `ลูกค้าปฏิเสธใบเสนอราคา — ${note}`];
          }
        } else if (action === "approveRequest" || action === "rejectRequest") {
          // ✅ แอดมินพิจารณาคำขอบันทึกผล
          if (!isFinance) return res.status(403).json({ message: "อนุมัติผลใบเสนอราคาได้เฉพาะฝ่ายบริหาร/การเงิน" });
          const r = anchor.quotationDecisionRequest;
          if (!r?.action) return res.status(409).json({ message: "ไม่มีคำขอบันทึกผลที่รออนุมัติ (อาจถูกยกเลิกหรืออนุมัติไปแล้ว)" });
          const label = r.action === "approve" ? "ได้งาน" : "ไม่ได้งาน";
          if (action === "approveRequest") {
            // แอดมินแก้ PO/หมายเหตุ/วันที่ตอนอนุมัติได้ (ไม่ส่ง = ตามคำขอ)
            const decision = {
              action: r.action,
              decidedAt: parseDay(body.decidedAt, true) || (r.decidedAt ? new Date(r.decidedAt) : now),
              poNo: r.action === "approve" ? (body.poNo !== undefined ? str(body.poNo, 60) : str(r.poNo, 60)) : "",
              note: body.decisionNote !== undefined ? str(body.decisionNote, 500) : str(r.note, 500),
            };
            if (decision.action === "reject" && !decision.note) return res.status(400).json({ message: "กรุณาระบุเหตุผลที่ไม่ได้งาน" });
            Object.assign($set, applyDecision(decision, r.by || actorName, actorName, now));
            log = [r.action === "approve" ? "quotation_approved" : "quotation_rejected", `อนุมัติผล "${label}" ตามคำขอของ ${r.by || "-"}${decision.poNo ? ` (PO ${decision.poNo})` : ""}${decision.note ? ` · ${decision.note}` : ""}`];
            pushAfter = () => r.byId && sendPushToUsers([r.byId], {
              title: `✅ อนุมัติผลใบเสนอราคาแล้ว: ${label}`,
              body: `${[anchor.company, anchor.site].filter(Boolean).join(" · ")}${anchor.quotationNo ? ` · ${anchor.quotationNo}` : ""} · โดย ${actorName}`,
              url: `/finance?tab=quotations&jobId=${anchor._id}`, tag: `quotation-decision-${anchor._id}`,
            });
          } else {
            const reason = str(body.reason, 300);
            if (!reason) return res.status(400).json({ message: "กรุณาระบุเหตุผลที่ไม่อนุมัติ" });
            $set.quotationDecisionRequest = null;
            log = ["quotation_decision_request_rejected", `ไม่อนุมัติคำขอบันทึกผล "${label}" ของ ${r.by || "-"} — ${reason}`];
            pushAfter = () => r.byId && sendPushToUsers([r.byId], {
              title: `↩️ ไม่อนุมัติผลใบเสนอราคา "${label}"`,
              body: `${[anchor.company, anchor.site].filter(Boolean).join(" · ")} · ${reason} · โดย ${actorName}`,
              url: `/finance?tab=quotations&jobId=${anchor._id}`, tag: `quotation-decision-${anchor._id}`,
            });
          }
        } else if (action === "cancelRequest") {
          const r = anchor.quotationDecisionRequest;
          if (!r?.action) return res.status(409).json({ message: "ไม่มีคำขอที่รออนุมัติ" });
          if (!isFinance && String(r.byId) !== String(req.userId)) return res.status(403).json({ message: "ยกเลิกได้เฉพาะคนที่ส่งคำขอ" });
          $set.quotationDecisionRequest = null;
          log = ["quotation_decision_request_cancelled", `ยกเลิกคำขอบันทึกผล "${r.action === "approve" ? "ได้งาน" : "ไม่ได้งาน"}"`];
        } else if (action === "reset") {
          if (!isFinance) return res.status(403).json({ message: "ย้อนสถานะใบเสนอราคาได้เฉพาะฝ่ายบริหาร/การเงิน" });
          Object.assign($set, {
            quotationStatus: null, quotationSentAt: null, quotationDecisionAt: null, quotationDecisionBy: null,
            quotationDecisionNote: "", quotationPoNo: "", quotationNextFollowUpAt: null,
            quotationDecisionRequest: null, quotationDecisionApprovedBy: "", quotationDecisionApprovedAt: null,
          });
          log = ["quotation_reset", "ย้อนสถานะใบเสนอราคากลับเป็น \"ยังไม่ส่งลูกค้า\""];
        } else {
          return res.status(400).json({ message: "คำสั่งไม่ถูกต้อง" });
        }
      }
      if (!Object.keys($set).length) return res.status(400).json({ message: "ไม่มีข้อมูลที่จะบันทึก" });

      // ✅ งานหลายวัน (jobGroupId เดียวกัน) = ใบเสนอราคาใบเดียว — บันทึกทุกวันของงานพร้อมกัน
      const filter = anchor.jobGroupId ? { jobGroupId: anchor.jobGroupId } : { _id: anchor._id };
      await CalendarEvent.updateMany(filter, { $set });
      if (log) {
        await CalendarEvent.updateOne({ _id: anchor._id }, {
          $push: { activityLog: { action: log[0], detail: log[1], userId: String(req.userId), userName: actorName, timestamp: now } },
        });
      }
      // แก้ผล (reset) แล้วใบที่มีไฟล์อยู่ → เริ่มนับติดตามต่อทันที (กลับไป "รอลูกค้าตอบ") ไม่ค้างที่ "กำลังเริ่มนับ"
      if (action === "reset") await require("../../services/quotationAutoStart").syncQuotationStartSafe({ ids: [anchor._id] });
      if (pushAfter) Promise.resolve().then(pushAfter).catch((e) => console.error("❌ Push (quotation decision):", e?.message));
      const event = await CalendarEvent.findById(anchor._id).lean();
      res.json({ event });
    } catch (err) {
      console.error("❌ บันทึกใบเสนอราคาไม่สำเร็จ:", err);
      res.status(500).json({ message: "บันทึกใบเสนอราคาไม่สำเร็จ" });
    }
  });

  // ✅ จัดหมวดหมู่งานที่ไม่มี contractGroupId — "" (ยังไม่จัดกลุ่ม) / "general" (งานทั่วไป) / "project"
  // (งานโปรเจค) เฉพาะงานที่ไม่มี contractGroupId เท่านั้นที่จัดหมวดหมู่นี้ได้ ก่อนจัดจะแสดงเป็น "งานเก่า
  // ในระบบที่ยังไม่จัดกลุ่ม" เสมอ (ดูหน้า "ภาพรวมงาน" ContractOverview.js) — เฉพาะแอดมิน/manager เหมือน
  // route จัดการสัญญาอื่นๆ ในไฟล์นี้ ไม่ผูกกับสิทธิ์ความเป็นเจ้าของ/ผู้ถูกมอบหมายแบบ PUT /:id ทั่วไป
  // เพราะเป็นการจัดหมวดหมู่เชิงบริหารจัดการ
  // (เดิมชื่อ "/general" รับแค่ true/false สำหรับ "งานทั่วไป" อย่างเดียว — เปลี่ยนเป็น "/classify" รองรับ
  // 3 หมวดหมู่แทน ตอนนี้ยังไม่มีใครเรียก path เดิมนอกจากหน้านี้ จึงเปลี่ยน path ตรงๆ ได้เลยไม่ต้องเก็บของเก่าไว้คู่กัน)
  /**
   * ✅ ขั้นตอนนัดหมายฝ่ายขาย (7 ต.ค. 2569 ผู้ใช้: "เซลเข้างานแล้ว จะกดเข้าพบแล้ว และปิดงาน ต้องให้อัพรูปหน้างานก่อน")
   *    นัดหมายแล้ว → เข้าพบแล้ว (ต้องมีรูปหน้างาน ≥ 1) → ปิดงานแล้ว (ต้องมีรูป + ผลการเข้าพบ)
   *    เลื่อนนัด / ยกเลิกนัด ได้ตลอดก่อนปิดงาน · เปิดงานที่ปิดแล้วอีกครั้งได้เฉพาะแอดมิน/ผู้จัดการ
   *    สิทธิ์: เจ้าของนัด/ผู้เกี่ยวข้อง หรือแอดมิน/ผู้จัดการ
   */
  const SALES_FLOW = ["นัดหมายแล้ว", "เข้าพบแล้ว", "ปิดงานแล้ว", "เลื่อนนัด", "ยกเลิกนัด"];
  router.put("/:id/sales-status", verifyToken, async (req, res) => {
    try {
      const event = await CalendarEvent.findById(req.params.id);
      if (!event) return res.status(404).json({ message: "ไม่พบนัดหมายนี้" });
      if (event.department !== "sales") return res.status(400).json({ message: "ใช้ได้กับนัดหมายฝ่ายขายเท่านั้น" });

      const isAdminOrManager = can(req.user, "editAnyJob");
      if (!isAdminOrManager && !isJobParticipant(event, req.userId, req.user.fname)) {
        return res.status(403).json({ message: "คุณไม่มีสิทธิ์แก้ไขนัดหมายนี้" });
      }

      const status = String(req.body.status || "").trim();
      const hasResult = typeof req.body.visitResult === "string";
      const visitResult = hasResult ? req.body.visitResult.trim().slice(0, 4000) : (event.visitResult || "");
      if (status && !SALES_FLOW.includes(status)) return res.status(400).json({ message: "สถานะไม่ถูกต้อง" });

      const photos = (event.sitePhotoFiles || []).length;
      const by = [req.user?.fname, req.user?.lname].filter(Boolean).join(" ") || req.user?.username || "";
      const set = {};
      if (hasResult) set.visitResult = visitResult;

      if (status && status !== event.status) {
        if (event.status === "ปิดงานแล้ว" && !isAdminOrManager) {
          return res.status(403).json({ message: "นัดนี้ปิดงานแล้ว — เปิดใหม่ได้เฉพาะแอดมิน/ผู้จัดการ" });
        }
        if ((status === "เข้าพบแล้ว" || status === "ปิดงานแล้ว") && photos === 0) {
          return res.status(400).json({ message: "ต้องแนบรูปหน้างานอย่างน้อย 1 รูปก่อน" });
        }
        if (status === "ปิดงานแล้ว" && !visitResult) {
          return res.status(400).json({ message: "กรุณาสรุปผลการเข้าพบก่อนปิดงาน" });
        }
        set.status = status;
        set.manualStatus = true;
        if (status === "เข้าพบแล้ว" || (status === "ปิดงานแล้ว" && !event.visitedAt)) {
          set.visitedAt = event.visitedAt || new Date();
          set.visitedBy = event.visitedBy || by;
        }
        if (status === "ปิดงานแล้ว") { set.salesClosedAt = new Date(); set.salesClosedBy = by; }
        else { set.salesClosedAt = null; set.salesClosedBy = ""; }
        if (status === "นัดหมายแล้ว" || status === "เลื่อนนัด" || status === "ยกเลิกนัด") {
          set.visitedAt = null; set.visitedBy = "";
        }
      } else if (event.status === "ปิดงานแล้ว" && hasResult && !isAdminOrManager) {
        return res.status(403).json({ message: "นัดนี้ปิดงานแล้ว แก้ผลการเข้าพบไม่ได้" });
      }

      const updated = await CalendarEvent.findByIdAndUpdate(event._id, { $set: set }, { new: true }).lean();
      res.json({ event: updated });
    } catch (error) {
      console.error("❌ Error updating sales status:", error);
      res.status(500).json({ message: "บันทึกสถานะไม่สำเร็จ" });
    }
  });

  router.put("/:id/classify", verifyToken, async (req, res) => {
    try {
      if (!can(req.user, "editAnyJob")) {
        return res.status(403).json({ message: "เฉพาะแอดมิน/manager เท่านั้นที่จัดหมวดหมู่งานได้" });
      }
      const { id } = req.params;
      const { classification } = req.body;
      if (!["", "general", "project"].includes(classification)) {
        return res.status(400).json({ message: "ประเภทหมวดหมู่ไม่ถูกต้อง" });
      }

      const target = await CalendarEvent.findById(id);
      if (!target) {
        return res.status(404).json({ message: "ไม่พบงานนี้" });
      }
      if (target.contractGroupId) {
        return res.status(400).json({ message: "งานนี้ผูกกับสัญญาอยู่แล้ว ไม่สามารถจัดหมวดหมู่นี้ได้" });
      }

      // 🐛 BUG ที่แก้ (จัดหมวดหมู่แล้วไม่ครบทุกวันของงานเดียวกัน): เดิมอัปเดตแค่ document เดียวตาม id
      // ที่ส่งมา — แต่ "งานที่เข้าหลายวันไม่ติดกัน" เป็นหลาย document ที่ผูกกันด้วย jobGroupId และหมวดหมู่
      // เป็นคุณสมบัติของ "ทั้งงาน" ไม่ใช่ของวันใดวันหนึ่ง — ฝั่งจอ (ContractOverview) ต้องวนยิงเองทีละ
      // document ถึงจะครบ ซึ่งพลาดได้ง่ายและไม่ช่วยอะไรกับข้อมูลที่ปนกันอยู่แล้ว
      // ✅ อัปเดตทั้งกลุ่มในคำสั่งเดียวเสมอ — กันหมวดหมู่ปนกันเองภายในงานเดียว และเป็นตัว "ซ่อม" ข้อมูลเก่า
      // ที่ปนไปแล้วด้วย (กดจัดหมวดหมู่ซ้ำอีกครั้งเดียว ทุกวันในงานนั้นจะกลับมาตรงกันทั้งหมด)
      const groupFilter = target.jobGroupId
        ? { jobGroupId: target.jobGroupId, contractGroupId: { $in: [null, ""] } }
        : { _id: id };
      await CalendarEvent.updateMany(groupFilter, { $set: { jobClassification: classification } });

      const updated = await CalendarEvent.findById(id).lean();
      res.json({ event: updated });
    } catch (error) {
      console.error("❌ Error classifying event:", error);
      res.status(500).send("Internal Server Error");
    }
  });

  // ✅ อนุมัติ/ไม่อนุมัติงานที่ช่าง/เซล (ใครก็ตามที่ไม่ใช่แอดมิน/manager) เป็นคนสร้าง — ดู
  // approvalStatus/POST //POST /draft ที่ตั้งค่า "pending" ไว้ตั้งแต่ตอนสร้าง เฉพาะแอดมิน/manager
  // เท่านั้นที่ตัดสินใจได้ ต้องอยู่ก่อน PUT /:id (path 1 segment เหมือนกันแค่ ":id" vs ":id/approval"
  // ไม่ชนกันอยู่แล้วเพราะ /:id/approval มี 2 segment — แต่วางไว้ก่อนตามธรรมเนียมไฟล์นี้ที่ให้ route
  // เฉพาะเจาะจงกว่ามาก่อนเสมอ)
  router.put("/:id/approval", verifyToken, async (req, res) => {
    try {
      if (!can(req.user, "approveJobs")) {
        return res.status(403).json({ message: "เฉพาะแอดมิน/manager เท่านั้นที่อนุมัติงานได้" });
      }
      const { id } = req.params;
      const { decision, reason } = req.body;
      if (!["approve", "reject"].includes(decision)) {
        return res.status(400).json({ message: "กรุณาระบุผลการอนุมัติ" });
      }

      const target = await CalendarEvent.findById(id);
      if (!target) {
        return res.status(404).json({ message: "ไม่พบงานนี้" });
      }
      // ✅ กันแอดมิน 2 คนกดตัดสินใจงานเดียวกันซ้ำ (race) — ตัดสินใจได้แค่ตอนยัง "pending" เท่านั้น
      if (target.approvalStatus !== "pending") {
        return res.status(400).json({ message: "งานนี้ไม่ได้อยู่ระหว่างรออนุมัติ" });
      }

      const approverName = [req.user?.fname, req.user?.lname].filter(Boolean).join(" ") || req.user?.username || "แอดมิน";
      const update = decision === "approve"
        ? {
            approvalStatus: "approved",
            approvalDecidedAt: new Date(),
            approvalDecidedBy: approverName,
            // ✅ ล้างเหตุผลไม่อนุมัติรอบก่อนหน้าทิ้ง (ถ้ามี จากรอบ reject → แก้ไข → resubmit → approve)
            // กันข้อความเก่าค้างอยู่ทั้งที่อนุมัติไปแล้วจริง
            approvalRejectReason: "",
          }
        : {
            approvalStatus: "rejected",
            approvalDecidedAt: new Date(),
            approvalDecidedBy: approverName,
            approvalRejectReason: reason || "",
          };

      // ✅ งานที่เข้าหลายวันไม่ติดกัน (ผูกด้วย jobGroupId เดียวกัน) ต้องตัดสินใจพร้อมกันทั้งกลุ่ม ไม่ใช่
      // แค่ document เดียว ไม่งั้นวันอื่นๆ ของงานเดียวกันจะค้างสถานะ "รออนุมัติ" ทั้งที่จริงตัดสินใจไปแล้ว
      const filter = target.jobGroupId ? { jobGroupId: target.jobGroupId } : { _id: id };
      await CalendarEvent.updateMany(filter, { $set: update });
      const events = await CalendarEvent.find(filter);

      // ✅ แจ้งผู้ขออนุมัติเสมอ (ทั้งอนุมัติและไม่อนุมัติ) — ใช้ลำดับ fallback เดียวกับที่อื่นในไฟล์นี้:
      // คนที่ขออนุมัติจริง (approvalRequestedByUserId) → คนสร้าง (userId) → ผู้รับผิดชอบ (resPerson)
      const notifyUserId = target.approvalRequestedByUserId || target.userId || target.resPerson;
      if (notifyUserId) {
        const jobLabel = `${target.title || "งาน"} · ${target.company || "-"}${target.site ? " - " + target.site : ""}`;
        sendPushToUsers(notifyUserId, {
          title: decision === "approve" ? "✅ งานของคุณได้รับการอนุมัติแล้ว" : "❌ งานของคุณไม่ได้รับการอนุมัติ",
          body: decision === "approve" ? jobLabel : `${jobLabel}${reason ? " · เหตุผล: " + reason : ""}`,
          url: `/operation/${id}`,
          tag: `approval-decided-${target.jobGroupId || id}`,
          renotify: true,
        }).catch((err) => console.error("❌ Push notify error (approval-decided):", err));

        // ✅ เดิม POST / เลื่อนการแจ้งเตือน "มอบหมายงานใหม่ให้คุณ" มาไว้ตรงนี้แทน (ดูคอมเมนต์ที่นั่น) —
        // แจ้งเฉพาะตอนอนุมัติ (ไม่ใช่ตอนสร้าง) และเฉพาะเมื่อมีคนรับผิดชอบจริงที่ไม่ใช่ตัวผู้ขอเอง
        if (decision === "approve" && target.resPerson && target.resPerson !== notifyUserId) {
          sendPushToUsers(target.resPerson, {
            title: `📋 ${approverName} อนุมัติและมอบหมายงานให้คุณ`,
            body: jobLabel,
            url: `/operation/${id}`,
            tag: `approval-decided-${target.jobGroupId || id}`,
            renotify: true,
          }).catch((err) => console.error("❌ Push notify error (approval-assign):", err));
        }
      }

      res.json({ events });
    } catch (error) {
      console.error("❌ Error deciding job approval:", error);
      res.status(500).send("Internal Server Error");
    }
  });
};
