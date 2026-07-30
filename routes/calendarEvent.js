const express = require("express");
const router = express.Router();

const moment = require("moment");
require("moment/locale/th");

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
const { findResPersonConflicts, findMutualOverlaps } = require("../utils/scheduleConflict");

// ✅ ห้ามมี 2 งานใช้ "ครั้งที่" (time) ซ้ำกันภายในสัญญาเดียวกัน (contractGroupId เดียวกัน) — ไม่ว่าจะเป็น
// แผนงานล่วงหน้า (unscheduled) หรือลงตารางจริงแล้วก็ตาม เพราะทั้งสองแบบ "จอง" หมายเลขครั้งนั้นไปแล้ว
// excludeId ใช้ตอนแปลง draft เดิมเป็นงานจริง (PUT /:id/schedule) เพื่อไม่ให้ชนกับตัวมันเอง
async function findDuplicateContractRound(contractGroupId, time, excludeId) {
  if (!contractGroupId || time === undefined || time === null || time === "") return null;
  const query = { contractGroupId, time: String(time) };
  if (excludeId) query._id = { $ne: excludeId };
  return CalendarEvent.findOne(query);
}

// ✅ ห้ามเลขที่สัญญาซ้ำกันข้ามสัญญา — เอกสารทุกครั้งที่ (visit) ในสัญญาเดียวกันมี contractNo เดียวกัน
// อยู่แล้วโดยตั้งใจ (นับเป็นสัญญาเดียว ไม่ใช่ซ้ำ) ต้องกันเฉพาะกรณีเลขที่นี้ไปโผล่ที่ contractGroupId
// อื่นเท่านั้นถึงจะถือว่าซ้ำจริง — excludeContractGroupId ไม่ใส่มาตอนสร้างสัญญาใหม่ทั้งชุด (ยังไม่มี
// contractGroupId ให้ยกเว้น เจอที่ไหนก็ถือว่าซ้ำหมด) ใส่มาตอนแก้ไข/สร้างครั้งถัดไปของสัญญาที่มีอยู่แล้ว
async function findDuplicateContractNo(contractNo, excludeContractGroupId) {
  const trimmed = (contractNo || "").trim();
  if (!trimmed) return null;
  const query = { contractNo: trimmed };
  if (excludeContractGroupId) query.contractGroupId = { $ne: excludeContractGroupId };
  return CalendarEvent.findOne(query).select("contractGroupId contractNo").lean();
}

