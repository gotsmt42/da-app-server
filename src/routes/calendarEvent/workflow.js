/**
 * การเปลี่ยนสถานะเชิงกระบวนการ — ติดตามใบเสนอราคา จัดหมวดงาน อนุมัติปิดงาน
 *
 * แยกออกมาจาก routes/calendarEvent.js เดิมที่ยาว 2,708 บรรทัดในไฟล์เดียว (29 route)
 * ⚠️ ลำดับการประกาศ route ภายในไฟล์นี้ = ลำดับเดิม ห้ามสลับ (ดูเหตุผลที่ index.js)
 */
const {
  CalendarEvent,
  verifyToken,
  upload,
  cloudinary,
  streamifier,
  sendPushToUsers,
  isJobParticipant,
} = require("./shared");

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
      const isAdminOrManager = ["admin", "manager"].includes(req.user.role);
      if (!isAdminOrManager && !isJobParticipant(existingEvent, userId, req.user.fname)) {
        return res.status(403).json({ message: "บันทึกการติดตามได้เฉพาะงานที่คุณเกี่ยวข้องเท่านั้น" });
      }

      if (!note || !note.trim()) {
        return res.status(400).json({ message: "กรุณากรอกรายละเอียดการติดตาม" });
      }

      const followUp = {
        attemptNumber: (existingEvent.quotationFollowUps?.length || 0) + 1,
        note: note.trim(),
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
        { $push: { quotationFollowUps: followUp, activityLog: logEntry } },
        { new: true },
      );

      res.status(200).json({ event: updatedEvent });
    } catch (err) {
      console.error("❌ Error adding quotation follow-up:", err);
      res.status(500).json({ message: "บันทึกการติดตามไม่สำเร็จ" });
    }
  });

  // ✅ จัดหมวดหมู่งานที่ไม่มี contractGroupId — "" (ยังไม่จัดกลุ่ม) / "general" (งานทั่วไป) / "project"
  // (งานโปรเจค) เฉพาะงานที่ไม่มี contractGroupId เท่านั้นที่จัดหมวดหมู่นี้ได้ ก่อนจัดจะแสดงเป็น "งานเก่า
  // ในระบบที่ยังไม่จัดกลุ่ม" เสมอ (ดูหน้า "ภาพรวมงาน" ContractOverview.js) — เฉพาะแอดมิน/manager เหมือน
  // route จัดการสัญญาอื่นๆ ในไฟล์นี้ ไม่ผูกกับสิทธิ์ความเป็นเจ้าของ/ผู้ถูกมอบหมายแบบ PUT /:id ทั่วไป
  // เพราะเป็นการจัดหมวดหมู่เชิงบริหารจัดการ
  // (เดิมชื่อ "/general" รับแค่ true/false สำหรับ "งานทั่วไป" อย่างเดียว — เปลี่ยนเป็น "/classify" รองรับ
  // 3 หมวดหมู่แทน ตอนนี้ยังไม่มีใครเรียก path เดิมนอกจากหน้านี้ จึงเปลี่ยน path ตรงๆ ได้เลยไม่ต้องเก็บของเก่าไว้คู่กัน)
  router.put("/:id/classify", verifyToken, async (req, res) => {
    try {
      if (!["admin", "manager"].includes(req.user.role)) {
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
      if (!["admin", "manager"].includes(req.user.role)) {
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
