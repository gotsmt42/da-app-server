const express = require("express");
const router = express.Router();

const CalendarEvent = require("../models/Events");
const User = require("../models/User");

const verifyToken = require("../middleware/auth");

const multer = require("multer");
const cloudinary = require("../config/cloudinaryConfig");

const storage = multer.memoryStorage();
const upload = multer({ storage });

const streamifier = require("streamifier");
const crypto = require("crypto");
const { sendPushToUsers, sendPushToRoles, sendPushToAllUsers } = require("../services/PushNotify");

router.put("/upload/:id", verifyToken, upload.single("file"), async (req, res) => {
  try {
    const capitalize = (str = "") => str.charAt(0).toUpperCase() + str.slice(1);

    const file = req.file;
    const eventId = req.params.id;
    const type = req.body.type;
    const fileType = file.mimetype;

    // ✅ งานที่ปิดแล้ว (ดำเนินการเสร็จสิ้น) ห้ามช่างแก้ไขไฟล์อีก มีแค่ admin/manager เท่านั้นที่ทำได้
    const eventForLock = await CalendarEvent.findById(eventId);
    if (!eventForLock) {
      return res.status(404).send("ไม่พบแผนงาน");
    }
    const isAdminOrManager = ["admin", "manager"].includes(req.user.role);
    if (eventForLock.status === "ดำเนินการเสร็จสิ้น" && !isAdminOrManager) {
      return res.status(403).send("งานนี้ปิดแล้ว ไม่สามารถแก้ไขไฟล์ได้");
    }

    // ✅ แปลงชื่อไฟล์ให้เป็น UTF-8 และ sanitize
    const originalName = Buffer.from(file.originalname, "latin1").toString(
      "utf8"
    );
    const sanitizedName = originalName.replace(/[^\w\-\.]/g, "_"); // คงนามสกุลไว้
    // ✅ ตรวจสอบประเภทไฟล์ที่รองรับ (สามารถปรับเพิ่มได้ตามต้องการ)
    const allowedTypes = [
      "application/pdf",
      "image/jpeg",
      "image/png",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.ms-excel",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "text/plain",
      "application/zip",
      "application/x-rar-compressed",
    ];

    if (!allowedTypes.includes(fileType)) {
      return res.status(400).json({ error: "Unsupported file type" });
    }

    const uploadToCloudinary = () =>
      new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          {
            resource_type: "raw",
            folder: `events/${eventId}`,
            // ✅ resource_type "raw" ไม่ต่อนามสกุลให้อัตโนมัติเหมือน image/video
            // ต้องฝังนามสกุลไว้ใน public_id เองเสมอ ไม่งั้น secure_url จะไม่มีนามสกุล
            public_id: sanitizedName,
            use_filename: false,
            unique_filename: false,
            overwrite: true,
          },
          (error, result) => {
            if (error) reject(error);
            else resolve(result);
          }
        );
        streamifier.createReadStream(file.buffer).pipe(stream);
      });

    const result = await uploadToCloudinary();

    // ✅ เอกสารแต่ละชนิดเก็บเป็น array แนบได้หลายไฟล์ — push ไฟล์ใหม่เข้าไปแทนการทับของเดิม
    const arrField = `${type}Files`;
    const newFileEntry = {
      fileName: originalName,
      fileUrl: result.secure_url,
      fileType: fileType,
      uploadedAt: new Date(),
    };

    const setFields = {
      [`documentSent${capitalize(type)}`]: true,
    };
    // ถ้ามีไฟล์แนบจริง แปลว่าเอกสารนี้ "มี" แน่นอน ไม่ว่าจะเคยติ๊ก "ไม่มี" ไว้ก่อนหรือไม่
    if (["quotation", "invoice", "completion"].includes(type)) {
      setFields[`${type}Applicable`] = true;
    }

    const updatedEvent = await CalendarEvent.findByIdAndUpdate(
      eventId,
      { $push: { [arrField]: newFileEntry }, $set: setFields },
      { new: true }
    );

    const savedFiles = updatedEvent[arrField] || [];
    const savedFile = savedFiles[savedFiles.length - 1];

    res.status(200).json({
      fileId: savedFile._id,
      fileName: savedFile.fileName,
      fileUrl: savedFile.fileUrl,
      fileType: savedFile.fileType,
    });
  } catch (err) {
    console.error("Upload error:", err);
    res.status(500).send("Upload failed");
  }
});