router.put("/upload/:id", verifyToken, upload.single("file"), async (req, res) => {
  try {
    const capitalize = (str = "") => str.charAt(0).toUpperCase() + str.slice(1);

    const file = req.file;
    const eventId = req.params.id;
    const type = req.body.type;
    const fileType = file.mimetype;

    // ✅ งานที่ปิดแล้ว (ดำเนินการเสร็จสิ้น) ห้ามช่างแก้ไขไฟล์อีก มีแค่ admin/manager เท่านั้นที่ทำได้
    // ยกเว้นไฟล์ใบเสนอราคา — การติดตามใบเสนอราคามักเกิด "หลัง" งานปิดแล้ว (ช่างปิดงานหน้างานก่อน
    // ค่อยตามเรื่องเอกสาร/ใบเสนอราคากับลูกค้าทีหลัง) ถ้าล็อกไว้เหมือนเอกสารชนิดอื่นจะทำให้ช่างแนบ/
    // เปลี่ยนไฟล์ใบเสนอราคาของงานตัวเองไม่ได้เลยทั้งที่เป็นกรณีปกติ (ดู PUT /:id ด้านล่างที่ยกเว้น
    // ให้เหมือนกัน)
    const eventForLock = await CalendarEvent.findById(eventId);
    if (!eventForLock) {
      return res.status(404).send("ไม่พบแผนงาน");
    }
    const isAdminOrManager = ["admin", "manager"].includes(req.user.role);
    if (eventForLock.status === "ดำเนินการเสร็จสิ้น" && !isAdminOrManager && type !== "quotation") {
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

    // ✅ perf: รูปภาพ (jpg/png) อัพโหลดด้วย resource_type "image" แทน "raw" — "raw" เป็น blob ดิบๆ
    // ไม่รองรับ Cloudinary URL transformation (resize/compress) เลย ทำให้ตอนเปิดดูรูปพรีวิวต้องโหลด
    // ไฟล์เต็มความละเอียดต้นฉบับเสมอ (รูปจากมือถือหลาย MB) รู้สึกหน่วง/ค้าง — "image" เปิดให้แปะ query
    // param (f_auto,q_auto,w_...) ตอนแสดงผลได้ ย่อ/บีบอัดแบบ on-the-fly โดยไม่กระทบไฟล์ต้นฉบับที่เก็บไว้
    // (เอกสารอื่น PDF/Word/Excel ไม่ได้ประโยชน์จาก transformation นี้ ใช้ "raw" เหมือนเดิม)
    const isImage = ["image/jpeg", "image/png"].includes(fileType);
    // resource_type "image" ให้ Cloudinary จัดการนามสกุลเองจากเนื้อไฟล์จริง — ต้องตัดนามสกุลออกจาก
    // public_id ก่อน ไม่งั้นจะได้ชื่อไฟล์ซ้อนนามสกุลสองต่อ (เช่น "photo.jpg.jpg")
    const imagePublicId = sanitizedName.replace(/\.[^.]+$/, "");

    const uploadToCloudinary = () =>
      new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          isImage
            ? {
                resource_type: "image",
                folder: `events/${eventId}`,
                public_id: imagePublicId,
                use_filename: false,
                unique_filename: false,
                overwrite: true,
              }
            : {
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
    // ยกเว้นไฟล์ใบเสนอราคา (เทียบเหตุผลเดียวกับ PUT /upload/:id ด้านบน)
    const eventForLock = await CalendarEvent.findById(id);
    if (!eventForLock) {
      return res.status(404).send("ไม่พบแผนงาน");
    }
    const isAdminOrManager = ["admin", "manager"].includes(req.user.role);
    if (eventForLock.status === "ดำเนินการเสร็จสิ้น" && !isAdminOrManager && type !== "quotation") {
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
      "teamMembers",
      "contractNo",
      "quotationNo",
      "contractStart",
      "contractEnd",
      "visitCount",
      "jobValue",
    ];

    // ✅ รองรับสร้างงานที่ต้องเข้าหลายวันแบบไม่ติดกันในครั้งเดียว: ส่ง dates เป็น array ของ
    // { start, end, date } มาแทน start/end/date เดี่ยว — ทุก record ที่สร้างจะผูกกันด้วย
    // jobGroupId เดียวกัน เพื่อให้หน้า Operation รู้ว่าเป็น "งานเดียวกัน" ไม่ใช่งานแยกกันคนละชิ้น
    //
    // ⚠️ ต้องผูก jobGroupId เฉพาะตอนสร้างมากกว่า 1 ช่วงจริงๆ หรือมี jobGroupId ส่งมาจาก client
    // อยู่แล้ว (เช่น เพิ่มวันที่เข้าไปในงานที่เป็นกลุ่มอยู่ก่อนแล้ว) — เดิมสุ่ม jobGroupId ให้
    // "ทุก" งานที่สร้างใหม่แม้จะเป็นงานเดี่ยวธรรมดา ทำให้หน้า Operation เข้าใจผิดว่างานเดี่ยว
    // เป็นส่วนหนึ่งของงานหลายวัน (ขึ้นสัญลักษณ์ 🔗 ทั้งที่จริงมีวันเดียว)
    //
    // ✅ isContractBatch แยกความหมายออกจาก jobGroupId ข้างบน — dates[] ชุดนี้คือ "หลายครั้ง"
    // ของสัญญาเดียวกัน (ครั้งที่ 1, 2, 3...) ไม่ใช่วันไม่ติดกันของครั้งเดียว จึงผูกด้วย contractGroupId
    // คนละตัวแทน ไม่แตะ jobGroupId เดิม (client เดิมที่ไม่ส่ง isContractBatch มา พฤติกรรมเหมือนเดิมทุกอย่าง)
    const { dates, isContractBatch, resPerson } = req.body;
    const isMultiDate = Array.isArray(dates) && dates.length > 1;
    const jobGroupId = (isMultiDate && !isContractBatch) ? (req.body.jobGroupId || crypto.randomUUID()) : req.body.jobGroupId;
    // ✅ สัญญาต้องได้ contractGroupId แม้มีแค่ครั้งเดียวตอนสร้าง (ยังไม่ได้ลงครั้งที่ 2 ทันที) —
    // ต่างจาก jobGroupId ด้านบนที่ต้องมากกว่า 1 ช่วงจริงๆ ถึงจะผูก เพราะสัญญาคือ 1 หน่วยข้อมูล
    // (เลขที่สัญญา/มูลค่างาน ฯลฯ) ตั้งแต่ครั้งแรกอยู่แล้ว ไม่ต้องรอให้มีครั้งที่ 2 ก่อนถึงจะนับเป็นสัญญา
    const hasContractDates = isContractBatch && Array.isArray(dates) && dates.length >= 1;
    const contractGroupId = hasContractDates ? (req.body.contractGroupId || crypto.randomUUID()) : req.body.contractGroupId;

    // ✅ ตรวจสอบช่างชนกัน (double-booking) "ก่อน" เขียนอะไรลงฐานข้อมูลเลยสักตัว — ทั้งชนกันเอง
    // ภายในชุดที่กำลังจะสร้าง (เช่น กรอกวันที่ครั้งที่ 1/3 ทับกันเอง) และชนกับงานอื่นที่มีอยู่แล้วในระบบ
    // กันเคสสร้างไป 2-3 ครั้งสำเร็จแล้วมาพังเอาตอนครั้งที่ 4 (ข้อมูลสัญญาครึ่งๆ กลางๆ)
    const rangesToCheck = (Array.isArray(dates) && dates.length > 0 ? dates : [{ start: req.body.start, end: req.body.end }])
      .filter((d) => d && d.start && d.end);

    if (resPerson && rangesToCheck.length > 0) {
      const mutualConflicts = findMutualOverlaps(rangesToCheck);
      if (mutualConflicts.length > 0) {
        const [a, b] = mutualConflicts[0];
        return res.status(409).json({
          message: `วันที่ที่กรอกทับกันเอง (${moment(a.start).locale("th").format("D MMM YYYY")} กับ ${moment(b.start).locale("th").format("D MMM YYYY")}) กรุณาตรวจสอบวันที่แต่ละครั้งอีกครั้ง`,
        });
      }

      for (const range of rangesToCheck) {
        const conflicts = await findResPersonConflicts({
          resPerson, start: range.start, end: range.end,
          startTime: req.body.startTime, endTime: req.body.endTime,
        });
        if (conflicts.length > 0) {
          const c = conflicts[0];
          return res.status(409).json({
            message: `ช่างคนนี้มีงานชนกันอยู่แล้ว: ${c.title || "งาน"} · ${c.company || "-"}${c.site ? " - " + c.site : ""} วันที่ ${moment(c.start).locale("th").format("D MMM YYYY")}`,
          });
        }
      }
    }

    // ✅ เช็คซ้ำ — กันเผลอเพิ่มครั้งที่ซ้ำกับที่มีอยู่แล้วในสัญญาเดียวกัน (ทั้งที่ลงตารางแล้วและที่เป็นแผนงานล่วงหน้า)
    // ✅ ยกเว้น "ตั้งใจต่อวันที่ไม่ต่อเนื่องให้ครั้งเดิม" — ส่ง jobGroupId มาตรงกับของ record เดิมที่ครองครั้งนี้
    // อยู่แล้ว (ดูหน้าภาพรวมสัญญา ปุ่ม "เพิ่มวันที่ต่อเนื่อง") กรณีนี้ไม่ถือว่าซ้ำ ปล่อยผ่านได้ — ต้องเช็คก่อน
    // เพื่อให้เช็คจำนวนครั้งสูงสุดด้านล่างรู้ด้วยว่าไม่ควรนับเป็นครั้งใหม่
    let isIntentionalExtend = false;
    if (req.body.contractGroupId && req.body.time) {
      const dupRound = await findDuplicateContractRound(req.body.contractGroupId, req.body.time);
      if (dupRound) {
        isIntentionalExtend = Boolean(req.body.jobGroupId) && String(dupRound.jobGroupId || "") === String(req.body.jobGroupId);
        if (!isIntentionalExtend) {
          return res.status(409).json({
            message: `ครั้งที่ ${req.body.time} ของสัญญานี้ถูกใช้ไปแล้ว กรุณาตรวจสอบ`,
          });
        }
      }
    }

    // ✅ ห้ามเพิ่มครั้งเกินจำนวนที่สัญญากำหนดไว้ (visitCount) — เช็คเฉพาะตอน client ระบุ contractGroupId
    // ของสัญญาที่มีอยู่แล้วมาเอง (เช่นกดปุ่ม "เพิ่มครั้งถัดไป" ในหน้าภาพรวมสัญญา) ไม่กระทบตอนสร้าง
    // สัญญาใหม่ทั้งชุด (contractGroupId ยังไม่มีตอนนั้น เพิ่งถูกสุ่มด้านบน) และไม่กระทบตอนต่อวันที่ไม่
    // ต่อเนื่องให้ครั้งเดิม (isIntentionalExtend) เพราะไม่ได้กินโควตาครั้งใหม่เพิ่ม
    if (req.body.contractGroupId && Number(req.body.visitCount) > 0 && rangesToCheck.length > 0 && !isIntentionalExtend) {
      const visitCount = Number(req.body.visitCount);
      const existingCount = await CalendarEvent.countDocuments({ contractGroupId: req.body.contractGroupId });
      if (existingCount + rangesToCheck.length > visitCount) {
        return res.status(409).json({
          message: `สัญญานี้กำหนดไว้ ${visitCount} ครั้ง ตอนนี้มี ${existingCount} ครั้งแล้ว ไม่สามารถเพิ่มอีก ${rangesToCheck.length} ครั้งได้`,
        });
      }
    }

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
        if (dateOverride.time !== undefined) eventData.time = dateOverride.time;
      }
      if (jobGroupId) eventData.jobGroupId = jobGroupId;
      if (contractGroupId) eventData.contractGroupId = contractGroupId;
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
    // ✅ เดิมแจ้งแค่ชื่องาน/บริษัท/ไซต์ ไม่มีวันเวลาเลย ต้องเปิดแอพเข้าไปดูเองถึงจะรู้ว่างานนัดไว้เมื่อไหร่
    // — ใส่วันที่ + ช่วงเวลาไว้ในเนื้อหาแจ้งเตือนเลย ให้เห็นครบตั้งแต่หน้าจอแจ้งเตือนจริง
    const dateLabel = moment(primary.start || primary.date).locale("th").format("D MMM YYYY");
    const timeLabel = (primary.startTime || primary.endTime)
      ? `${primary.startTime || "-"}-${primary.endTime || "-"}`
      : "ทั้งวัน";
    const jobLabelNew = `📅 ${dateLabel} 🕐 ${timeLabel} · ${primary.title || "งาน"} · ${primary.company || "-"}${primary.site ? " - " + primary.site : ""}${daysSuffix}`;
    // ✅ งานเดี่ยวไม่มี jobGroupId แล้ว (ดูคอมเมนต์ด้านบน) ใช้ _id ของตัวเองแทนกัน tag ชนกัน
    // ระหว่างงานเดี่ยวหลายๆ งาน (ซึ่งจะทำให้ browser แจ้งเตือนทับ/แทนที่กันเองผิดๆ)
    const notifyTag = `event-${jobGroupId || primary._id}`;
    // ✅ เดิมแจ้งแค่ "มีงานใหม่เข้าระบบ" เฉยๆ ไม่รู้ว่าใครเป็นคนเพิ่ม ต้องเปิดแอพเข้าไปดูเอง
    // — verifyToken แนบ req.user (fname/lname) มาให้อยู่แล้ว ใส่ชื่อคนเพิ่มไว้ในหัวข้อแจ้งเตือนเลย
    const creatorName = [req.user?.fname, req.user?.lname].filter(Boolean).join(" ") || req.user?.username || "ผู้ดูแลระบบ";

    if (primary.resPerson && primary.resPerson !== req.userId) {
      sendPushToUsers(primary.resPerson, {
        title: `📋 ${creatorName} มอบหมายงานใหม่ให้คุณ`,
        body: jobLabelNew,
        url: `/operation/${primary._id}`,
        tag: notifyTag,
        renotify: true,
      }).catch((err) => console.error("❌ Push notify error (assign):", err));
    }

    sendPushToAllUsers(
      {
        title: `🆕 ${creatorName} เพิ่มงานใหม่เข้าระบบ`,
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
    // ✅ ตัดงาน "วางแผนล่วงหน้า" (unscheduled) ออกเสมอ — ยังไม่มีวันที่จริง ไม่ควรปนกับงานที่ลงตารางแล้ว
    const query = userRole === "admin"
      ? { unscheduled: { $ne: true } }
      : { unscheduled: { $ne: true }, $or: [{ resPerson: userId }, { team: req.user.fname }, { userId: userId }] };

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

// ✅ งาน "วางแผนล่วงหน้า" (unscheduled) — บันทึกไว้ก่อนว่ามีงานนี้แน่ๆ ในเดือนไหน แต่ยังไม่รู้วันที่
// เจาะจง จัดกลุ่มแสดงตาม plannedMonth แล้วค่อยลาก/กดลงตารางจริงทีหลัง (ดู PUT /:id/schedule)
// ต้องอยู่ก่อน "/:id" ไม่งั้น Express จะจับ "draft"/"drafts" เป็นค่า :id แทน
router.post("/draft", verifyToken, async (req, res) => {
  try {
    const {
      company, site, title, system, time, team, resPerson, plannedMonth,
      backgroundColor, textColor, fontSize, description,
      // ✅ สัญญาแบบยังไม่มีวันที่เข้างานเลย ("ฉบับร่าง") — เก็บเป็น draft เดียวที่มีข้อมูลสัญญาครบ
      // แต่ยังไม่มี date/start/end/time จนกว่าจะกด "+ เพิ่มครั้งถัดไป" แปลงเป็นครั้งที่ 1 จริง
      // (ดู PUT /:id/schedule) — ไม่ต้องสร้าง event ที่มีวันที่ปลอมๆ ขึ้นมาแค่เพื่อให้มี record
      // ✅ contractGroupId: รับจาก client ได้ด้วย (ใช้ตอนวางแผนล่วงหน้าครั้งถัดไปของ "สัญญาที่มีอยู่แล้ว"
      // จากหน้าแผนงานล่วงหน้า) ถ้าไม่ส่งมาค่อยสุ่มใหม่ (กรณีสร้างสัญญาใหม่ทั้งชุดจากหน้าภาพรวมสัญญา)
      isContractBatch, contractGroupId, contractNo, quotationNo, contractStart, contractEnd, visitCount, jobValue,
    } = req.body;

    if (!site || !title || !system) {
      return res.status(400).json({ message: "กรุณาระบุชื่อโครงการ/ประเภทงาน/ระบบงาน" });
    }

    // ✅ แผนงานทั่วไปให้ผู้ใช้ระบุ plannedMonth เองเสมอ แต่สัญญาฉบับร่างไม่มีช่องนี้ในฟอร์ม —
    // อนุมานให้จากวันที่เริ่มสัญญา (ถ้ามี) ไม่งั้นใช้เดือนปัจจุบัน กันไม่ให้ติด validation ด้านล่าง
    const resolvedPlannedMonth = plannedMonth || (isContractBatch
      ? (contractStart ? moment(contractStart).format("YYYY-MM") : moment().format("YYYY-MM"))
      : plannedMonth);
    if (!resolvedPlannedMonth) {
      return res.status(400).json({ message: "กรุณาระบุเดือนที่ตั้งใจจะทำงานนี้" });
    }

    // ✅ เช็คซ้ำ — กันเพิ่มแผนงานล่วงหน้าไปทับ "ครั้งที่" ที่มีอยู่แล้วในสัญญาเดียวกัน (ทั้งที่ลงตารางแล้วและที่เป็นแผนงานอื่นค้างอยู่)
    if (isContractBatch && contractGroupId && time) {
      const dupRound = await findDuplicateContractRound(contractGroupId, time);
      if (dupRound) {
        return res.status(409).json({ message: `ครั้งที่ ${time} ของสัญญานี้ถูกใช้ไปแล้ว กรุณาตรวจสอบ` });
      }
    }

    // ✅ ห้ามเลขที่สัญญาซ้ำกับสัญญาอื่น — excludeContractGroupId ส่ง contractGroupId ที่ client ให้มา
    // ด้วย (ถ้ามี) เผื่อเป็นการเพิ่มแผนงานล่วงหน้าครั้งถัดไปของสัญญาเดิม ซึ่งเลขที่สัญญาจะซ้ำกับตัวเองเสมอ
    if (isContractBatch && contractNo) {
      const dupContractNo = await findDuplicateContractNo(contractNo, contractGroupId);
      if (dupContractNo) {
        return res.status(409).json({ message: `เลขที่สัญญา "${contractNo}" ถูกใช้ไปแล้ว กรุณาตรวจสอบ` });
      }
    }

    const draft = await new CalendarEvent({
      company,
      site,
      title,
      system,
      time,
      team,
      description,
      resPerson: resPerson || undefined,
      unscheduled: true,
      plannedMonth: resolvedPlannedMonth,
      // ✅ ให้ค่าเริ่มต้นเสมอ (schema บังคับ required) แทนสีที่ผู้ใช้เลือกจริงตอนลงตาราง
      // ใช้สีแดงธีมของแอป (เดิมเทา #9CA3AF ไม่ตรงกับธีม)
      backgroundColor: backgroundColor || "#dc2626",
      textColor: textColor || "#ffffff",
      fontSize: fontSize || 8,
      userId: req.userId,
      ...(isContractBatch ? {
        contractGroupId: contractGroupId || crypto.randomUUID(),
        contractNo, quotationNo, contractStart, contractEnd, visitCount, jobValue,
      } : {}),
    }).save();

    res.status(201).json({ event: draft });
  } catch (error) {
    console.error("❌ Error creating draft event:", error);
    res.status(500).send("Internal Server Error");
  }
});

router.get("/drafts", verifyToken, async (req, res) => {
  try {
    const userId = req.userId;
    const userRole = req.user.role;
    const isAdminOrManager = ["admin", "manager"].includes(userRole);

    const query = isAdminOrManager
      ? { unscheduled: true }
      : { unscheduled: true, $or: [{ resPerson: userId }, { team: req.user.fname }, { userId: userId }] };

    const drafts = await CalendarEvent.find(query).sort({ createdAt: -1 }).lean();
    res.json({ drafts });
  } catch (error) {
    console.error("❌ Error fetching draft events:", error);
    res.status(500).send("Internal Server Error");
  }
});

// ✅ แปลง draft ให้เป็นงานที่ลงตารางจริง (กำหนดวันที่ + ปลด unscheduled ออก) — ใช้ทั้งตอนลาก
// การ์ดวางลงปฏิทิน (eventReceive), ตอนกดปุ่ม "ลงตาราง" เลือกวันที่เอง, และตอนแก้ไขงานล่วงหน้า
// แล้วเลือกใส่วันที่ start/end เอง (เหมือนฟอร์มเพิ่มงานปกติ)
// ✅ รองรับ dates[] (งานเข้าหลายวันไม่ติดกัน) แบบเดียวกับ POST / — ช่วงแรกอัปเดตลงตัว draft เดิม
// ช่วงที่เหลือ clone เป็น record ใหม่ผูกด้วย jobGroupId เดียวกัน
router.put("/:id/schedule", verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { start, end, date, startTime, endTime, dates, team, resPerson, teamMembers, time } = req.body;

    const existingEvent = await CalendarEvent.findById(id);
    if (!existingEvent) return res.status(404).json({ message: "ไม่พบงานนี้" });
    if (!existingEvent.unscheduled) {
      return res.status(400).json({ message: "งานนี้ถูกลงตารางไปแล้ว" });
    }

    const isAdminOrManager = ["admin", "manager"].includes(req.user.role);
    const isOwner = existingEvent.userId.toString() === req.userId.toString();
    if (!isAdminOrManager && !isOwner) {
      return res.status(403).json({ message: "คุณไม่มีสิทธิ์แก้ไขงานนี้" });
    }

    const isMultiDate = Array.isArray(dates) && dates.length > 0;
    if (!isMultiDate && !date) {
      return res.status(400).json({ message: "กรุณาระบุวันที่" });
    }

    // ✅ ลงตารางงานที่วางแผนล่วงหน้าไว้ ก็ต้องเช็คช่างชนกันเหมือนสร้างงานใหม่ปกติ — เดิมข้ามไปเลย
    // ทำให้ลาก/กดลงตารางแล้วมอบหมายช่างที่มีงานชนกันวันเดียวกันได้โดยไม่มีอะไรเตือน
    const effectiveResPerson = resPerson !== undefined ? resPerson : existingEvent.resPerson;
    const rangesToCheck = isMultiDate ? dates.filter((d) => d && d.start && d.end) : [{ start: start || date, end: end || date }];
    if (effectiveResPerson && rangesToCheck.length > 0) {
      if (isMultiDate) {
        const mutualConflicts = findMutualOverlaps(rangesToCheck);
        if (mutualConflicts.length > 0) {
          const [a, b] = mutualConflicts[0];
          return res.status(409).json({
            message: `วันที่ที่กรอกทับกันเอง (${moment(a.start).locale("th").format("D MMM YYYY")} กับ ${moment(b.start).locale("th").format("D MMM YYYY")}) กรุณาตรวจสอบวันที่แต่ละครั้งอีกครั้ง`,
          });
        }
      }
      for (const range of rangesToCheck) {
        const conflicts = await findResPersonConflicts({
          resPerson: effectiveResPerson, start: range.start, end: range.end,
          startTime, endTime, excludeEventId: id,
        });
        if (conflicts.length > 0) {
          const c = conflicts[0];
          return res.status(409).json({
            message: `ช่างคนนี้มีงานชนกันอยู่แล้ว: ${c.title || "งาน"} · ${c.company || "-"}${c.site ? " - " + c.site : ""} วันที่ ${moment(c.start).locale("th").format("D MMM YYYY")}`,
          });
        }
      }
    }

    if (isMultiDate) {
      const [first, ...rest] = dates;
      const jobGroupId = dates.length > 1 ? (existingEvent.jobGroupId || crypto.randomUUID()) : existingEvent.jobGroupId;

      existingEvent.unscheduled = false;
      existingEvent.plannedMonth = undefined;
      if (jobGroupId) existingEvent.jobGroupId = jobGroupId;
      existingEvent.date = first.date || first.start;
      existingEvent.start = first.start;
      existingEvent.end = first.end;
      if (startTime !== undefined) existingEvent.startTime = startTime;
      if (endTime !== undefined) existingEvent.endTime = endTime;
      // ✅ เดิมฟอร์ม "ลงตาราง" ไม่มีช่องทีมเลย — งานที่ยังไม่เคยมอบหมายทีมตอนสร้าง draft
      // จะไม่มีทางกำหนดได้จนกว่าจะไปแก้ไขแยกอีกที ตอนนี้เลือก/แก้ทีมได้พร้อมกันตอนลงตารางเลย
      if (team !== undefined) existingEvent.team = team;
      if (resPerson !== undefined) existingEvent.resPerson = resPerson;
      if (teamMembers !== undefined) existingEvent.teamMembers = teamMembers;
      await existingEvent.save();

      if (rest.length > 0) {
        const base = existingEvent.toObject();
        delete base._id;
        delete base.createdAt;
        delete base.updatedAt;
        delete base.__v;
        await Promise.all(
          rest.map((d) =>
            new CalendarEvent({
              ...base,
              date: d.date || d.start,
              start: d.start,
              end: d.end,
            }).save()
          )
        );
      }

      return res.json({ event: existingEvent });
    }

    existingEvent.unscheduled = false;
    existingEvent.plannedMonth = undefined;
    existingEvent.date = date;
    existingEvent.start = start || date;
    existingEvent.end = end || date;
    if (startTime !== undefined) existingEvent.startTime = startTime;
    if (endTime !== undefined) existingEvent.endTime = endTime;
    if (team !== undefined) existingEvent.team = team;
    if (resPerson !== undefined) existingEvent.resPerson = resPerson;
    if (teamMembers !== undefined) existingEvent.teamMembers = teamMembers;
    // ✅ ใช้ตอนแปลงสัญญาฉบับร่าง (ยังไม่มีครั้งไหนลงตารางเลย) ให้กลายเป็น "ครั้งที่ 1" จริง —
    // เดิม route นี้ไม่รับ time เลย เพราะฟอร์ม "ลงตาราง" ทั่วไปไม่เคยต้องกำหนดครั้งที่มาก่อน
    if (time !== undefined) {
      // ✅ เช็คซ้ำ — excludeId เป็นตัวมันเอง เพราะ draft ที่กำลังแปลงนี้อาจถือ "ครั้งที่" นี้อยู่แล้วตั้งแต่ตอนสร้าง
      const dupRound = await findDuplicateContractRound(existingEvent.contractGroupId, time, existingEvent._id);
      if (dupRound) {
        return res.status(409).json({ message: `ครั้งที่ ${time} ของสัญญานี้ถูกใช้ไปแล้ว กรุณาตรวจสอบ` });
      }
      existingEvent.time = time;
    }

    await existingEvent.save();
    res.json({ event: existingEvent });
  } catch (error) {
    console.error("❌ Error scheduling draft event:", error);
    res.status(500).send("Internal Server Error");
  }
});

// ✅ แก้ไขข้อมูลงานวางแผนล่วงหน้า (ยังไม่ลงตาราง) — ทำเฉพาะฟิลด์ของ draft เท่านั้น (ไม่มีวันที่)
// แยกจาก PUT /:id (แก้ไขงานที่ลงตารางแล้ว) ที่มี logic แจ้งเตือน/เงื่อนไขซับซ้อนกว่ามาก
router.put("/:id/draft", verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const existingEvent = await CalendarEvent.findById(id);
    if (!existingEvent) return res.status(404).json({ message: "ไม่พบงานนี้" });
    if (!existingEvent.unscheduled) {
      return res.status(400).json({ message: "งานนี้ถูกลงตารางไปแล้ว ให้แก้ไขผ่านหน้าปฏิทินปกติ" });
    }

    const isAdminOrManager = ["admin", "manager"].includes(req.user.role);
    const isOwner = existingEvent.userId.toString() === req.userId.toString();
    if (!isAdminOrManager && !isOwner) {
      return res.status(403).json({ message: "คุณไม่มีสิทธิ์แก้ไขงานนี้" });
    }

    const { company, site, title, system, time, team, resPerson, plannedMonth, description } = req.body;
    if (!site || !title || !system) {
      return res.status(400).json({ message: "กรุณาระบุชื่อโครงการ/ประเภทงาน/ระบบงาน" });
    }
    if (!plannedMonth) {
      return res.status(400).json({ message: "กรุณาระบุเดือนที่ตั้งใจจะทำงานนี้" });
    }

    existingEvent.company = company;
    existingEvent.site = site;
    existingEvent.title = title;
    existingEvent.system = system;
    existingEvent.time = time;
    existingEvent.team = team;
    existingEvent.resPerson = resPerson || undefined;
    existingEvent.plannedMonth = plannedMonth;
    existingEvent.description = description;

    await existingEvent.save();
    res.json({ event: existingEvent });
  } catch (error) {
    console.error("❌ Error updating draft event:", error);
    res.status(500).send("Internal Server Error");
  }
});

// ✅ ย้ายงานที่ลงตารางไปแล้วกลับไปเป็น "วางแผนล่วงหน้า" (unscheduled) — ใช้ตอนอยากเอาวันที่ออก
// กลับไปอยู่ในแผงงานล่วงหน้าเหมือนเดิม โดยไม่ต้องลบทิ้งทั้งงาน (ปุ่ม "ย้ายไปแผนล่วงหน้า" ใน
// EditEvent.js และตอนลากงานจากปฏิทินไปวางบนแผงงานล่วงหน้า)
router.put("/:id/unschedule", verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const existingEvent = await CalendarEvent.findById(id);
    if (!existingEvent) return res.status(404).json({ message: "ไม่พบงานนี้" });
    if (existingEvent.unscheduled) {
      return res.status(400).json({ message: "งานนี้เป็นงานวางแผนล่วงหน้าอยู่แล้ว" });
    }

    const isAdminOrManager = ["admin", "manager"].includes(req.user.role);
    const isOwner = existingEvent.userId.toString() === req.userId.toString();
    if (!isAdminOrManager && !isOwner) {
      return res.status(403).json({ message: "คุณไม่มีสิทธิ์แก้ไขงานนี้" });
    }
    // ❌ งานที่ปิดแล้ว (ดำเนินการเสร็จสิ้น) ห้ามย้ายกลับไปแผนล่วงหน้า มีแค่ admin/manager เท่านั้นที่ทำได้
    if (existingEvent.status === "ดำเนินการเสร็จสิ้น" && !isAdminOrManager) {
      return res.status(403).json({ message: "งานนี้ปิดแล้ว ไม่สามารถย้ายกลับไปแผนล่วงหน้าได้" });
    }

    existingEvent.unscheduled = true;
    existingEvent.plannedMonth = req.body.plannedMonth || moment(existingEvent.start || existingEvent.date).format("YYYY-MM");
    existingEvent.date = undefined;
    existingEvent.start = undefined;
    existingEvent.end = undefined;

    await existingEvent.save();
    res.json({ event: existingEvent });
  } catch (error) {
    console.error("❌ Error unscheduling event:", error);
    res.status(500).send("Internal Server Error");
  }
});