router.put("/delete-file/:id", verifyToken, async (req, res) => {
  try {
    const capitalize = (str = "") => str.charAt(0).toUpperCase() + str.slice(1);

    const { id } = req.params;
    const { type, fileId } = req.body;
    const arrField = `${type}Files`;

    // ✅ งานที่ปิดแล้ว (ดำเนินการเสร็จสิ้น) ห้ามช่างลบไฟล์อีก มีแค่ admin/manager เท่านั้นที่ทำได้
    const eventForLock = await CalendarEvent.findById(id);
    if (!eventForLock) {
      return res.status(404).send("ไม่พบแผนงาน");
    }
    const isAdminOrManager = ["admin", "manager"].includes(req.user.role);
    if (eventForLock.status === "ดำเนินการเสร็จสิ้น" && !isAdminOrManager) {
      return res.status(403).send("งานนี้ปิดแล้ว ไม่สามารถลบไฟล์ได้");
    }

    // ✅ ลบไฟล์เดียวออกจาก array ตาม _id ของไฟล์นั้น ไม่กระทบไฟล์อื่นในชนิดเดียวกัน
    const updatedEvent = await CalendarEvent.findByIdAndUpdate(
      id,
      { $pull: { [arrField]: { _id: fileId } } },
      { new: true }
    );

    if (!updatedEvent) {
      return res.status(404).send("ไม่พบแผนงาน");
    }

    const remaining = updatedEvent[arrField]?.length || 0;
    await CalendarEvent.updateOne(
      { _id: id },
      { $set: { [`documentSent${capitalize(type)}`]: remaining > 0 } }
    );

    res.status(200).send("ไฟล์ถูกลบแล้ว");
  } catch (err) {
    console.error("ลบไฟล์ไม่สำเร็จ:", err);
    res.status(500).send("เกิดข้อผิดพลาดในการลบไฟล์");
  }
});