// ✅ บันทึกการติดตามลูกค้าเรื่องใบเสนอราคาแบบเป็นครั้งๆ (ครั้งที่ 1, 2, 3...) พร้อมหลักฐานแนบได้ถ้ามี
// (หน้า /quotations) — เจ้าของ/ผู้ได้รับมอบหมายงานนี้หรือ admin บันทึกได้ ไม่จำกัดแค่แอดมิน เพราะคนที่
// โทร/คุยกับลูกค้าจริงมักเป็นช่าง — attemptNumber คำนวณที่นี่เสมอ ห้ามรับจาก client (กันเลขซ้ำ/สลับ)
router.put("/:id/quotation-followup", verifyToken, upload.single("file"), async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.userId;
    const { note } = req.body;

    const existingEvent = await CalendarEvent.findById(id);
    if (!existingEvent) {
      return res.status(404).json({ message: "ไม่พบงานนี้" });
    }

    // ✅ เงื่อนไขสิทธิ์เดียวกับ PUT /:id — เจ้าของ/ผู้ได้รับมอบหมาย (resPerson/team ตรงกับตัวเอง) หรือ admin
    const isOwner = existingEvent.userId.toString() === userId.toString();
    const isAssigned =
      (existingEvent.resPerson && existingEvent.resPerson === userId) ||
      (existingEvent.team && existingEvent.team === req.user.fname);
    if (req.user.role !== "admin" && !isOwner && !isAssigned) {
      return res.status(403).json({ message: "คุณไม่มีสิทธิ์บันทึกการติดตามงานนี้" });
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
      const sanitizedName = originalName.replace(/[^\w\-\.]/g, "_");
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

// ✅ รวมไฟล์เอกสารประจำงาน (Service Report/ใบเสนอราคา/ใบวางบิล/ใบส่งมอบงาน) จากทุก event
// ให้แบนราบเป็นรายการเดียว สำหรับหน้า Files แสดงเป็นตาราง แยกจากไฟล์ทั่วไป (model File เดิม)
// ต้องอยู่ก่อน "/:id" ไม่งั้น Express จะจับ "documents" เป็นค่า :id แทน
router.get("/documents", verifyToken, async (req, res) => {
  try {
    const userId = req.userId;
    const userRole = req.user.role;

    const isAdminOrManager = ["admin", "manager"].includes(userRole);
    const query = isAdminOrManager
      ? { unscheduled: { $ne: true } }
      : { unscheduled: { $ne: true }, $or: [{ resPerson: userId }, { team: req.user.fname }, { userId: userId }] };

    const events = await CalendarEvent.find(query)
      .select("docNo company site title system team teamMembers time status reportFiles quotationFiles invoiceFiles completionFiles")
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
            teamMembers: ev.teamMembers || [],
            time: ev.time || "",
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

    // ✅ ตัดงาน "วางแผนล่วงหน้า" (unscheduled) ออกเสมอ — ยังไม่มีวันที่จริง ไม่ควรโผล่ในปฏิทิน
    const userEvents = await CalendarEvent.find({ unscheduled: { $ne: true } }).lean();

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

// ✅ รวมงานเก่าที่ยังไม่มี contractGroupId (สร้างก่อนมีฟีเจอร์สัญญา) เข้าเป็นสัญญาเดียวกัน — เลือก
// event ที่มีอยู่แล้วมาผูก contractGroupId ใหม่ให้ พร้อมเรียง "ครั้งที่" ใหม่ตามวันที่จริง (ค่า time
// เดิมของงานเก่าไม่น่าเชื่อถือ อาจว่าง/ซ้ำ/มั่วมาก่อน) — เฉพาะ admin/manager เพราะเป็นการแก้ไขข้อมูล
// ย้อนหลังเป็นชุด ไม่ผูกกับสิทธิ์ความเป็นเจ้าของ/ผู้ถูกมอบหมายของ event เดี่ยวๆ แบบ PUT /:id
//
// ⚠️ ต้องประกาศ "ก่อน" PUT /contract/:contractGroupId ด้านล่าง — ทั้งคู่เป็น path 2 segment
// เหมือนกัน ("contract/merge" กับ "contract/:contractGroupId") ถ้าสลับลำดับ Express จะจับ "merge"
// เป็นค่า :contractGroupId ไปแทน route นี้จะไม่มีทางถูกเรียกถึงเลย
router.put("/contract/merge", verifyToken, async (req, res) => {
  try {
    if (!["admin", "manager"].includes(req.user.role)) {
      return res.status(403).json({ message: "เฉพาะแอดมิน/manager เท่านั้นที่จัดกลุ่มสัญญาได้" });
    }

    const { eventIds, contractNo, quotationNo, contractStart, contractEnd, visitCount, jobValue } = req.body;
    if (!Array.isArray(eventIds) || eventIds.length === 0) {
      return res.status(400).json({ message: "กรุณาเลือกงานอย่างน้อย 1 รายการ" });
    }

    const events = await CalendarEvent.find({ _id: { $in: eventIds } });
    if (events.length !== eventIds.length) {
      return res.status(404).json({ message: "ไม่พบบางรายการที่เลือก อาจถูกลบหรือแก้ไขไปแล้ว" });
    }

    // ✅ ห้ามเลขที่สัญญาซ้ำกับสัญญาอื่น — งานเก่าที่กำลังจะรวมนี้ยังไม่มี contractGroupId เลย
    // (ไม่ต้อง exclude อะไร) เจอที่ไหนก็ถือว่าซ้ำหมด
    if (contractNo) {
      const dupContractNo = await findDuplicateContractNo(contractNo);
      if (dupContractNo) {
        return res.status(409).json({ message: `เลขที่สัญญา "${contractNo}" ถูกใช้ไปแล้ว กรุณาตรวจสอบ` });
      }
    }

    const contractGroupId = crypto.randomUUID();
    const sorted = events.slice().sort((a, b) => new Date(a.start) - new Date(b.start));
    const resolvedVisitCount = Number(visitCount) > 0 ? Number(visitCount) : eventIds.length;

    const updated = await Promise.all(
      sorted.map((ev, idx) =>
        CalendarEvent.findByIdAndUpdate(
          ev._id,
          {
            $set: {
              contractGroupId,
              contractNo: contractNo || "",
              quotationNo: quotationNo || "",
              contractStart: contractStart || undefined,
              contractEnd: contractEnd || undefined,
              visitCount: resolvedVisitCount,
              jobValue: jobValue != null && jobValue !== "" ? Number(jobValue) : undefined,
              time: String(idx + 1),
            },
          },
          { new: true }
        )
      )
    );

    res.json({ events: updated, contractGroupId });
  } catch (error) {
    console.error("❌ Error merging events into contract:", error);
    res.status(500).send("Internal Server Error");
  }
});

// ✅ ย้าย "งานทั่วไป" (event ที่ยังไม่มี contractGroupId) เข้าไปเป็นครั้งที่ N ของสัญญาที่มีอยู่แล้ว —
// ต่างจาก PUT /contract/merge ตรงที่ merge สร้าง contractGroupId ใหม่เสมอ ส่วนตัวนี้ผูกเข้ากับสัญญา
// เดิมที่เลือกไว้ ใช้แก้ไขกรณีจัดกลุ่มผิด (สร้างเป็นงานเดี่ยวทั้งที่จริงควรอยู่ในสัญญานี้)
// (path มี "attach" คั่นเป็น segment ที่ 3 จึงไม่ชนกับ PUT /contract/:contractGroupId 2 segment ด้านล่าง)
router.put("/contract/:contractGroupId/attach", verifyToken, async (req, res) => {
  try {
    if (!["admin", "manager"].includes(req.user.role)) {
      return res.status(403).json({ message: "เฉพาะแอดมิน/manager เท่านั้นที่ย้ายงานเข้าสัญญาได้" });
    }
    const { contractGroupId } = req.params;
    const { eventId, time } = req.body;
    if (!eventId || time === undefined || time === null || time === "") {
      return res.status(400).json({ message: "กรุณาระบุงานและครั้งที่ที่ต้องการย้ายเข้า" });
    }

    const target = await CalendarEvent.findById(eventId);
    if (!target) {
      return res.status(404).json({ message: "ไม่พบงานที่ต้องการย้าย" });
    }

    // ✅ ดึงข้อมูลสัญญาปลายทางจาก record ใดก็ได้ที่ผูก contractGroupId นี้อยู่แล้ว มาคัดลอกฟิลด์
    // ที่ต้องเหมือนกันทุกครั้ง (contractNo/quotationNo/visitCount/jobValue ฯลฯ) ลงงานที่ย้ายเข้ามาด้วย
    const contractHead = await CalendarEvent.findOne({ contractGroupId });
    if (!contractHead) {
      return res.status(404).json({ message: "ไม่พบสัญญานี้" });
    }

    // ✅ ครั้งที่เลือกอาจ "ลงตารางแล้ว" อยู่ก่อน — เดิมถือว่าซ้ำแล้วปฏิเสธเสมอ แต่จริงๆ ควรต่อเป็น
    // งานเดียวกัน (ผูก jobGroupId เดียวกัน) เหมือนปุ่ม "เพิ่มวันที่ต่อเนื่อง" ในตารางเอง — ไม่กินโควตา
    // ครั้งใหม่เพิ่ม เพราะครั้งนี้ถูกนับไปแล้ว ส่วนครั้งที่เป็นแค่ "แผนงานล่วงหน้า" (unscheduled จอง
    // ไว้แต่ยังไม่มีวันที่จริง) ห้ามต่อด้วย เพราะจะไปชนกับแผนงานล่วงหน้านั้นตอนแปลงเป็นของจริงทีหลัง
    const existingRoundDocs = await CalendarEvent.find({ contractGroupId, time: String(time) });
    const scheduledRoundDocs = existingRoundDocs.filter((v) => !v.unscheduled);
    const pendingRoundDoc = existingRoundDocs.find((v) => v.unscheduled);

    let jobGroupId;
    if (scheduledRoundDocs.length > 0) {
      const holder = scheduledRoundDocs.find((v) => v.jobGroupId) || scheduledRoundDocs[0];
      jobGroupId = holder.jobGroupId || crypto.randomUUID();
      if (!holder.jobGroupId) {
        await CalendarEvent.updateOne({ _id: holder._id }, { $set: { jobGroupId } });
      }
    } else if (pendingRoundDoc) {
      return res.status(409).json({
        message: `ครั้งที่ ${time} มีแผนงานล่วงหน้าจองไว้อยู่แล้ว กรุณาเลือกครั้งอื่น หรือไปลงวันที่จริงที่แผนงานล่วงหน้าแทน`,
      });
    } else {
      // ✅ ครั้งใหม่ล้วนๆ (ยังไม่มีใครจับจองอยู่) — กินโควตาครั้งใหม่จริง ต้องเช็คเพดานจำนวนครั้ง
      // นับ "จำนวนครั้งที่ไม่ซ้ำกัน" (ไม่ใช่จำนวน record ดิบ) เทียบ pattern เดียวกับที่แก้ไว้ใน
      // PUT /contract/:contractGroupId — กันนับเกินจริงตอนบางครั้งเข้างานไม่ต่อเนื่องมีหลาย record
      if (Number(contractHead.visitCount) > 0) {
        const scheduledEvents = await CalendarEvent.find({ contractGroupId, unscheduled: { $ne: true } })
          .select("time")
          .lean();
        const usedRounds = new Set(
          scheduledEvents.map((e) => e.time).filter((t) => t !== undefined && t !== null && t !== "").map(String)
        );
        if (usedRounds.size >= Number(contractHead.visitCount)) {
          return res.status(409).json({ message: "สัญญานี้ครบตามจำนวนครั้งที่กำหนดไว้แล้ว" });
        }
      }
    }

    const updated = await CalendarEvent.findByIdAndUpdate(
      eventId,
      {
        $set: {
          contractGroupId,
          contractNo: contractHead.contractNo,
          quotationNo: contractHead.quotationNo,
          contractStart: contractHead.contractStart,
          contractEnd: contractHead.contractEnd,
          visitCount: contractHead.visitCount,
          jobValue: contractHead.jobValue,
          time: String(time),
          ...(jobGroupId ? { jobGroupId } : {}),
        },
      },
      { new: true }
    );

    res.json({ event: updated });
  } catch (error) {
    console.error("❌ Error attaching event to contract:", error);
    res.status(500).send("Internal Server Error");
  }
});

// ✅ แยกครั้งที่ N ออกจากสัญญา กลับไปเป็น "งานทั่วไป" เดี่ยวๆ (ใช้แก้ไขกรณีจัดกลุ่มผิด — สร้าง/ต่อเป็น
// ครั้งหนึ่งของสัญญาไปแล้วทั้งที่จริงไม่ควรผูกกับสัญญานี้) — ทำงานกับ "ทั้งครั้ง" (ทุก record ที่แชร์
// contractGroupId+time เดียวกัน) ไม่ใช่แค่ record เดียว เพราะครั้งที่เข้างานไม่ต่อเนื่องมีได้หลาย record
// ต่อ 1 ครั้ง — jobGroupId (ตัวผูกวันที่ไม่ต่อเนื่องของงานเดียวกัน) ไม่ถูกแตะ ยังกลุ่มเดียวกันเหมือนเดิม
router.put("/contract/:contractGroupId/detach", verifyToken, async (req, res) => {
  try {
    if (!["admin", "manager"].includes(req.user.role)) {
      return res.status(403).json({ message: "เฉพาะแอดมิน/manager เท่านั้นที่แยกงานออกจากสัญญาได้" });
    }
    const { contractGroupId } = req.params;
    const { time } = req.body;
    if (time === undefined || time === null || time === "") {
      return res.status(400).json({ message: "กรุณาระบุครั้งที่ที่ต้องการแยกออก" });
    }

    const result = await CalendarEvent.updateMany(
      { contractGroupId, time: String(time) },
      {
        $unset: {
          contractGroupId: "",
          contractNo: "",
          quotationNo: "",
          contractStart: "",
          contractEnd: "",
          visitCount: "",
          jobValue: "",
        },
      }
    );
    if (result.matchedCount === 0) {
      return res.status(404).json({ message: "ไม่พบครั้งที่นี้ในสัญญา" });
    }

    res.json({ success: true, modifiedCount: result.modifiedCount });
  } catch (error) {
    console.error("❌ Error detaching round from contract:", error);
    res.status(500).send("Internal Server Error");
  }
});

// ✅ ยืนยัน/ยกเลิกยืนยันว่างานนี้เป็น "งานทั่วไป" จริงๆ (ไม่ใช่แค่ยังไม่ได้จัดกลุ่ม) — เฉพาะงานที่ไม่มี
// contractGroupId เท่านั้นที่มีสถานะนี้ได้ ก่อนกดยืนยันจะแสดงเป็น "งานเก่าในระบบที่ยังไม่จัดกลุ่ม" เสมอ
// (ดูหน้า "ภาพรวมงาน" ContractOverview.js) — เฉพาะแอดมิน/manager เหมือน route จัดการสัญญาอื่นๆ ในไฟล์นี้
// ไม่ผูกกับสิทธิ์ความเป็นเจ้าของ/ผู้ถูกมอบหมายแบบ PUT /:id ทั่วไป เพราะเป็นการจัดหมวดหมู่เชิงบริหารจัดการ
router.put("/:id/general", verifyToken, async (req, res) => {
  try {
    if (!["admin", "manager"].includes(req.user.role)) {
      return res.status(403).json({ message: "เฉพาะแอดมิน/manager เท่านั้นที่ยืนยันงานทั่วไปได้" });
    }
    const { id } = req.params;
    const { isConfirmedGeneral } = req.body;

    const target = await CalendarEvent.findById(id);
    if (!target) {
      return res.status(404).json({ message: "ไม่พบงานนี้" });
    }
    if (target.contractGroupId) {
      return res.status(400).json({ message: "งานนี้ผูกกับสัญญาอยู่แล้ว ไม่สามารถยืนยันเป็นงานทั่วไปได้" });
    }

    const updated = await CalendarEvent.findByIdAndUpdate(
      id,
      { $set: { isConfirmedGeneral: Boolean(isConfirmedGeneral) } },
      { new: true }
    );
    res.json({ event: updated });
  } catch (error) {
    console.error("❌ Error marking event as general:", error);
    res.status(500).send("Internal Server Error");
  }
});

// ✅ แก้ไขข้อมูลสัญญา (contractNo/quotationNo/contractStart/contractEnd/visitCount/jobValue) พร้อมกัน
// ทุก "ครั้ง" ที่อยู่ในสัญญาเดียวกัน (ผูกด้วย contractGroupId) — กันข้อมูลสัญญาเพี้ยนไม่ตรงกันระหว่าง
// ครั้งที่ 1-4 ถ้าแก้ทีละ record ผ่าน PUT /:id ธรรมดาซึ่งกระทบแค่ record เดียว
// (path มี "contract" คั่นเป็นอีก segment จึงไม่ชนกับ "/:id" แม้จะประกาศก่อนหรือหลังก็ได้)
router.put("/contract/:contractGroupId", verifyToken, async (req, res) => {
  try {
    const { contractGroupId } = req.params;
    const events = await CalendarEvent.find({ contractGroupId });
    if (events.length === 0) {
      return res.status(404).json({ message: "ไม่พบสัญญานี้" });
    }

    const isAdminOrManager = ["admin", "manager"].includes(req.user.role);
    const isAllowed = isAdminOrManager || events.some((e) =>
      (e.userId && e.userId.toString() === req.userId.toString()) ||
      e.resPerson === req.userId ||
      (e.team && e.team === req.user.fname)
    );
    if (!isAllowed) {
      return res.status(403).json({ message: "คุณไม่มีสิทธิ์แก้ไขสัญญานี้" });
    }

    // ✅ team/resPerson เพิ่มเข้ามาให้แก้ "ผู้รับผิดชอบ" ของทั้งสัญญาได้พร้อมกันทุกครั้งเหมือนฟิลด์
    // สัญญาอื่นๆ ด้านล่าง (เดิม route นี้แก้ได้แค่ข้อมูลสัญญา ไม่รวมผู้รับผิดชอบ ซึ่งจริงๆ ก็ควรผูก
    // กับสัญญาทั้งก้อนเหมือนกัน ไม่ใช่รายครั้ง — ดูหน้า "ภาพรวมสัญญา" ที่แก้ inline ผ่านตารางได้เลย)
    const { contractNo, quotationNo, contractStart, contractEnd, visitCount, jobValue, team, resPerson } = req.body;

    // ✅ ห้ามเลขที่สัญญาซ้ำกับสัญญาอื่น — excludeContractGroupId เป็นตัวเอง เพราะทุกครั้งในสัญญานี้
    // มี contractNo เดิมอยู่แล้วโดยตั้งใจ (ไม่ถือว่าซ้ำ)
    if (contractNo !== undefined) {
      const dupContractNo = await findDuplicateContractNo(contractNo, contractGroupId);
      if (dupContractNo) {
        return res.status(409).json({ message: `เลขที่สัญญา "${contractNo}" ถูกใช้ไปแล้ว กรุณาตรวจสอบ` });
      }
    }

    const update = {};
    if (contractNo !== undefined) update.contractNo = contractNo;
    if (quotationNo !== undefined) update.quotationNo = quotationNo;
    if (contractStart !== undefined) update.contractStart = contractStart;
    if (contractEnd !== undefined) update.contractEnd = contractEnd;
    if (visitCount !== undefined) {
      // ✅ ห้ามลดจำนวนครั้งต่ำกว่าที่ลงตารางจริงไปแล้ว — ไม่งั้นครั้งที่เกินจะโดนคอลัมน์ "ครั้งที่ N"
      // ในหน้าภาพรวมสัญญาตัดทิ้งจากที่แสดงผลไปเลยทั้งที่ข้อมูลยังอยู่จริงในฐานข้อมูล (ข้อมูลไม่ตรงจอ)
      // ⚠️ BUG ที่แก้: เดิมนับด้วย countDocuments (จำนวน record ดิบ) — ครั้งที่เข้างานไม่ต่อเนื่อง (เว้น
      // ช่วงแล้วกลับมาเข้าอีก) มีหลาย record ต่อ 1 "ครั้งที่" ทำให้นับเกินจริงมาก (เช่น 3 ครั้งจริง แต่มี
      // 7 record เพราะบางครั้งเข้าหลายวันไม่ติดกัน) ทำให้ปฏิเสธการบันทึกทั้งที่ visitCount ไม่ได้ลดจริง
      // เลย (แค่แก้ไขงานอื่นในสัญญาแล้ว EditEvent.js ส่ง visitCount เดิมกลับมาด้วยทุกครั้ง) — ต้องนับ
      // "จำนวนครั้งที่ไม่ซ้ำกัน" (distinct time) เหมือน countUsedRounds ฝั่ง frontend แทน
      const scheduledEvents = await CalendarEvent.find({ contractGroupId, unscheduled: { $ne: true } })
        .select("time")
        .lean();
      const usedRounds = new Set(
        scheduledEvents
          .map((e) => e.time)
          .filter((t) => t !== undefined && t !== null && t !== "")
          .map(String)
      );
      const realCount = usedRounds.size;
      if (Number(visitCount) < realCount) {
        return res.status(409).json({
          message: `ลดจำนวนครั้งต่ำกว่า ${realCount} ไม่ได้ เพราะมีงานลงตารางแล้ว ${realCount} ครั้ง`,
        });
      }
      update.visitCount = visitCount;
    }
    if (jobValue !== undefined) update.jobValue = jobValue;
    if (team !== undefined) update.team = team;
    if (resPerson !== undefined) update.resPerson = resPerson;

    await CalendarEvent.updateMany({ contractGroupId }, { $set: update });
    const updatedEvents = await CalendarEvent.find({ contractGroupId }).lean();
    res.json({ events: updatedEvents });
  } catch (error) {
    console.error("❌ Error updating contract fields:", error);
    res.status(500).send("Internal Server Error");
  }
});

// ✅ ลบสัญญาทั้งก้อน (ทุกครั้งที่ผูก contractGroupId เดียวกัน) ในคำสั่งเดียว — เดิมมีแค่ DELETE /:id
// ที่ลบได้ทีละ event เท่านั้น ไม่มีทางลบสัญญาทั้งสัญญาได้จากหน้า "ภาพรวมสัญญา" เลย ต้องไล่ลบทีละครั้ง
// path นี้ยาว 2 segment ("contract" + id) ต่างจาก DELETE /:id (1 segment) จึงไม่ชนกันไม่ว่าจะประกาศ
// ก่อน/หลัง (ไม่เหมือนกรณี PUT /contract/merge vs PUT /contract/:contractGroupId ที่ต้องระวังลำดับ)
router.delete("/contract/:contractGroupId", verifyToken, async (req, res) => {
  try {
    if (!["admin", "manager"].includes(req.user.role)) {
      return res.status(403).json({ message: "เฉพาะแอดมิน/manager เท่านั้นที่ลบสัญญาได้" });
    }
    const { contractGroupId } = req.params;
    const result = await CalendarEvent.deleteMany({ contractGroupId });
    if (result.deletedCount === 0) {
      return res.status(404).json({ message: "ไม่พบสัญญานี้" });
    }
    res.json({ deletedCount: result.deletedCount });
  } catch (error) {
    console.error("❌ Error deleting contract:", error);
    res.status(500).send("Internal Server Error");
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
    // ยกเว้น: comment (คุยโต้ตอบกัน), activityLog (แค่ log ไม่กระทบข้อมูลงานจริง), และฟิลด์ระบบ
    // ติดตามใบเสนอราคาทั้งชุด — เพราะการติดตามใบเสนอราคามักเกิด "หลัง" งานถูกปิดแล้ว (ช่างปิดงาน
    // หน้างานก่อน ค่อยตามเรื่องเอกสาร/ใบเสนอราคากับลูกค้าทีหลัง) ถ้าล็อกไว้เหมือนข้อมูลงานอื่นจะทำให้
    // ช่างอัปเดตสถานะใบเสนอราคาของงานตัวเองไม่ได้เลยทั้งที่เป็นกรณีปกติ ไม่ใช่ข้อยกเว้น
    const isAdminOrManager = ["admin", "manager"].includes(req.user.role);
    const NON_BLOCKING_FIELDS = [
      "comments", "activityLog",
      "quotationStatus", "quotationSentAt", "quotationDecisionAt", "quotationDecisionBy",
      "quotationAmount", "quotationFollowUpNote",
    ];
    const isNonBlockingUpdate = Object.keys(req.body).every((k) => NON_BLOCKING_FIELDS.includes(k));
    if (existingEvent.status === "ดำเนินการเสร็จสิ้น" && !isAdminOrManager && !isNonBlockingUpdate) {
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
      teamMembers, // ✅ ลูกทีมเพิ่มเติม (แสดงผลอย่างเดียว ไม่กระทบสิทธิ์/แจ้งเตือน)

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

      // ✅ ระบบติดตามใบเสนอราคา (ดูหน้า /quotations)
      quotationStatus,
      quotationSentAt,
      quotationDecisionAt,
      quotationDecisionBy,
      quotationAmount,
      quotationFollowUpNote,

      // ✅ ข้อมูลสัญญา — แก้ทีละ record ผ่านตรงนี้ได้ (เช่นแก้แค่ครั้งเดียว) แต่ถ้าต้องการแก้พร้อมกัน
      // ทุกครั้งในสัญญาเดียวกันให้ใช้ PUT /contract/:contractGroupId แทน (กันข้อมูลเพี้ยนไม่ตรงกัน)
      contractGroupId,
      contractNo,
      quotationNo,
      contractStart,
      contractEnd,
      visitCount,
      jobValue,
    } = req.body;

    // ✅ เช็คช่างชนกันเฉพาะตอนที่ resPerson/ช่วงวันที่จริงๆ เปลี่ยนไปจากเดิม — ไม่ต้องเช็คทุกครั้งที่
    // แก้ไขงาน (เช่น แก้แค่ status/comment) เพราะข้อมูลเดิมผ่านการเช็คมาแล้วตอนสร้าง/ลงตารางครั้งแรก
    const effectiveResPerson = resPerson !== undefined ? resPerson : existingEvent.resPerson;
    const effectiveStart = start !== undefined ? start : existingEvent.start;
    const effectiveEnd = end !== undefined ? end : existingEvent.end;
    const effectiveStartTime = startTime !== undefined ? startTime : existingEvent.startTime;
    const effectiveEndTime = endTime !== undefined ? endTime : existingEvent.endTime;
    const resPersonChanged = resPerson !== undefined && resPerson !== existingEvent.resPerson;
    const datesChanged =
      (start !== undefined && new Date(start).getTime() !== new Date(existingEvent.start).getTime()) ||
      (end !== undefined && new Date(end).getTime() !== new Date(existingEvent.end).getTime());

    if (effectiveResPerson && effectiveStart && effectiveEnd && (resPersonChanged || datesChanged)) {
      const conflicts = await findResPersonConflicts({
        resPerson: effectiveResPerson,
        start: effectiveStart,
        end: effectiveEnd,
        startTime: effectiveStartTime,
        endTime: effectiveEndTime,
        excludeEventId: id,
      });
      if (conflicts.length > 0) {
        const c = conflicts[0];
        return res.status(409).json({
          message: `ช่างคนนี้มีงานชนกันอยู่แล้ว: ${c.title || "งาน"} · ${c.company || "-"}${c.site ? " - " + c.site : ""} วันที่ ${moment(c.start).locale("th").format("D MMM YYYY")}`,
        });
      }
    }

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
      teamMembers,

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

      quotationStatus,
      quotationSentAt,
      quotationDecisionAt,
      quotationDecisionBy,
      quotationAmount,
      quotationFollowUpNote,

      contractGroupId,
      contractNo,
      quotationNo,
      contractStart,
      contractEnd,
      visitCount,
      jobValue,

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

    // ✅ งานที่เข้าหลายวันไม่ติดกัน (ผูกด้วย jobGroupId เดียวกัน) ตอนนี้ action อย่าง "ขอปิดงาน"/
    // "อนุมัติ"/"ไม่อนุมัติ" ฝั่ง frontend อัปเดตทุกวันในกลุ่มพร้อมกันด้วย Promise.all ยิง PUT
    // มาทีละวัน — ถ้า tag อิงแค่ _id ของแต่ละวัน (ไม่ซ้ำกัน) จะได้ push แจ้งเตือนซ้อนกันหลายอันสำหรับ
    // งานเดียวกัน ใช้ jobGroupId เป็น tag แทนเมื่อมี ให้เบราว์เซอร์ยุบเหลือแจ้งเตือนเดียวต่องาน
    const notifyTag = `event-${updatedEvent.jobGroupId || updatedEvent._id}`;

    if (resPerson && resPerson !== existingEvent.resPerson && resPerson !== userId) {
      // ✅ ใส่วันที่/เวลาให้เหมือนแจ้งเตือน "งานใหม่" ตอนเพิ่ม event — คนที่เพิ่งถูกมอบหมายงานควรรู้
      // ตั้งแต่แจ้งเตือนแรกเลยว่างานนัดไว้เมื่อไหร่ ไม่ต้องเปิดแอพเข้าไปดูเอง
      const reassignDateLabel = moment(updatedEvent.start || updatedEvent.date).locale("th").format("D MMM YYYY");
      const reassignTimeLabel = (updatedEvent.startTime || updatedEvent.endTime)
        ? `${updatedEvent.startTime || "-"}-${updatedEvent.endTime || "-"}`
        : "ทั้งวัน";
      // ✅ ใส่ชื่อคนมอบหมายไว้ในหัวข้อ เหมือนแจ้งเตือน "งานใหม่" ตอนสร้าง event
      const reassignerName = [req.user?.fname, req.user?.lname].filter(Boolean).join(" ") || req.user?.username || "ผู้ดูแลระบบ";
      sendPushToUsers(resPerson, {
        title: `📋 ${reassignerName} มอบหมายงานให้คุณ`,
        body: `📅 ${reassignDateLabel} 🕐 ${reassignTimeLabel} · ${updatedEvent.title || "งาน"} · ${jobLabel}`,
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

    // ✅ เงื่อนไข: admin/manager ลบได้ทุก event, user คนอื่นลบได้เฉพาะของตัวเอง — เดิมเช็คแค่ "admin"
    // เท่านั้น (manager ลบของคนอื่นไม่ได้เลย) ทั้งที่ทุก route ที่เกี่ยวกับสัญญาในไฟล์นี้ให้สิทธิ์
    // admin/manager เท่ากันหมด และหน้า "ภาพรวมสัญญา" ที่เรียก route นี้ก็เปิดให้แค่ admin/manager อยู่แล้ว
    const isAdminOrManager = ["admin", "manager"].includes(req.user.role);
    if (
      !isAdminOrManager &&
      existingEvent.userId.toString() !== userId.toString()
    ) {
      return res.status(403).json({ message: "คุณไม่มีสิทธิ์ลบ Event นี้" });
    }

    // ✅ งานที่ปิดแล้ว (ดำเนินการเสร็จสิ้น) ห้ามช่างลบอีก มีแค่ admin/manager เท่านั้นที่ทำได้
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