router.post("/", verifyToken, async (req, res) => {
  try {
    const allowedFields = [
      "docNo",
      "company",
      "site",
      "title",
      "system",
      "time",
      "team",
      "date",
      "backgroundColor",
      "textColor",
      "fontSize",
      "start",
      "end",
      "allDay",
      "status",
      "status_two",
      "status_three",
      "isAutoUpdated",
      "subject",
      "description",
      "startTime",
      "endTime",
      "documentSent",
      "documentFile",
      "resPerson",
    ];

    // ✅ รองรับสร้างงานที่ต้องเข้าหลายวันแบบไม่ติดกันในครั้งเดียว: ส่ง dates เป็น array ของ
    // { start, end, date } มาแทน start/end/date เดี่ยว — ทุก record ที่สร้างจะผูกกันด้วย
    // jobGroupId เดียวกัน เพื่อให้หน้า Operation รู้ว่าเป็น "งานเดียวกัน" ไม่ใช่งานแยกกันคนละชิ้น
    //
    // ⚠️ ต้องผูก jobGroupId เฉพาะตอนสร้างมากกว่า 1 ช่วงจริงๆ หรือมี jobGroupId ส่งมาจาก client
    // อยู่แล้ว (เช่น เพิ่มวันที่เข้าไปในงานที่เป็นกลุ่มอยู่ก่อนแล้ว) — เดิมสุ่ม jobGroupId ให้
    // "ทุก" งานที่สร้างใหม่แม้จะเป็นงานเดี่ยวธรรมดา ทำให้หน้า Operation เข้าใจผิดว่างานเดี่ยว
    // เป็นส่วนหนึ่งของงานหลายวัน (ขึ้นสัญลักษณ์ 🔗 ทั้งที่จริงมีวันเดียว)
    const { dates } = req.body;
    const isMultiDate = Array.isArray(dates) && dates.length > 1;
    const jobGroupId = isMultiDate ? (req.body.jobGroupId || crypto.randomUUID()) : req.body.jobGroupId;

    const buildEventData = (dateOverride) => {
      const eventData = {};
      allowedFields.forEach((field) => {
        if (req.body[field] !== undefined) {
          eventData[field] = req.body[field];
        }
      });
      if (dateOverride) {
        eventData.start = dateOverride.start;
        eventData.end = dateOverride.end;
        eventData.date = dateOverride.date;
      }
      if (jobGroupId) eventData.jobGroupId = jobGroupId;
      eventData.userId = req.userId || req.body.userId;
      return eventData;
    };

    let events;
    if (Array.isArray(dates) && dates.length > 0) {
      events = await Promise.all(
        dates.map((d) => new CalendarEvent(buildEventData(d)).save())
      );
    } else {
      events = [await new CalendarEvent(buildEventData()).save()];
    }

    // ✅ แจ้งเตือนตอนเพิ่มงานใหม่ (ไม่ await เพื่อไม่ให้ response ช้าลง) — อ้างอิงจาก record แรก
    // เป็นตัวแทนของทั้งชุด (ข้อมูลบริษัท/ไซต์/ผู้รับผิดชอบเหมือนกันทุก record อยู่แล้ว)
    // - ถ้ามอบหมายไว้ (resPerson) ส่งข้อความเจาะจงถึงคนนั้นโดยตรง
    // - คนอื่นๆ ในระบบ (ยกเว้นคนสร้างเองและคนที่ได้รับมอบหมายซึ่งได้ข้อความเจาะจงไปแล้ว) ได้รับแจ้งว่ามีงานใหม่เข้าระบบ
    const primary = events[0];
    const daysSuffix = events.length > 1 ? ` (${events.length} วัน)` : "";
    const jobLabelNew = `${primary.title || "งาน"} · ${primary.company || "-"}${primary.site ? " - " + primary.site : ""}${daysSuffix}`;
    // ✅ งานเดี่ยวไม่มี jobGroupId แล้ว (ดูคอมเมนต์ด้านบน) ใช้ _id ของตัวเองแทนกัน tag ชนกัน
    // ระหว่างงานเดี่ยวหลายๆ งาน (ซึ่งจะทำให้ browser แจ้งเตือนทับ/แทนที่กันเองผิดๆ)
    const notifyTag = `event-${jobGroupId || primary._id}`;

    if (primary.resPerson && primary.resPerson !== req.userId) {
      sendPushToUsers(primary.resPerson, {
        title: "📋 คุณได้รับมอบหมายงานใหม่",
        body: jobLabelNew,
        url: `/operation/${primary._id}`,
        tag: notifyTag,
        renotify: true,
      }).catch((err) => console.error("❌ Push notify error (assign):", err));
    }

    sendPushToAllUsers(
      {
        title: "🆕 มีงานใหม่ถูกเพิ่มเข้าระบบ",
        body: jobLabelNew,
        url: `/operation/${primary._id}`,
        tag: notifyTag,
        renotify: true,
      },
      [req.userId, primary.resPerson]
    ).catch((err) => console.error("❌ Push notify error (new-event-broadcast):", err));

    res.status(201).json({ events });
  } catch (error) {
    console.error(error);
    res.status(500).send("Internal Server Error");
  }
});

router.get("/event-op", verifyToken, async (req, res) => {
  try {
    const userId = req.userId; // ดึง userId จาก Token
    const userRole = req.user.role; // ดึง role ของ User

    // ✅ จับคู่ด้วย resPerson (ID จริง จาก event ที่สร้าง/แก้ไขใหม่),
    // team (fallback ด้วยชื่อ สำหรับ event เก่าที่มอบหมายไว้ก่อนหน้านี้ ยังไม่มี resPerson),
    // หรือ userId (คนที่เพิ่ม event นี้เอง แม้จะไม่ได้ตั้ง resPerson/team ไว้เลยก็ตาม)
    const query = userRole === "admin"
      ? {}
      : { $or: [{ resPerson: userId }, { team: req.user.fname }, { userId: userId }] };

    const userEvents = await CalendarEvent.find(query)
      .sort({ start: -1 })
      .lean();

    const userIds = userEvents.map((event) => event.userId.toString());
    const uniqueUserIds = [...new Set(userIds)];

    const users = await User.find({ _id: { $in: uniqueUserIds } }).lean();

    const userMap = new Map();
    users.forEach((user) => {
      userMap.set(user._id.toString(), user);
    });

    const updatedUserEvents = userEvents.map((event) => {
      const user = userMap.get(event.userId.toString());
      if (user) {
        const { _id, password, ...userDataWithoutId } = user;
        return { ...event, user: userDataWithoutId };
      }
      return event;
    });

    if (!userEvents.length) {
      return res.status(404).json({ message: "ไม่พบข้อมูลปฏิทิน" });
    }

    res.json({ userEvents: updatedUserEvents });
  } catch (err) {
    console.error("❌ Error fetching calendar events:", err);
    res.status(500).send("เกิดข้อผิดพลาดในการดึงข้อมูลปฏิทิน");
  }
});

// ✅ รวมไฟล์เอกสารประจำงาน (Service Report/ใบเสนอราคา/ใบวางบิล/ใบส่งมอบงาน) จากทุก event
// ให้แบนราบเป็นรายการเดียว สำหรับหน้า Files แสดงเป็นตาราง แยกจากไฟล์ทั่วไป (model File เดิม)
// ต้องอยู่ก่อน "/:id" ไม่งั้น Express จะจับ "documents" เป็นค่า :id แทน
router.get("/documents", verifyToken, async (req, res) => {
  try {
    const userId = req.userId;
    const userRole = req.user.role;

    const isAdminOrManager = ["admin", "manager"].includes(userRole);
    const query = isAdminOrManager
      ? {}
      : { $or: [{ resPerson: userId }, { team: req.user.fname }, { userId: userId }] };

    const events = await CalendarEvent.find(query)
      .select("docNo company site title system team status reportFiles quotationFiles invoiceFiles completionFiles")
      .sort({ updatedAt: -1 })
      .lean();

    const DOC_TYPE_LABELS = {
      report: "Service Report",
      quotation: "ใบเสนอราคา",
      invoice: "ใบวางบิล",
      completion: "ใบส่งมอบงาน",
    };

    const files = [];
    for (const ev of events) {
      for (const type of ["report", "quotation", "invoice", "completion"]) {
        const arr = ev[`${type}Files`] || [];
        for (const f of arr) {
          files.push({
            fileId: f._id,
            fileName: f.fileName,
            fileUrl: f.fileUrl,
            fileType: f.fileType,
            uploadedAt: f.uploadedAt,
            docType: type,
            docTypeLabel: DOC_TYPE_LABELS[type],
            eventId: ev._id,
            docNo: ev.docNo || "",
            company: ev.company || "",
            site: ev.site || "",
            title: ev.title || "",
            system: ev.system || "",
            team: ev.team || "",
            status: ev.status || "",
          });
        }
      }
    }

    files.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));

    res.json({ files });
  } catch (err) {
    console.error("❌ Error fetching event documents:", err);
    res.status(500).json({ message: "เกิดข้อผิดพลาดในการดึงข้อมูลเอกสารประจำงาน" });
  }
});

router.get("/", verifyToken, async (req, res) => {
  try {
    const userId = req.userId; // ดึง userId จาก Token
    const userRole = req.user.role; // ดึง role ของ User

    // let userEvents;

    // ✅ เงื่อนไข: ถ้าเป็น admin ให้ดึง event ทั้งหมด
    // if (userRole === "admin") {
    //   userEvents = await CalendarEvent.find({});
    // } else {
    //   // ✅ ถ้าเป็น user ทั่วไป ให้ดึงเฉพาะ event ของตัวเอง
    //   userEvents = await CalendarEvent.find({ userId: userId });
    // }
    // userEvents = await CalendarEvent.find({});

    // // ดึง userId ทั้งหมดจาก userEvents
    // const userIds = userEvents.map((event) => event.userId);

    // // ค้นหาข้อมูลผู้ใช้จาก model User โดยใช้ userIds
    // const users = await User.find({ _id: { $in: userIds } });

    // // แปลงค่า userId ใน userEvents เป็น role จากข้อมูลใน users
    // const updatedUserEvents = userEvents.map((event) => {
    //   const user = users.find(
    //     (user) => user._id.toString() === event.userId.toString()
    //   );
    //   if (user) {
    //     // คัดลอกค่าทั้งหมดของผู้ใช้ยกเว้น _id
    //     const { _id, ...userDataWithoutId } = user.toObject();
    //     return { ...event._doc, user: userDataWithoutId }; // เพิ่ม property user ที่มีค่าข้อมูลผู้ใช้ยกเว้น _id
    //   } else {
    //     return event; // ถ้าไม่พบ user ให้ใช้ค่าเดิมของ event
    //   }
    // });

    const userEvents = await CalendarEvent.find({}).lean();

    const userIds = userEvents.map((event) => event.userId.toString());
    const uniqueUserIds = [...new Set(userIds)];

    const users = await User.find({ _id: { $in: uniqueUserIds } }).lean();

    const userMap = new Map();
    users.forEach((user) => {
      userMap.set(user._id.toString(), user);
    });

    const updatedUserEvents = userEvents.map((event) => {
      const user = userMap.get(event.userId.toString());
      if (user) {
        const { _id, password, ...userDataWithoutId } = user;
        return { ...event, user: userDataWithoutId };
      }
      return event;
    });

    // ถ้าไม่มีข้อมูล
    if (!userEvents.length) {
      return res.status(404).json({ message: "ไม่พบข้อมูลปฏิทิน" });
    }

    res.json({ userEvents: updatedUserEvents });
  } catch (err) {
    console.error("❌ Error fetching calendar events:", err);
    res.status(500).send("เกิดข้อผิดพลาดในการดึงข้อมูลปฏิทิน");
  }
});

router.get("/:id", verifyToken, async (req, res) => {
  try {
    const { id } = req.params;

    const event = await CalendarEvent.findById(id);

    if (!event) {
      return res.status(404).json({ message: "ไม่พบแผนงานที่ต้องการ" });
    }

    // ดึงข้อมูล user ที่สร้างแผนงานนี้ (ถ้ามี)
    const user = await User.findById(event.userId).select("-password"); // ตัด password ออก

    res.status(200).json({ event: { ...event._doc, user } });
  } catch (error) {
    console.error("❌ Error fetching event by ID:", error);
    res.status(500).json({ message: "เกิดข้อผิดพลาดในการดึงข้อมูลแผนงาน" });
  }
});

router.put("/:id", verifyToken, async (req, res) => {
  try {
    const id = req.params.id;
    const userId = req.userId;

    const existingEvent = await CalendarEvent.findById(id);
    if (!existingEvent) {
      return res.status(404).json({ message: "Event not found" });
    }

    // ✅ เงื่อนไข: admin แก้ไขได้ทุก event, ส่วนคนอื่นแก้ไขได้เฉพาะ event ที่ตัวเองเพิ่ม
    // หรือ event ที่ได้รับมอบหมาย (resPerson ตรงกับ ID ตัวเอง หรือ team ตรงกับชื่อตัวเอง — เผื่อ event เก่า)
    const isOwner = existingEvent.userId.toString() === userId.toString();
    const isAssigned =
      (existingEvent.resPerson && existingEvent.resPerson === userId) ||
      (existingEvent.team && existingEvent.team === req.user.fname);

    if (req.user.role !== "admin" && !isOwner && !isAssigned) {
      return res.status(403).json({ message: "คุณไม่มีสิทธิ์แก้ไข Event นี้" });
    }

    // ✅ งานที่ปิดแล้ว (ดำเนินการเสร็จสิ้น) ห้ามช่างแก้ไขอีก มีแค่ admin/manager เท่านั้นที่ทำได้
    // ยกเว้น: ถ้าเป็นการส่ง comment อย่างเดียว (คุยโต้ตอบกัน) ให้ทำได้แม้งานจะปิดไปแล้ว
    // เพราะไม่ได้กระทบข้อมูลงานจริง แค่เพิ่มข้อความคุยกัน
    const isAdminOrManager = ["admin", "manager"].includes(req.user.role);
    const isCommentOnlyUpdate = Object.keys(req.body).every((k) => k === "comments");
    if (existingEvent.status === "ดำเนินการเสร็จสิ้น" && !isAdminOrManager && !isCommentOnlyUpdate) {
      return res.status(403).json({ message: "งานนี้ปิดแล้ว ไม่สามารถแก้ไขได้" });
    }

    const {
      docNo,
      company,
      site,
      title,
      system,
      time,
      team,
      date,
      backgroundColor,
      textColor,
      fontSize,
      start,
      end,
      allDay,
      status,
      status_two,
      status_three,
      isAutoUpdated,
      manualStatus,
      subject,
      description,
      startTime,
      endTime,
      documentSentQuotation,
      documentSentReport,
      documentSentInvoice,
      documentSentCompletion,
      quotationApplicable,
      invoiceApplicable,
      completionApplicable,
      documentSent,
      documentFile, // ✅ เพิ่มตรงนี้
      resPerson, // ✅ เพิ่มตรงนี้

      // ✅ ฟิลด์สำหรับ flow ของช่าง (เช็คอิน/เช็คเอาท์/สรุปงาน/ประวัติกิจกรรม)
      // และ flow ขอปิดงาน → รออนุมัติจากแอดมิน (เดิมไม่ได้ whitelist ไว้ ทำให้ไม่เคยถูกบันทึกจริง)
      checkedInAt,
      checkedOutAt,
      workNote,
      activityLog,
      closeRequested,
      closeRequestedAt,
      closeRequestedBy,
      closeRequestedByUserId,
      closeApprovedAt,
      closeApprovedBy,
      closeRejectedAt,
      closeRejectedBy,
      closeRejectReason,
      comments,
      jobGroupId, // ✅ ใช้ตอนแก้ไข event เดี่ยวแล้วเพิ่มวันที่อื่นให้กลายเป็นงานเดียวกันภายหลัง
    } = req.body;

    const newEvent = {
      docNo,
      company,
      site,
      title,
      system,
      time,
      team,
      date,
      backgroundColor,
      textColor,
      fontSize,
      start,
      end,
      allDay,
      status,
      status_two,
      status_three,
      isAutoUpdated,
      manualStatus,
      subject,
      description,
      startTime,
      endTime,
      documentSentQuotation,
      documentSentReport,
      documentSentInvoice,
      documentSentCompletion,
      quotationApplicable,
      invoiceApplicable,
      completionApplicable,
      documentSent,
      documentFile, // ✅ เพิ่มตรงนี้
      resPerson, // ✅ เพิ่มตรงนี้

      checkedInAt,
      checkedOutAt,
      workNote,
      activityLog,
      closeRequested,
      closeRequestedAt,
      closeRequestedBy,
      closeRequestedByUserId,
      closeApprovedAt,
      closeApprovedBy,
      closeRejectedAt,
      closeRejectedBy,
      closeRejectReason,
      comments,
      jobGroupId,

      userId: existingEvent.userId, // ❌ ไม่เปลี่ยนเจ้าของเดิม
      // lastModifiedBy: req.userId, // ✅ บันทึกคนที่แก้ไขล่าสุด
    };

    // ✅ สิทธิ์ตรวจสอบไปแล้วด้านบน (isOwner / isAssigned / admin) จึงใช้แค่ _id พอ
    const updatedEvent = await CalendarEvent.findOneAndUpdate({ _id: id }, newEvent, {
      new: true,
    }).exec();

    if (!updatedEvent) {
      return res.status(404).json("Event not found");
    }

    // ✅ แจ้งเตือนตามการเปลี่ยนแปลงสำคัญ (ไม่ await เพื่อไม่ให้ response ช้าลง)
    // เทียบค่าก่อน (existingEvent) กับค่าที่ส่งมาใหม่ เพื่อดูว่า "เพิ่งเกิดการเปลี่ยนแปลง" จริงๆ ไม่ใช่แค่ค่าเดิม
    const jobLabel = `${updatedEvent.company || "-"}${updatedEvent.site ? " - " + updatedEvent.site : ""}`;

    const notifyTag = `event-${updatedEvent._id}`;

    if (resPerson && resPerson !== existingEvent.resPerson && resPerson !== userId) {
      sendPushToUsers(resPerson, {
        title: "📋 คุณได้รับมอบหมายงาน",
        body: `${updatedEvent.title || "งาน"} · ${jobLabel}`,
        url: `/operation/${updatedEvent._id}`,
        tag: notifyTag,
        renotify: true,
      }).catch((err) => console.error("❌ Push notify error (reassign):", err));
    }

    if (closeRequested === true && !existingEvent.closeRequested) {
      sendPushToRoles(["admin", "manager"], {
        title: "⏳ มีคำขอปิดงานใหม่",
        body: `${closeRequestedBy || "ช่าง"} ขอปิดงาน: ${jobLabel}`,
        url: `/operation/${updatedEvent._id}`,
        tag: notifyTag,
        renotify: true,
      }).catch((err) => console.error("❌ Push notify error (close-requested):", err));
    }

    // ✅ ใช้ closeRequestedByUserId (userId จริงของคนกดขอปิดงาน) เป็นหลัก เพราะ resPerson/userId
    // ของ event อาจไม่ตรงกับคนที่กดขอปิดงานจริง (เช่น มอบหมายผ่านชื่อทีมแบบเก่า ไม่มี resPerson)
    // ถ้าไม่มี (event เก่าก่อนมีฟิลด์นี้) ค่อย fallback ไปที่ resPerson/userId ของ event ตามเดิม
    const closeRequesterId = updatedEvent.closeRequestedByUserId || updatedEvent.resPerson || updatedEvent.userId;

    // ⚠️ เดิมเช็คแค่ "!existingEvent.closeApprovedAt / closeRejectedAt" ซึ่งตรวจจับได้แค่ครั้งแรกที่ set
    // เท่านั้น ถ้างานเดิมเคยถูกอนุมัติ/ไม่อนุมัติมาก่อนแล้ว (เช่น ขอปิดงานใหม่แล้วโดนปฏิเสธซ้ำ)
    // ค่าเก่าที่ไม่ใช่ null จะทำให้เงื่อนไขเป็นเท็จเสมอ แจ้งเตือนซ้ำจึงไม่ถูกส่งอีกเลย
    // แก้เป็นเทียบเวลาว่า "เพิ่งเปลี่ยนเป็นค่าใหม่จริงๆ" แทน
    const isNewTimestamp = (incoming, previous) =>
      incoming && new Date(incoming).getTime() !== new Date(previous || 0).getTime();

    if (isNewTimestamp(closeApprovedAt, existingEvent.closeApprovedAt)) {
      sendPushToUsers([closeRequesterId, updatedEvent.resPerson, updatedEvent.userId], {
        title: "✅ แอดมินอนุมัติปิดงานแล้ว",
        body: jobLabel,
        url: `/operation/${updatedEvent._id}`,
        tag: notifyTag,
        renotify: true,
      }).catch((err) => console.error("❌ Push notify error (approved):", err));
    }

    if (isNewTimestamp(closeRejectedAt, existingEvent.closeRejectedAt)) {
      sendPushToUsers([closeRequesterId, updatedEvent.resPerson, updatedEvent.userId], {
        title: "❌ แอดมินไม่อนุมัติปิดงาน",
        body: closeRejectReason ? `${jobLabel}: ${closeRejectReason}` : jobLabel,
        tag: notifyTag,
        renotify: true,
        url: `/operation/${updatedEvent._id}`,
      }).catch((err) => console.error("❌ Push notify error (rejected):", err));
    }

    // ✅ แจ้งเตือนเมื่อมีข้อความคอมเมนต์ใหม่ — comments ถูกส่งมาทั้งชุดเสมอ (เหมือน activityLog)
    // จึงเทียบจำนวนข้อความเดิม/ใหม่แทนการเช็ค timestamp เดี่ยวๆ
    if (Array.isArray(comments) && comments.length > (existingEvent.comments || []).length) {
      const lastComment = comments[comments.length - 1];
      if (lastComment) {
        const isFromAdmin = ["admin", "manager"].includes(lastComment.role);
        const notifyPromise = isFromAdmin
          ? sendPushToUsers([closeRequesterId, updatedEvent.resPerson, updatedEvent.userId], {
              title: `💬 ${lastComment.userName || "แอดมิน"} ตอบกลับ`,
              body: `${jobLabel}: ${lastComment.message}`,
              url: `/operation/${updatedEvent._id}`,
              tag: notifyTag,
              renotify: true,
            })
          : sendPushToRoles(["admin", "manager"], {
              title: `💬 ${lastComment.userName || "ช่าง"} คอมเมนต์ใหม่`,
              body: `${jobLabel}: ${lastComment.message}`,
              url: `/operation/${updatedEvent._id}`,
              tag: notifyTag,
              renotify: true,
            });
        notifyPromise.catch((err) => console.error("❌ Push notify error (comment):", err));
      }
    }

    res.status(200).json({ updatedEvent: updatedEvent }); // ส่งข้อมูลของเหตุการณ์ที่ถูกอัปเดตกลับไป
  } catch (err) {
    res.status(500).json(err.message);
  }
});

router.delete("/:id", verifyToken, async (req, res) => {
  try {
  const id = req.params.id;
    const userId = req.userId;

    const existingEvent = await CalendarEvent.findById(id);
    if (!existingEvent) {
      return res.status(404).json({ message: "Event not found" });
    }

    // ✅ เงื่อนไข: admin แก้ไขได้ทุก event, user แก้ไขได้เฉพาะของตัวเอง
    if (
      req.user.role !== "admin" &&
      existingEvent.userId.toString() !== userId.toString()
    ) {
      return res.status(403).json({ message: "คุณไม่มีสิทธิ์ลบ Event นี้" });
    }

    // ✅ งานที่ปิดแล้ว (ดำเนินการเสร็จสิ้น) ห้ามช่างลบอีก มีแค่ admin/manager เท่านั้นที่ทำได้
    const isAdminOrManager = ["admin", "manager"].includes(req.user.role);
    if (existingEvent.status === "ดำเนินการเสร็จสิ้น" && !isAdminOrManager) {
      return res.status(403).json({ message: "งานนี้ปิดแล้ว ไม่สามารถลบได้" });
    }

    // Delete file from database
    await CalendarEvent.findByIdAndDelete(id);

    res.status(200).send("Event deleted successfully");
  } catch (err) {
    console.error("Error deleting Event:", err);
    res.status(500).send(err.message);
  }
});

module.exports = router;
