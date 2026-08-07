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

// ✅ จำนวนครั้งสูงสุดต่อสัญญา — ต้องตรงกับ MAX_VISIT_COUNT ฝั่งหน้าจอ (ContractOverview.js) เป๊ะๆ
// ใช้จำกัดเลข "ครั้งที่" ปลายทางตอนย้ายครั้ง (ดู PUT /contract/:contractGroupId/move-round)
const MAX_VISIT_COUNT = 12;
const { sendPushToUsers, sendPushToRoles, sendPushToAllUsers } = require("../services/PushNotify");
// ⚠️ findResPersonConflicts (เช็คช่างชนกัน/double-booking กับงานอื่นในระบบ) ถูกตัดออกจากทุก route
// แล้วตามที่ผู้ใช้ขอ — 1 ทีมรับหลายงานในวันเดียวกันได้ตามปกติ เหลือไว้แค่ findMutualOverlaps (เช็คว่า
// วันที่ที่กรอกมาในคำขอเดียวกันชนกันเองหรือไม่ เช่น หลายวันไม่ติดกันของงานเดียวกันทับกันเอง)
const { findMutualOverlaps } = require("../utils/scheduleConflict");

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

// ✅ "ผู้รับผิดชอบตัวจริง" (effective responsible person) — ใช้กับ "การดำเนินงาน"/"ติดตามใบเสนอราคา"/
// หน้า "ภาพรวมงาน" ของช่าง ที่ผู้ใช้ต้องการให้เป็นสิทธิ์ของ "ผู้รับผิดชอบ" (responsiblePerson) ล้วนๆ
// ไม่ใช่ "ทีมที่เข้างาน" (team) อีกต่อไป — แต่ต้อง fallback ไปที่ team/resPerson เมื่องานนั้นยังไม่เคย
// ถูกตั้งค่าผู้รับผิดชอบแยกไว้เลย (responsiblePerson ว่างเปล่า) ไม่งั้นงานเก่า/งานใหม่ทุกงานที่ยังไม่มี
// ใครไปตั้งค่านี้ให้ชัดเจน จะกลายเป็นไม่มีใครนอกจากแอดมิน/manager เข้าถึงได้เลยทันที (พังงานที่ทำอยู่
// ทุกวันนี้ทั้งหมด) — พอแอดมิน/manager มอบหมาย "ผู้รับผิดชอบ" ให้คนละคนกับทีมที่เข้างานเมื่อไหร่
// (ผ่านหน้า "ภาพรวมงาน") ทีมที่เข้างานเดิมจะหลุดจากสิทธิ์กลุ่มนี้ทันที เหลือแค่ผู้รับผิดชอบคนใหม่เท่านั้น
function effectiveResponsibleOrClauses(userId, fname) {
  const emptyOrMissing = (field) => ({ $or: [{ [field]: { $exists: false } }, { [field]: "" }, { [field]: null }] });
  return [
    { responsiblePersonId: userId },
    { $and: [emptyOrMissing("responsiblePersonId"), { resPerson: userId }] },
    { responsiblePerson: fname },
    { $and: [emptyOrMissing("responsiblePerson"), { team: fname }] },
  ];
}

// ✅ เทียบ pattern เดียวกับ effectiveResponsibleOrClauses ด้านบนเป๊ะๆ แต่ใช้เช็ค document เดียวที่โหลด
// มาแล้ว (ไม่ใช่สร้าง Mongo query) — ใช้กับ route ที่เช็คสิทธิ์ทีละ event เช่น quotation-followup
function isEffectiveResponsiblePerson(event, userId, fname) {
  const hasResponsiblePersonId = Boolean(event.responsiblePersonId);
  const hasResponsiblePerson = Boolean(event.responsiblePerson);
  return (
    (hasResponsiblePersonId ? event.responsiblePersonId === userId : event.resPerson === userId) ||
    (hasResponsiblePerson ? event.responsiblePerson === fname : event.team === fname)
  );
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
      "intervalMonths",
      "jobValue",
      // ✅ เลือกหมวดหมู่ "งานทั่วไป"/"งานโปรเจค" ได้ตั้งแต่ตอนสร้างงานเลย (ขั้นตอนที่ 1 ในฟอร์ม
      // AddEvent.js) แทนที่จะต้องไปกดจัดหมวดหมู่ย้อนหลังทีหลังในหน้า "ภาพรวมงาน" เสมอ
      "jobClassification",
      // ✅ งานทั่วไป/งานโปรเจคที่สร้างจาก AddEvent.js ตั้งผู้สร้างเป็นผู้รับผิดชอบให้อัตโนมัติทันที
      // (ดู payload ฝั่ง frontend) — งานตามสัญญายังคงปล่อยว่างไว้เหมือนเดิม (admin/manager มอบหมายเอง
      // ผ่านหน้า "ภาพรวมงาน" เท่านั้น ฟอร์มฝั่งสัญญาไม่ได้ส่งฟิลด์นี้มาด้วย)
      "responsiblePerson",
      "responsiblePersonId",
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
    // ✅ ใช้ตัดสินว่างานนี้ต้องรอการอนุมัติหรือไม่ (ดู buildEventData ด้านล่าง) และเลือกว่าจะแจ้งเตือน
    // แบบไหน (ดูท้ายฟังก์ชัน) — เทียบ pattern เดียวกับทุก route ที่กันสิทธิ์ไว้เฉพาะแอดมิน/manager
    const isAdminOrManager = ["admin", "manager"].includes(req.user.role);
    // ✅ ใช้ทั้งใน approvalRequestedBy (ด้านล่าง) และหัวข้อแจ้งเตือน — ย้ายมาคำนวณตรงนี้แทนที่จะรอ
    // คำนวณทีหลังตอนจะแจ้งเตือนเหมือนเดิม เพราะ buildEventData ต้องใช้ค่านี้ตั้งแต่ตอนสร้าง record ด้วย
    const creatorName = [req.user?.fname, req.user?.lname].filter(Boolean).join(" ") || req.user?.username || "ผู้ดูแลระบบ";
    const isMultiDate = Array.isArray(dates) && dates.length > 1;
    const jobGroupId = (isMultiDate && !isContractBatch) ? (req.body.jobGroupId || crypto.randomUUID()) : req.body.jobGroupId;
    // ✅ สัญญาต้องได้ contractGroupId แม้มีแค่ครั้งเดียวตอนสร้าง (ยังไม่ได้ลงครั้งที่ 2 ทันที) —
    // ต่างจาก jobGroupId ด้านบนที่ต้องมากกว่า 1 ช่วงจริงๆ ถึงจะผูก เพราะสัญญาคือ 1 หน่วยข้อมูล
    // (เลขที่สัญญา/มูลค่างาน ฯลฯ) ตั้งแต่ครั้งแรกอยู่แล้ว ไม่ต้องรอให้มีครั้งที่ 2 ก่อนถึงจะนับเป็นสัญญา
    const hasContractDates = isContractBatch && Array.isArray(dates) && dates.length >= 1;
    const contractGroupId = hasContractDates ? (req.body.contractGroupId || crypto.randomUUID()) : req.body.contractGroupId;

    // ⚠️ ตัดการเช็คช่างชนกัน (double-booking กับงานอื่นในระบบ) ออกตามที่ผู้ใช้ขอ — 1 ทีมรับหลายงานใน
    // วันเดียวกันได้ตามปกติ ไม่ควรบล็อก ยังคงเหลือแค่เช็ค "ชนกันเอง" ภายในชุดที่กำลังจะสร้างพร้อมกัน
    // (เช่น กรอกวันที่ครั้งที่ 1/3 ทับกันเอง) ไว้ เพราะเป็นการกรอกข้อมูลผิดพลาดจริง ไม่ใช่ double-booking
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
      // ✅ งานที่สร้างโดยคนที่ไม่ใช่แอดมิน/manager (ช่าง/เซล) ต้องรอการอนุมัติก่อนถึงจะถือว่ายืนยันแล้ว
      // จริง — ห้ามรับ approvalStatus จาก client ตรงๆ (ไม่อยู่ใน allowedFields ด้านบนเลย) คำนวณเองจาก
      // role ของผู้เรียกเท่านั้น กันแก้ไข request เองแล้วข้ามการอนุมัติ
      if (isAdminOrManager) {
        eventData.approvalStatus = "approved";
      } else {
        eventData.approvalStatus = "pending";
        eventData.approvalRequestedAt = new Date();
        eventData.approvalRequestedBy = creatorName;
        eventData.approvalRequestedByUserId = req.userId;
      }
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

    // ⚠️ BUG ที่แก้ (เลี่ยง): เดิมแจ้ง "มอบหมายงานใหม่ให้คุณ" + broadcast "เพิ่มงานใหม่เข้าระบบ" ทันที
    // ไม่ว่างานนั้นจะยังรออนุมัติอยู่หรือไม่ — ประกาศงานที่ยังไม่ผ่านการอนุมัติให้ทั้งบริษัทเห็นก่อนใครยืนยัน
    // เป็นเรื่องเข้าใจผิดได้ง่าย (เช่น ช่างเห็นว่าตัวเอง "ถูกมอบหมาย" ทั้งที่งานนั้นอาจโดนตีกลับภายหลัง)
    // — ถ้ายังรออนุมัติ ให้แจ้งเฉพาะแอดมิน/manager ว่ามีงานรออนุมัติแทน ส่วนแจ้งเตือน "มอบหมายงาน" ให้
    // เลื่อนไปแจ้งตอนอนุมัติแล้วจริงๆ (ดู PUT /:id/approval) — งานที่ admin/manager สร้างเอง (ไม่ต้องรอ
    // อนุมัติ) ยังคงพฤติกรรมเดิมทุกประการ
    if (primary.approvalStatus === "pending") {
      sendPushToRoles(["admin", "manager"], {
        title: `⏳ ${creatorName} ส่งงานใหม่รออนุมัติ`,
        body: jobLabelNew,
        url: `/operation/${primary._id}`,
        tag: notifyTag,
        renotify: true,
      }).catch((err) => console.error("❌ Push notify error (approval-request):", err));
    } else {
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
    }

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

    // ✅ ป้อนข้อมูลให้ทั้งหน้า "การดำเนินงาน" และ "ภาพรวมงาน" — ผู้ใช้ต้องการให้สองหน้านี้เป็นสิทธิ์ของ
    // "ผู้รับผิดชอบ" (responsiblePerson) โดยเฉพาะ ไม่ใช่ "ทีมที่เข้างาน" (team) เหมือนเดิมอีกต่อไป —
    // ใช้ effectiveResponsibleOrClauses (fallback ไปที่ team/resPerson เฉพาะงานที่ยังไม่เคยตั้งค่า
    // ผู้รับผิดชอบแยกไว้เลย กันงานเก่า/งานที่ยังไม่ได้มอบหมายผู้รับผิดชอบชัดเจนหายไปจากทุกคนกะทันหัน)
    // บวก userId (คนที่เพิ่ม event นี้เอง ให้เห็นงานที่ตัวเองสร้างไว้เสมอแม้จะไม่ได้เป็นผู้รับผิดชอบ/ทีม)
    // ⚠️ BUG ที่แก้: เดิมเช็คแค่ userRole === "admin" (ไม่รวม manager) ทำให้ manager ถูกกรองเหลือแค่งาน
    // ตัวเองด้วย ทั้งที่ทุกจุดอื่นในไฟล์นี้ให้สิทธิ์ manager เท่า admin — แก้ให้ตรงกัน
    // ✅ ตัดงาน "วางแผนล่วงหน้า" (unscheduled) ออกเสมอ — ยังไม่มีวันที่จริง ไม่ควรปนกับงานที่ลงตารางแล้ว
    const isAdminOrManagerRole = ["admin", "manager"].includes(userRole);
    const query = isAdminOrManagerRole
      ? { unscheduled: { $ne: true } }
      : { unscheduled: { $ne: true }, $or: [
          { userId: userId },
          ...effectiveResponsibleOrClauses(userId, req.user.fname),
        ] };

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
      isContractBatch, contractGroupId, contractNo, quotationNo, contractStart, contractEnd, visitCount, intervalMonths, jobValue,
      // ✅ เลือกหมวดหมู่ "งานทั่วไป"/"งานโปรเจค" ได้ตั้งแต่ตอนสร้างแผนงานเลย (ขั้นตอนที่ 1 ในฟอร์ม
      // AddDraftEvent.js) แทนที่จะต้องไปกดจัดหมวดหมู่ย้อนหลังทีหลังในหน้า "ภาพรวมงาน" เสมอ — ไม่เกี่ยวกับ
      // งานตามสัญญา (isContractBatch) ซึ่งไม่มีแนวคิดหมวดหมู่นี้อยู่แล้ว (เป็นสัญญาจริงเสมอ)
      jobClassification,
      // ✅ ผู้รับผิดชอบงาน — มาได้ 2 ทาง: (1) แผนงานทั่วไป/โปรเจค คนที่เพิ่มเองเป็นผู้รับผิดชอบทันที
      // (ดู payload ฝั่ง AddDraftEvent.js) (2) สัญญาที่สร้างจากฟอร์ม "เพิ่มสัญญาใหม่" ในหน้า "ภาพรวมงาน"
      // ซึ่ง admin/manager เลือกผู้รับผิดชอบไว้ตั้งแต่ตอนสร้าง — ต้องเก็บค่าตรงๆ ที่ส่งมาเท่านั้น ห้าม
      // fallback ไปที่ team เอง เพราะสิทธิ์ที่ผูกกับ "ผู้รับผิดชอบตัวจริง" (แก้ไขทีมรายครั้ง ฯลฯ) เช็คแบบ
      // เข้มงวดว่าต้องมอบหมายไว้ชัดเจนเท่านั้น (ดู rawResponsiblePersonId ฝั่ง frontend)
      responsiblePerson, responsiblePersonId,
    } = req.body;

    if (!site || !title || !system) {
      return res.status(400).json({ message: "กรุณาระบุชื่อโครงการ/ประเภทงาน/ระบบงาน" });
    }

    // ✅ ระยะห่างระหว่างรอบ (intervalMonths) เป็นข้อมูลอ้างอิงสำหรับเตือน "เกินกำหนด" เท่านั้น — ไม่ใช่
    // ฟิลด์บังคับ ไม่ต้องมีช่วงสัญญาครบก็สร้างสัญญาได้เหมือนเดิม (งานจริงเลื่อน/ชนกันได้เสมอ ให้ผู้ใช้
    // กำหนดวันที่/จำนวนครั้งเองทั้งหมด) เช็คแค่ความถูกต้องของค่านี้เองถ้ามีการระบุมา
    if (intervalMonths !== undefined && intervalMonths !== "" && intervalMonths !== null) {
      const n = Number(intervalMonths);
      if (!n || n < 1 || n > 24) {
        return res.status(400).json({ message: "ระยะห่างระหว่างรอบต้องอยู่ระหว่าง 1-24 เดือน" });
      }
    }

    // ✅ ห้ามใส่จำนวนครั้งทั้งหมดเกิน 12 — เทียบ pattern เดียวกับ intervalMonths ด้านบน (เช็คซ้ำฝั่ง
    // backend เสมอ ไม่พึ่งฝั่งจอเช็คอย่างเดียว) กันตาราง "ภาพรวมงาน" เรนเดอร์คอลัมน์ "ครั้งที่ N"
    // เกินจำเป็นจนหน้าพัง (ดู maxVisitCount ใน ContractOverview.js)
    if (visitCount !== undefined && visitCount !== "" && visitCount !== null) {
      const n = Number(visitCount);
      if (!n || n < 1 || n > 12) {
        return res.status(400).json({ message: "จำนวนครั้งทั้งหมดต้องอยู่ระหว่าง 1-12 ครั้ง" });
      }
    }

    // ✅ แผนงานที่สร้างโดยคนที่ไม่ใช่แอดมิน/manager (ช่าง/เซล) ต้องรอการอนุมัติก่อน เทียบ pattern
    // เดียวกับ POST / (สร้างงานแบบมีวันที่ทันที) เป๊ะๆ — ดูเหตุผลที่คอมเมนต์ตรงนั้น
    const isAdminOrManager = ["admin", "manager"].includes(req.user.role);
    const creatorName = [req.user?.fname, req.user?.lname].filter(Boolean).join(" ") || req.user?.username || "ผู้ดูแลระบบ";

    // ⚠️ BUG ที่แก้: เดิมสัญญาฉบับร่างที่ไม่ได้ส่ง plannedMonth มา (ฟอร์ม "เพิ่มสัญญาใหม่" ในหน้า
    // "ภาพรวมงาน" ไม่มีช่องนี้เลย) จะถูก "เดา" เดือนให้เองเสมอ — จากวันที่เริ่มสัญญา ไม่งั้นใช้เดือน
    // ปัจจุบัน — ทำให้สัญญาที่ผู้ใช้ตั้งใจสร้างเป็น "สัญญาเปล่า ยังไม่มีวันที่" กลายเป็นมีเดือนติดมาเอง
    // แล้วไปโผล่ในแผง/วิดเจ็ต "งานวางแผนล่วงหน้า" เหมือนถูกวางแผนไว้เดือนนั้นจริงๆ ทั้งที่ยังไม่เคยมีใคร
    // ระบุ — ตอนนี้เก็บเฉพาะค่าที่ผู้ใช้ระบุมาจริงเท่านั้น ไม่ระบุมาก็ปล่อยว่างไว้ (สัญญาเปล่าจริงๆ)
    // ค่อยไปลงวันที่ครั้งที่ 1 ทีหลังผ่านปุ่มในตาราง "ภาพรวมงาน" (ดู handleAddVisitSubmit ซึ่งแปลง
    // ฉบับร่างนี้เป็นครั้งที่ 1 จริงผ่าน PUT /:id/schedule)
    // ⚠️ ยังบังคับสำหรับแผนงานทั่วไป/โปรเจคเหมือนเดิม — ฟอร์ม AddDraftEvent.js มีช่องให้เลือกเดือนอยู่แล้ว
    // และแผงงานล่วงหน้าในปฏิทินจัดกลุ่มการ์ดตามเดือนนี้ ถ้าว่างจะไม่มีที่อยู่ให้แสดง (ต่างจากสัญญาซึ่ง
    // ไม่โผล่ในแผงนั้นอยู่แล้ว — ดู visibleDrafts ใน EventCalendar/index.js)
    const resolvedPlannedMonth = plannedMonth || undefined;
    if (!isContractBatch && !resolvedPlannedMonth) {
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
      responsiblePerson: responsiblePerson || undefined,
      responsiblePersonId: responsiblePersonId || undefined,
      unscheduled: true,
      plannedMonth: resolvedPlannedMonth,
      // ✅ ให้ค่าเริ่มต้นเสมอ (schema บังคับ required) แทนสีที่ผู้ใช้เลือกจริงตอนลงตาราง — ใช้สีม่วงคราม
      // #6366f1 สื่อว่า "งานใหม่" (เดิมใช้สีแดงธีมแอป แต่สีแดงตอนนี้ถูกใช้สื่อ "ไม่อนุมัติ"/วันหยุด
      // ราชการไปแล้วในปฏิทิน ทำให้แผนงานใหม่ปนกับสองอย่างนั้นจนแยกไม่ออก — เทียบสีเดียวกับ
      // EventCalendar/index.js defaultBackgroundColor และไอคอนแจ้งเตือน "งานใหม่" ใน NotificationBell.js)
      backgroundColor: backgroundColor || "#6366f1",
      textColor: textColor || "#ffffff",
      fontSize: fontSize || 8,
      userId: req.userId,
      // 🐛 BUG ที่แก้ (กรอกมูลค่างานตอนสร้างสัญญาแล้วไม่ขึ้นในตาราง): jobValue ถูก destructure จาก
      // req.body ไว้แล้ว (ดูด้านบน) แต่ตกหล่นไม่ได้ถูกเขียนลง document เลยสักครั้ง — ค่าที่ผู้ใช้กรอก
      // จึงหายไปเงียบๆ ทุกครั้งที่สร้าง "สัญญาเปล่า" (ไม่ระบุวันที่ครั้งที่ 1 ซึ่งเป็นเส้นทางปกติ)
      // ⚠️ เส้นทางที่ระบุวันที่มาด้วยไม่เจอปัญหานี้ เพราะไปทาง POST / ซึ่งมี jobValue ใน allowedFields
      // อยู่แล้ว — ผู้ใช้เลยเจออาการ "บางทีก็ขึ้น บางทีก็ไม่ขึ้น" แล้วแต่ว่ากรอกวันที่มาหรือเปล่า
      ...(isContractBatch ? {
        contractGroupId: contractGroupId || crypto.randomUUID(),
        contractNo, quotationNo, contractStart, contractEnd, intervalMonths, visitCount, jobValue,
      } : (jobClassification ? { jobClassification } : {})),
      // ✅ ห้ามรับ approvalStatus จาก client ตรงๆ (ไม่อยู่ใน destructure ด้านบนเลย) คำนวณเองจาก role
      // ของผู้เรียกเท่านั้น — เทียบ pattern เดียวกับ POST / (buildEventData) เป๊ะๆ
      ...(isAdminOrManager
        ? { approvalStatus: "approved" }
        : {
            approvalStatus: "pending",
            approvalRequestedAt: new Date(),
            approvalRequestedBy: creatorName,
            approvalRequestedByUserId: req.userId,
          }),
    }).save();

    // ✅ เดิม route นี้ไม่แจ้งเตือนเลย — แจ้งแอดมิน/manager เฉพาะตอนรออนุมัติ (เทียบ pattern เดียวกับ
    // POST / เป๊ะๆ) ใช้ deep-link ?draft=<id>&month=<เดือน> ที่ EventCalendar/index.js เปิดฟังอยู่แล้ว
    // (ใช้เปิดแผงงานล่วงหน้าไปที่แผนงานนี้โดยตรง ไม่ต้องเพิ่ม routing ฝั่ง frontend เลย)
    // ⚠️ ยกเว้นฉบับร่างของ "สัญญา" — ไม่โผล่ในแผงงานล่วงหน้าของปฏิทินเลย (ดู visibleDrafts ใน
    // EventCalendar/index.js) deep-link นั้นจึงพาไปหน้าที่ไม่มีการ์ดนี้อยู่ ต้องส่งไปหน้า "ภาพรวมงาน"
    // ซึ่งเป็นที่เดียวที่จัดการสัญญาฉบับร่างได้จริงแทน — และเดือนอาจว่างได้แล้ว (สัญญาเปล่า) จึงไม่ต่อ
    // ท้ายข้อความ/URL ถ้าไม่มีค่า กัน "เดือน undefined" โผล่ในแจ้งเตือน
    if (draft.approvalStatus === "pending") {
      const monthSuffix = resolvedPlannedMonth ? ` · เดือน ${resolvedPlannedMonth}` : "";
      sendPushToRoles(["admin", "manager"], {
        title: `⏳ ${creatorName} ส่งแผนงานล่วงหน้ารออนุมัติ`,
        body: `${draft.title || "งาน"} · ${draft.company || "-"}${draft.site ? " - " + draft.site : ""}${monthSuffix}`,
        url: draft.contractGroupId
          ? "/contracts"
          : `/event?draft=${draft._id}${resolvedPlannedMonth ? `&month=${resolvedPlannedMonth}` : ""}`,
        tag: `approval-draft-${draft._id}`,
        renotify: true,
      }).catch((err) => console.error("❌ Push notify error (approval-request-draft):", err));
    }

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

    // ✅ ป้อนแผงงานล่วงหน้าให้ทั้งหน้า "การดำเนินงาน"/"ภาพรวมงาน" — เทียบ pattern เดียวกับ GET /event-op
    // เป๊ะๆ (ดูคอมเมนต์ละเอียดที่นั่น) สิทธิ์เป็นของ "ผู้รับผิดชอบ" ไม่ใช่ "ทีมที่เข้างาน" อีกต่อไป
    const query = isAdminOrManager
      ? { unscheduled: true }
      : { unscheduled: true, $or: [
          { userId: userId },
          ...effectiveResponsibleOrClauses(userId, req.user.fname),
        ] };

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
// ✅ ไม่บล็อกการ "ลงตาราง" งานที่ยังรออนุมัติ/ถูกปฏิเสธ (approvalStatus ไม่ใช่ "approved") ตามที่ผู้ใช้
// ขอไว้ — ปล่อยให้ลงตารางได้ตามปกติ ค่า approvalStatus/approvalRequestedBy/ฯลฯ ของ existingEvent จะ
// ยังคงอยู่ในเอกสารเดิมโดยอัตโนมัติต่อไป (route นี้ mutate เฉพาะ field ที่แก้ไว้ด้านล่างเท่านั้น ไม่ใช่
// full replace) งานจึงยังคงขึ้นเป็น "รออนุมัติ"/"ถูกปฏิเสธ" ต่อไปแม้จะมีวันที่จริงแล้วก็ตาม จนกว่าแอดมิน/
// manager จะกดอนุมัติที่ PUT /:id/approval
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

    // ⚠️ ตัดการเช็คช่างชนกัน (double-booking กับงานอื่นในระบบ) ออกตามที่ผู้ใช้ขอ — 1 ทีมรับหลายงานใน
    // วันเดียวกันได้ตามปกติ ไม่ควรบล็อก ยังคงเหลือแค่เช็ค "ชนกันเอง" ภายในชุดวันที่หลายวันไม่ติดกันของ
    // งานเดียวกันไว้ (เป็นการกรอกข้อมูลผิดพลาดจริง ไม่ใช่ double-booking)
    const rangesToCheck = isMultiDate ? dates.filter((d) => d && d.start && d.end) : [{ start: start || date, end: end || date }];
    if (isMultiDate && rangesToCheck.length > 0) {
      const mutualConflicts = findMutualOverlaps(rangesToCheck);
      if (mutualConflicts.length > 0) {
        const [a, b] = mutualConflicts[0];
        return res.status(409).json({
          message: `วันที่ที่กรอกทับกันเอง (${moment(a.start).locale("th").format("D MMM YYYY")} กับ ${moment(b.start).locale("th").format("D MMM YYYY")}) กรุณาตรวจสอบวันที่แต่ละครั้งอีกครั้ง`,
        });
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

    // ✅ แก้ไขแผนงานที่ถูกปฏิเสธไปแล้วถือเป็นการส่งขออนุมัติใหม่อัตโนมัติ — route นี้เขียนฟิลด์เนื้อหา
    // งานทุกช่องอยู่แล้วทุกครั้งที่เรียก (ไม่มีการแก้ไขบางส่วน) จึงถือว่าทุกครั้งที่เจ้าของ/ผู้ถูกมอบหมาย
    // (ไม่ใช่แอดมิน/manager) บันทึกสำเร็จคือ "แก้ไขแล้วส่งใหม่" เทียบ pattern เดียวกับ PUT /:id
    let resubmitted = false;
    if (existingEvent.approvalStatus === "rejected" && !isAdminOrManager) {
      existingEvent.approvalStatus = "pending";
      existingEvent.approvalRequestedAt = new Date();
      existingEvent.approvalRequestedBy = [req.user?.fname, req.user?.lname].filter(Boolean).join(" ") || req.user?.username || "ผู้ดูแลระบบ";
      existingEvent.approvalRequestedByUserId = req.userId;
      existingEvent.approvalDecidedAt = null;
      existingEvent.approvalDecidedBy = "";
      resubmitted = true;
    }

    await existingEvent.save();

    if (resubmitted) {
      sendPushToRoles(["admin", "manager"], {
        title: `🔄 ${existingEvent.approvalRequestedBy} แก้ไขแผนงานที่ถูกตีกลับ ส่งขออนุมัติใหม่`,
        body: `${existingEvent.title || "งาน"} · ${existingEvent.company || "-"}${existingEvent.site ? " - " + existingEvent.site : ""}`,
        // ⚠️ เหมือน POST /draft: ฉบับร่างของ "สัญญา" ไม่โผล่ในแผงงานล่วงหน้าของปฏิทินแล้ว (ดู
        // visibleDrafts) ลิงก์ ?draft= จะพาไปหน้าที่ไม่มีการ์ดนี้อยู่ ต้องส่งไปหน้า "ภาพรวมงาน" แทน —
        // และ plannedMonth ว่างได้แล้ว (สัญญาเปล่า) จึงต้องไม่ต่อท้าย URL เป็น "month=undefined"
        url: existingEvent.contractGroupId
          ? "/contracts"
          : `/event?draft=${existingEvent._id}${existingEvent.plannedMonth ? `&month=${existingEvent.plannedMonth}` : ""}`,
        tag: `approval-resubmit-draft-${existingEvent._id}`,
        renotify: true,
      }).catch((err) => console.error("❌ Push notify error (approval-resubmit-draft):", err));
    }

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
    // ❌ งานที่ยังรออนุมัติ ช่างทำอะไรไม่ได้เลย (เทียบ pattern เดียวกับ PUT /:id) — เปิดดูได้อย่างเดียว
    if ((existingEvent.approvalStatus || "approved") === "pending" && !isAdminOrManager) {
      return res.status(403).json({ message: "งานนี้ยังไม่ได้รับการอนุมัติ ดูข้อมูลได้อย่างเดียว แก้ไขไม่ได้จนกว่าจะอนุมัติหรือไม่อนุมัติก่อน" });
    }
    // ❌ งานที่ปิดแล้ว (ดำเนินการเสร็จสิ้น) ห้ามย้ายกลับไปแผนล่วงหน้าเด็ดขาด ไม่มีข้อยกเว้นแม้แต่ admin/
    // manager — ต่างจากจุดล็อกอื่นๆ ในไฟล์นี้ (แก้ไข/อัปโหลดไฟล์/ลบไฟล์) ที่ยกเว้นให้ admin/manager
    // เพราะจุดเหล่านั้นแก้ไข "ข้อมูลของงานเดิม" เท่านั้น แต่ unschedule ไปเคลียร์ date/start/end ทิ้ง
    // (ดูด้านล่าง) โดยไม่แตะ status เลย ทำให้เกิดสถานะขัดแย้งกันเอง: "แผนงานล่วงหน้า" ที่ status ยังเป็น
    // "ดำเนินการเสร็จสิ้น" อยู่ ซึ่งไม่มีเหตุผลใดที่ควรเกิดขึ้นได้จริง จึงต้องปิดเด็ดขาด ไม่ใช่แค่จำกัดสิทธิ์
    if (existingEvent.status === "ดำเนินการเสร็จสิ้น") {
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
    const isAdminOrManager = ["admin", "manager"].includes(req.user.role);
    const isOwner = existingEvent.userId.toString() === userId.toString();
    const isResponsible = isEffectiveResponsiblePerson(existingEvent, userId, req.user.fname);
    if (!isAdminOrManager && !isOwner && !isResponsible) {
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
      : { unscheduled: { $ne: true }, $or: [
          { resPerson: userId }, { team: req.user.fname }, { userId: userId },
          { responsiblePersonId: userId }, { responsiblePerson: req.user.fname },
        ] };

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

    // 🐛 BUG ที่แก้ (ปฏิทินพังทั้งหน้าถ้ามี event สักตัวที่ไม่มี userId): userId ใน schema ไม่ได้เป็น
    // required — งานที่หลุดมาโดยไม่มี userId (ข้อมูลเก่า/นำเข้า/สร้างผ่านทางอื่น) จะทำให้
    // event.userId.toString() โยน TypeError → 500 ทั้ง endpoint → ปฏิทินโหลดไม่ขึ้นเลยสำหรับทุกคน
    // เพราะงานเสียแค่ตัวเดียว — กันด้วย optional chaining แล้วข้ามเฉพาะตัวที่ไม่มีไปเงียบๆ
    const uniqueUserIds = [...new Set(userEvents.map((e) => e.userId?.toString()).filter(Boolean))];

    const users = await User.find({ _id: { $in: uniqueUserIds } }).lean();

    const userMap = new Map();
    users.forEach((user) => {
      userMap.set(user._id.toString(), user);
    });

    const updatedUserEvents = userEvents.map((event) => {
      const user = event.userId ? userMap.get(event.userId.toString()) : null;
      if (user) {
        const { _id, password, ...userDataWithoutId } = user;
        return { ...event, user: userDataWithoutId };
      }
      return event;
    });

    // 🐛 BUG ที่แก้ (ไม่มีงานเลย = วันหยุดหายทั้งปฏิทิน): เดิมตอบ 404 เมื่อยังไม่มีงานสักรายการ ซึ่งไม่ใช่
    // ข้อผิดพลาด — "ยังไม่มีงาน" เป็นผลลัพธ์ที่ถูกต้อง — axios ฝั่งจอจะ throw ทำให้ Promise.all ใน
    // getFetchEvents (ที่ดึงงาน + วันหยุดราชการพร้อมกัน) reject ทั้งก้อน วันหยุดที่ดึงมาสำเร็จแล้วจึงถูก
    // ทิ้งไปด้วย ปฏิทินเลยว่างสนิทไม่มีแม้แต่วันหยุด + ขึ้น error ใน console ทุก 30 วินาทีจาก polling
    // ✅ ตอบ 200 พร้อม array ว่างตามหลัก REST — ฝั่งจอจัดการเคสว่างได้อยู่แล้ว
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

    // ⚠️ BUG ที่แก้: เดิมรับ eventIds (array แบนๆ) แล้วให้แต่ละ document กลายเป็นคนละ "ครั้งที่" เสมอ
    // (idx+1 ต่อ document) — แต่ "งานทั่วไป" ที่เข้าหลายวันไม่ติดกัน (ผูกกันด้วย jobGroupId เดียวกัน)
    // 1 แถวในตารางอาจมีหลาย document ที่ควรรวมเป็น "ครั้งเดียวกัน" ไม่ใช่แยกคนละครั้ง — เปลี่ยนมารับ
    // rounds เป็น array ของ array (แต่ละกลุ่มย่อย = document ทั้งหมดที่ควรอยู่ครั้งเดียวกัน) แทน
    const { rounds, contractNo, quotationNo, contractStart, contractEnd, visitCount, intervalMonths, jobValue } = req.body;
    if (!Array.isArray(rounds) || rounds.length === 0 || rounds.some((r) => !Array.isArray(r) || r.length === 0)) {
      return res.status(400).json({ message: "กรุณาเลือกงานอย่างน้อย 1 รายการ" });
    }
    // ✅ ห้ามใส่จำนวนครั้งทั้งหมดเกิน 12 — เทียบ pattern เดียวกับ PUT /contract/:contractGroupId
    if (Number(visitCount) > 12) {
      return res.status(400).json({ message: "จำนวนครั้งทั้งหมดต้องไม่เกิน 12 ครั้ง" });
    }

    const allEventIds = rounds.flat();
    const events = await CalendarEvent.find({ _id: { $in: allEventIds } });
    if (events.length !== allEventIds.length) {
      return res.status(404).json({ message: "ไม่พบบางรายการที่เลือก อาจถูกลบหรือแก้ไขไปแล้ว" });
    }
    const eventsById = new Map(events.map((e) => [String(e._id), e]));

    // ✅ ห้ามเลขที่สัญญาซ้ำกับสัญญาอื่น — งานเก่าที่กำลังจะรวมนี้ยังไม่มี contractGroupId เลย
    // (ไม่ต้อง exclude อะไร) เจอที่ไหนก็ถือว่าซ้ำหมด
    if (contractNo) {
      const dupContractNo = await findDuplicateContractNo(contractNo);
      if (dupContractNo) {
        return res.status(409).json({ message: `เลขที่สัญญา "${contractNo}" ถูกใช้ไปแล้ว กรุณาตรวจสอบ` });
      }
    }

    const contractGroupId = crypto.randomUUID();
    // ✅ เรียง "ครั้งที่" ตามวันที่เริ่มเร็วสุดของแต่ละกลุ่ม (ไม่ใช่ตามลำดับที่เลือกในหน้าจอ)
    const sortedRounds = rounds.slice().sort((a, b) => {
      const aStart = Math.min(...a.map((id) => new Date(eventsById.get(String(id)).start).getTime()));
      const bStart = Math.min(...b.map((id) => new Date(eventsById.get(String(id)).start).getTime()));
      return aStart - bStart;
    });
    const resolvedVisitCount = Number(visitCount) > 0 ? Number(visitCount) : sortedRounds.length;

    const updated = (
      await Promise.all(
        sortedRounds.map(async (docIds, idx) => {
          const time = String(idx + 1);
          // ✅ กลุ่มที่มีมากกว่า 1 document (งานเข้าหลายวันไม่ติดกัน) ต้องผูก jobGroupId เดียวกันไว้
          // ด้วย — ใช้ตัวที่มีอยู่แล้วก่อน (เผื่อมีมาจากตอนสร้างเป็นงานทั่วไป) ไม่มีค่อยสุ่มใหม่
          let jobGroupId;
          if (docIds.length > 1) {
            const existingJobGroupId = docIds.map((id) => eventsById.get(String(id)).jobGroupId).find(Boolean);
            jobGroupId = existingJobGroupId || crypto.randomUUID();
          }
          return Promise.all(
            docIds.map((id) =>
              CalendarEvent.findByIdAndUpdate(
                id,
                {
                  $set: {
                    contractGroupId,
                    contractNo: contractNo || "",
                    quotationNo: quotationNo || "",
                    contractStart: contractStart || undefined,
                    contractEnd: contractEnd || undefined,
                    intervalMonths: Number(intervalMonths) > 0 ? Number(intervalMonths) : undefined,
                    visitCount: resolvedVisitCount,
                    jobValue: jobValue != null && jobValue !== "" ? Number(jobValue) : undefined,
                    time,
                    ...(jobGroupId ? { jobGroupId } : {}),
                  },
                },
                { new: true }
              )
            )
          );
        })
      )
    ).flat();

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
    // ⚠️ BUG ที่แก้: เดิมรับ eventId เดี่ยวๆ — แต่ "งานทั่วไป" ที่เข้าหลายวันไม่ติดกัน (ผูกกันด้วย
    // jobGroupId เดียวกัน) 1 แถวในตารางอาจมีหลาย document ต้องย้ายเข้าสัญญาพร้อมกันทั้งหมด ไม่งั้น
    // วันอื่นๆ ของงานเดียวกันจะค้างเป็นงานทั่วไปแยกจากสัญญาที่เพิ่งย้ายไป
    const { eventIds, time } = req.body;
    if (!Array.isArray(eventIds) || eventIds.length === 0 || time === undefined || time === null || time === "") {
      return res.status(400).json({ message: "กรุณาระบุงานและครั้งที่ที่ต้องการย้ายเข้า" });
    }

    const targets = await CalendarEvent.find({ _id: { $in: eventIds } });
    if (targets.length !== eventIds.length) {
      return res.status(404).json({ message: "ไม่พบงานที่ต้องการย้ายบางรายการ" });
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

    // ✅ งานที่กำลังย้ายเองอาจมีอยู่แล้วหลาย document ผูกกันด้วย jobGroupId เดิม (เข้าหลายวันไม่ต่อเนื่อง
    // มาก่อนตั้งแต่ตอนยังเป็นงานทั่วไป) — ถ้าครั้งปลายทางมีคนครองอยู่ก่อนด้วย ต้องรวมเป็น jobGroupId
    // เดียวกันทั้งฝั่งเดิมและฝั่งใหม่ ไม่ให้กลายเป็นสอง jobGroupId ปนกันในครั้งเดียวกัน
    const ownJobGroupId = targets.map((t) => t.jobGroupId).find(Boolean);

    let jobGroupId;
    if (scheduledRoundDocs.length > 0) {
      const holder = scheduledRoundDocs.find((v) => v.jobGroupId) || scheduledRoundDocs[0];
      jobGroupId = holder.jobGroupId || ownJobGroupId || crypto.randomUUID();
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
      // ✅ เก็บ jobGroupId เดิมของกลุ่มไว้ถ้ามี (งานทั่วไปที่เข้าหลายวันไม่ติดกันมาก่อนแล้ว) ไม่ต้อง
      // สุ่มใหม่ถ้ามีแค่ document เดียว (undefined ก็ปล่อยว่างไว้ตามเดิม ไม่ผูก jobGroupId ให้เปล่าๆ)
      jobGroupId = ownJobGroupId;
    }

    await CalendarEvent.updateMany(
      { _id: { $in: eventIds } },
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
      }
    );
    const updated = await CalendarEvent.find({ _id: { $in: eventIds } });

    res.json({ events: updated });
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

// ✅ ย้าย "ครั้งที่ N" ไปเป็นครั้งที่อื่นในสัญญาเดียวกัน — ย้ายยกทั้งครั้ง (ทุก document ของครั้งนั้น
// พร้อมกัน: วันที่/สถานะ/ทีม/ประวัติงานทั้งหมดติดไปด้วยครบ ไม่ได้ย้ายแค่ตัวเลข) ใช้แก้กรณีลงครั้งผิดลำดับ
// หรืองานเลื่อน/สลับรอบกัน ซึ่งเกิดขึ้นประจำในงานจริง
// ⚠️ ถ้าปลายทางมีครั้งอยู่แล้ว = "สลับที่กัน" (swap) ไม่ใช่เขียนทับ — ข้อมูลของทั้งสองครั้งต้องอยู่ครบ
// เสมอ ห้ามมีทางที่กดผิดแล้วข้อมูลหายถาวรโดยไม่มีอะไรเตือน
router.put("/contract/:contractGroupId/move-round", verifyToken, async (req, res) => {
  try {
    if (!["admin", "manager"].includes(req.user.role)) {
      return res.status(403).json({ message: "เฉพาะแอดมิน/manager เท่านั้นที่ย้ายครั้งที่ได้" });
    }
    const { contractGroupId } = req.params;
    const { fromTime, toTime } = req.body;
    if (fromTime === undefined || fromTime === null || fromTime === "" ||
        toTime === undefined || toTime === null || toTime === "") {
      return res.status(400).json({ message: "กรุณาระบุครั้งที่ต้นทางและปลายทาง" });
    }
    const from = Number(fromTime);
    const to = Number(toTime);
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < 1 || to > MAX_VISIT_COUNT) {
      return res.status(400).json({ message: `ครั้งที่ต้องเป็นจำนวนเต็มระหว่าง 1-${MAX_VISIT_COUNT}` });
    }
    if (from === to) {
      return res.status(400).json({ message: "ครั้งที่ต้นทางและปลายทางเป็นครั้งเดียวกัน" });
    }

    // ✅ เก็บ _id ไว้ล่วงหน้าทั้งสองฝั่งก่อนเริ่มแก้ไข — สำคัญมาก เพราะหลังอัปเดตขั้นแรก ค่า time จะซ้ำกัน
    // ชั่วขณะ (ทั้งต้นทางและปลายทางเป็นเลขเดียวกัน) ถ้าขั้นที่สองไปค้นด้วย time อีกทีจะจับได้ทั้งสองก้อน
    // ปนกันจนสลับผิด — อ้างอิงด้วย _id ที่จับไว้ตั้งแต่ต้นเท่านั้นจึงจะแม่นยำเสมอ
    const [sourceDocs, targetDocs] = await Promise.all([
      CalendarEvent.find({ contractGroupId, time: String(from) }).select("_id").lean(),
      CalendarEvent.find({ contractGroupId, time: String(to) }).select("_id").lean(),
    ]);
    if (sourceDocs.length === 0) {
      return res.status(404).json({ message: `ไม่พบครั้งที่ ${from} ในสัญญานี้` });
    }
    const sourceIds = sourceDocs.map((d) => d._id);
    const targetIds = targetDocs.map((d) => d._id);

    await CalendarEvent.updateMany({ _id: { $in: sourceIds } }, { $set: { time: String(to) } });
    if (targetIds.length > 0) {
      await CalendarEvent.updateMany({ _id: { $in: targetIds } }, { $set: { time: String(from) } });
    }

    res.json({
      success: true,
      swapped: targetIds.length > 0,
      movedCount: sourceIds.length,
      swappedCount: targetIds.length,
    });
  } catch (error) {
    console.error("❌ Error moving contract round:", error);
    res.status(500).send("Internal Server Error");
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

    const updated = await CalendarEvent.findByIdAndUpdate(
      id,
      { $set: { jobClassification: classification } },
      { new: true }
    );
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

    // ✅ ข้อมูลสัญญา (เลขที่สัญญา/ใบเสนอราคา/วันที่/จำนวนครั้ง/มูลค่างาน) เป็นข้อมูลเชิงบริหาร/การเงิน
    // เฉพาะแอดมิน/manager เท่านั้นที่แก้ได้ — ไม่ใช้เกณฑ์เจ้าของ/ผู้ได้รับมอบหมายเหมือน route อื่นๆ ใน
    // ไฟล์นี้ เพราะที่นี่แก้ "ทั้งสัญญา" พร้อมกันทุกครั้ง (updateMany ด้านล่าง) ผิดพลาดแล้วกระทบทุกครั้ง
    // ที่ผูกสัญญาเดียวกันทันที ต่างจากแก้ไขงานรายครั้งปกติที่กระทบแค่ record เดียว (ดู EditEvent.js
    // ที่ตอนนี้แสดงข้อมูลสัญญาแบบดูอย่างเดียว/disabled ให้ช่างแล้วเช่นกัน)
    const isAdminOrManager = ["admin", "manager"].includes(req.user.role);
    if (!isAdminOrManager) {
      return res.status(403).json({ message: "คุณไม่มีสิทธิ์แก้ไขข้อมูลสัญญานี้" });
    }

    // ✅ team/resPerson (ทีมที่เข้างาน) และ responsiblePerson/responsiblePersonId (ผู้รับผิดชอบ —
    // คนละแนวคิดกัน ดูคอมเมนต์ที่ schema) เพิ่มเข้ามาให้แก้ผ่านทั้งสัญญาพร้อมกันทุกครั้งเหมือนฟิลด์
    // สัญญาอื่นๆ ด้านล่าง (เดิม route นี้แก้ได้แค่ข้อมูลสัญญา ไม่รวมสองอย่างนี้ ซึ่งจริงๆ ก็ควรผูกกับ
    // สัญญาทั้งก้อนเหมือนกัน ไม่ใช่รายครั้ง — ดูหน้า "ภาพรวมสัญญา" ที่แก้ inline ผ่านตารางได้เลย)
    const {
      contractNo, quotationNo, contractStart, contractEnd, visitCount, intervalMonths, jobValue,
      team, resPerson, responsiblePerson, responsiblePersonId,
    } = req.body;

    // ✅ ห้ามเลขที่สัญญาซ้ำกับสัญญาอื่น — excludeContractGroupId เป็นตัวเอง เพราะทุกครั้งในสัญญานี้
    // มี contractNo เดิมอยู่แล้วโดยตั้งใจ (ไม่ถือว่าซ้ำ)
    if (contractNo !== undefined) {
      const dupContractNo = await findDuplicateContractNo(contractNo, contractGroupId);
      if (dupContractNo) {
        return res.status(409).json({ message: `เลขที่สัญญา "${contractNo}" ถูกใช้ไปแล้ว กรุณาตรวจสอบ` });
      }
    }

    if (intervalMonths !== undefined && intervalMonths !== "" && intervalMonths !== null) {
      const n = Number(intervalMonths);
      if (!n || n < 1 || n > 24) {
        return res.status(400).json({ message: "ระยะห่างระหว่างรอบต้องอยู่ระหว่าง 1-24 เดือน" });
      }
    }

    const update = {};
    if (contractNo !== undefined) update.contractNo = contractNo;
    if (quotationNo !== undefined) update.quotationNo = quotationNo;
    if (contractStart !== undefined) update.contractStart = contractStart;
    if (contractEnd !== undefined) update.contractEnd = contractEnd;
    // ✅ ระยะห่างระหว่างรอบ — ใช้เป็นข้อมูลอ้างอิงสำหรับเตือน "เกินกำหนดรอบถัดไป" เท่านั้น (ดู
    // checkAndNotifyOverdueContracts/nextVisitOverdueInfo) ไม่ผูก/คำนวณทับ visitCount ให้เอง เพราะ
    // งานจริงเลื่อน/ชนกันได้เสมอ จำนวนครั้งจริงต้องให้ผู้ใช้เป็นคนกำหนดเองเท่านั้น
    if (intervalMonths !== undefined) update.intervalMonths = intervalMonths;
    if (visitCount !== undefined) {
      // ✅ ห้ามใส่จำนวนครั้งทั้งหมดเกิน 12 — ป้องกันไม่ให้ตาราง "ภาพรวมงาน" ต้องเรนเดอร์คอลัมน์
      // "ครั้งที่ N" เกินจำเป็น (maxVisitCount ในหน้านั้นคำนวณจากค่าสูงสุดของทุกแถวที่กรองอยู่ ถ้ามี
      // สัญญาไหนตั้งไว้สูงมากๆ ตารางทั้งหน้าจะกว้างจนพังไปด้วย) เทียบ pattern เดียวกับ intervalMonths
      // ด้านบนที่ backend เช็คซ้ำอีกชั้นเสมอ ไม่พึ่งฝั่งจอเช็คอย่างเดียว
      if (Number(visitCount) > 12) {
        return res.status(400).json({ message: "จำนวนครั้งทั้งหมดต้องไม่เกิน 12 ครั้ง" });
      }
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
    if (responsiblePerson !== undefined) update.responsiblePerson = responsiblePerson;
    if (responsiblePersonId !== undefined) update.responsiblePersonId = responsiblePersonId;

    await CalendarEvent.updateMany({ contractGroupId }, { $set: update });
    const updatedEvents = await CalendarEvent.find({ contractGroupId }).lean();
    res.json({ events: updatedEvents });
  } catch (error) {
    console.error("❌ Error updating contract fields:", error);
    res.status(500).send("Internal Server Error");
  }
});

// ✅ แก้ไขบริษัท/โครงการ/ระบบ/ประเภทงาน พร้อมกันทุก document ของ "แถว" เดียวกันในหน้า "ภาพรวมงาน"
// (ทั้งสัญญาจริง — ทุกครั้งที่ผูก contractGroupId เดียวกัน — และงานทั่วไป/โปรเจค/ยังไม่จัดกลุ่มที่อาจ
// เข้าหลายวันไม่ติดกัน ผูกด้วย jobGroupId เดียวกัน) รับ eventIds ตรงๆ จาก frontend (ซึ่งรู้อยู่แล้วว่า
// แถวนี้ประกอบด้วย document ไหนบ้างจาก groupEventsByContract) แทนที่จะคำนวณ query เองซ้ำฝั่งนี้
// ⚠️ ต้องประกาศ "ก่อน" PUT /:id (path 1 segment เหมือนกัน "basic-info" vs ":id") ไม่งั้น Express จะจับ
// "basic-info" เป็นค่า :id ไปแทน route นี้จะไม่มีทางถูกเรียกถึงเลย (เทียบปัญหาเดียวกับ /contract/merge
// ที่ต้องมาก่อน /contract/:contractGroupId ด้านบน)
router.put("/basic-info", verifyToken, async (req, res) => {
  try {
    // ✅ docNo/team/resPerson/responsiblePerson เพิ่มเข้ามาให้แก้ไขผ่าน route นี้ได้ด้วย (ใช้กับแถว
    // งานทั่วไป/โปรเจคใน ContractOverview.js ที่ไม่มี contractGroupId จริงให้ใช้ PUT
    // /contract/:contractGroupId เหมือนสัญญาจริง — ดู commitEdit ในหน้านั้น) team/responsiblePerson
    // ของสัญญาจริงยังคงแก้ผ่าน PUT /contract/:contractGroupId เหมือนเดิม (อัปเดตทุกครั้งของสัญญา
    // พร้อมกัน) ไม่ได้มาทาง route นี้
    // ✅ jobValue เพิ่มเข้ามาให้แก้ไขผ่าน route นี้ได้ด้วย — หน้า "ภาพรวมงาน" แสดงมูลค่างานทุกแท็บแล้ว
    // (ไม่ใช่เฉพาะสัญญาจริงเหมือนเดิม) งานทั่วไป/โปรเจค/ยังไม่จัดกลุ่มไม่มี contractGroupId จริงจึงใช้
    // PUT /contract/:contractGroupId ไม่ได้ ต้องมาทางนี้ (เทียบ pattern เดียวกับ docNo) — ส่วนมูลค่างาน
    // ของสัญญาจริงยังแก้ผ่าน /contract/:contractGroupId เหมือนเดิม (อัปเดตทุกครั้งของสัญญาพร้อมกัน)
    const { eventIds, company, site, system, title, docNo, team, resPerson, responsiblePerson, responsiblePersonId, jobValue } = req.body;
    if (!Array.isArray(eventIds) || eventIds.length === 0) {
      return res.status(400).json({ message: "ไม่พบรายการที่จะแก้ไข" });
    }
    // ✅ กันค่าติดลบ/ไม่ใช่ตัวเลข (ฝั่งจอเช็คให้แล้วชั้นหนึ่ง — เช็คซ้ำที่นี่เพราะ API เรียกตรงได้เสมอ)
    if (jobValue !== undefined && jobValue !== null && jobValue !== "") {
      const n = Number(jobValue);
      if (Number.isNaN(n) || n < 0) {
        return res.status(400).json({ message: "มูลค่างานต้องเป็นตัวเลขและต้องไม่ติดลบ" });
      }
    }

    const isAdminOrManager = ["admin", "manager"].includes(req.user.role);
    if (!isAdminOrManager) {
      // ✅ ผู้รับผิดชอบงานแก้ไข "ทีมที่เข้างาน" (team/resPerson) ของแต่ละครั้งได้อยู่แล้ว (ดู
      // beginRoundTeamEdit ใน ContractOverview.js) — ตอนนี้เพิ่มให้แก้ไขข้อมูลพื้นฐาน (บริษัท/โครงการ/
      // ระบบ/ประเภทงาน/เอกสาร) ของ "งานทั่วไป/งานโปรเจคที่ตัวเองรับผิดชอบ" ได้ด้วยตามที่ผู้ใช้ขอ — ยกเว้น
      // การมอบหมาย "ผู้รับผิดชอบ" เอง (responsiblePerson/responsiblePersonId) ยังคงเฉพาะแอดมิน/manager
      // เท่านั้น (ไม่ให้โยนความรับผิดชอบทิ้งเองได้) และงานตามสัญญาจริงยังคงเฉพาะแอดมิน/manager ทุกฟิลด์
      // เหมือนเดิม (เช็คจาก contractGroupId ด้านล่าง) เพราะต้องผ่านการตรวจสอบจากส่วนกลางก่อนเสมอ
      if (responsiblePerson !== undefined || responsiblePersonId !== undefined) {
        return res.status(403).json({ message: "เฉพาะแอดมิน/manager เท่านั้นที่มอบหมายผู้รับผิดชอบได้" });
      }
      // ✅ มูลค่างานเป็นข้อมูลการเงิน — ให้แก้ได้เฉพาะแอดมิน/manager เท่านั้นเหมือนกัน (ผู้รับผิดชอบงาน
      // แก้ข้อมูลพื้นฐานของงานตัวเองได้ก็จริง แต่ไม่ควรแก้ตัวเลขมูลค่าเองได้) — ตรงกับฝั่งจอที่เปิดให้
      // แก้ช่องนี้เฉพาะ isAdminOrManager อยู่แล้ว (ดู ContractOverview.js)
      if (jobValue !== undefined) {
        return res.status(403).json({ message: "เฉพาะแอดมิน/manager เท่านั้นที่แก้ไขมูลค่างานได้" });
      }
      // ✅ ต้องเป็น "ผู้รับผิดชอบ" ของทุก event ที่จะแก้ไขจริง (เช็คค่าที่ตั้งไว้ตรงๆ ไม่ fallback ไปที่
      // ทีมเดิมเหมือน isEffectiveResponsiblePerson — สิทธิ์นี้ต้องถูกมอบหมายไว้ชัดเจนก่อนเท่านั้น เทียบ
      // pattern เดียวกับ canEditTeamAssignment ใน EditEvent.js) และห้ามเป็นงานตามสัญญาจริงเด็ดขาด
      const targetEvents = await CalendarEvent.find({ _id: { $in: eventIds } })
        .select("responsiblePersonId responsiblePerson contractGroupId").lean();
      const userId = req.userId;
      const isAllResponsible = targetEvents.length === eventIds.length && targetEvents.every((e) =>
        !e.contractGroupId && (
          (e.responsiblePersonId && e.responsiblePersonId === userId) ||
          (e.responsiblePerson && e.responsiblePerson === req.user.fname)
        )
      );
      if (!isAllResponsible) {
        return res.status(403).json({ message: "คุณไม่มีสิทธิ์แก้ไขงานนี้" });
      }
    }

    const update = {};
    if (company !== undefined) update.company = company;
    if (site !== undefined) update.site = site;
    if (system !== undefined) update.system = system;
    if (title !== undefined) update.title = title;
    if (docNo !== undefined) update.docNo = docNo;
    if (team !== undefined) update.team = team;
    if (resPerson !== undefined) update.resPerson = resPerson;
    if (responsiblePerson !== undefined) update.responsiblePerson = responsiblePerson;
    if (responsiblePersonId !== undefined) update.responsiblePersonId = responsiblePersonId;
    // ✅ ล้างค่าได้ด้วยการส่ง "" มา (ให้กลับไปเป็น "ยังไม่ระบุ") ไม่งั้นลบค่าที่เคยใส่ผิดไว้ไม่ได้เลย
    if (jobValue !== undefined) update.jobValue = (jobValue === "" || jobValue === null) ? null : Number(jobValue);
    if (Object.keys(update).length === 0) {
      return res.status(400).json({ message: "ไม่มีข้อมูลให้แก้ไข" });
    }
    await CalendarEvent.updateMany({ _id: { $in: eventIds } }, { $set: update });
    const updatedEvents = await CalendarEvent.find({ _id: { $in: eventIds } }).lean();
    res.json({ events: updatedEvents });
  } catch (error) {
    console.error("❌ Error updating basic info:", error);
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
    // หรือเป็น "ผู้รับผิดชอบ" ของงานนี้ (responsiblePersonId/responsiblePerson — คนละแนวคิดกับ team/
    // resPerson ด้านบน อาจไม่ได้เข้างานเองแต่ยังรับผิดชอบอยู่)
    // ⚠️ BUG ที่แก้: เดิมไม่เช็ค responsiblePerson เลย ทำให้คนที่ถูกตั้งเป็นผู้รับผิดชอบแต่ไม่ได้อยู่ใน
    // team/resPerson ของครั้งนี้ แก้ไขงานตัวเองไม่ได้เลย (403 ทุกครั้ง)
    const isOwner = existingEvent.userId.toString() === userId.toString();
    const isAssigned =
      (existingEvent.resPerson && existingEvent.resPerson === userId) ||
      (existingEvent.team && existingEvent.team === req.user.fname) ||
      (existingEvent.responsiblePersonId && existingEvent.responsiblePersonId === userId) ||
      (existingEvent.responsiblePerson && existingEvent.responsiblePerson === req.user.fname);

    // ⚠️ BUG ที่แก้: เดิมเช็คแค่ req.user.role !== "admin" ตรงนี้ (manager ที่ไม่ใช่เจ้าของ/ไม่ได้รับ
    // มอบหมายจะโดน 403 ทั้งที่ทุก route อื่นในไฟล์นี้ให้สิทธิ์ admin/manager เท่ากันหมด) — แก้ให้ตรง
    // กับทุกจุดอื่น เทียบ pattern เดียวกับ isAdminOrManager ด้านล่าง (ย้ายมาคำนวณก่อนใช้ตรงนี้เลย)
    const isAdminOrManager = ["admin", "manager"].includes(req.user.role);
    if (!isAdminOrManager && !isOwner && !isAssigned) {
      return res.status(403).json({ message: "คุณไม่มีสิทธิ์แก้ไข Event นี้" });
    }

    // ✅ งานที่ปิดแล้ว (ดำเนินการเสร็จสิ้น) ห้ามช่างแก้ไขอีก มีแค่ admin/manager เท่านั้นที่ทำได้
    // ยกเว้น: comment (คุยโต้ตอบกัน), activityLog (แค่ log ไม่กระทบข้อมูลงานจริง), และฟิลด์ระบบ
    // ติดตามใบเสนอราคาทั้งชุด — เพราะการติดตามใบเสนอราคามักเกิด "หลัง" งานถูกปิดแล้ว (ช่างปิดงาน
    // หน้างานก่อน ค่อยตามเรื่องเอกสาร/ใบเสนอราคากับลูกค้าทีหลัง) ถ้าล็อกไว้เหมือนข้อมูลงานอื่นจะทำให้
    // ช่างอัปเดตสถานะใบเสนอราคาของงานตัวเองไม่ได้เลยทั้งที่เป็นกรณีปกติ ไม่ใช่ข้อยกเว้น
    const NON_BLOCKING_FIELDS = [
      "comments", "activityLog",
      "quotationStatus", "quotationSentAt", "quotationDecisionAt", "quotationDecisionBy",
      "quotationAmount", "quotationFollowUpNote",
    ];
    const isNonBlockingUpdate = Object.keys(req.body).every((k) => NON_BLOCKING_FIELDS.includes(k));
    if (existingEvent.status === "ดำเนินการเสร็จสิ้น" && !isAdminOrManager && !isNonBlockingUpdate) {
      return res.status(403).json({ message: "งานนี้ปิดแล้ว ไม่สามารถแก้ไขได้" });
    }

    // ✅ งานที่ยัง "รออนุมัติ" (pending) — ช่าง/ผู้รับผิดชอบเปิดดูได้อย่างเดียว ทำอะไรไม่ได้เลยจนกว่า
    // แอดมิน/manager จะตัดสินใจก่อน (ตามที่ผู้ใช้ยืนยัน) บล็อกทุกฟิลด์แบบเข้ม ไม่ใช่แค่ปิดงานเหมือนเดิม
    // — ⚠️ เดิมมีคอมเมนต์เตือนว่าตัวจับเวลาอัตโนมัติที่เปลี่ยนสถานะเป็น "กำลังดำเนินการ" ทุก 30 วินาที
    // (ฝั่ง EventCalendar/index.js) ต้องไม่โดนบล็อกตรงนี้ ไม่งั้นจะ retry ค้างวนไม่จบ — ปัจจุบันไม่ใช่ปัญหา
    // แล้ว เพราะจุดนั้นกรองงานที่ยังไม่ approved ออกไปตั้งแต่ต้นแล้ว (ดู getApprovalState(event) ===
    // "approved" ที่นั่น) จึงไม่มีทางยิง PUT มาโดนบล็อกตรงนี้ซ้ำๆ อีกต่อไป
    const approvalState = existingEvent.approvalStatus || "approved";
    if (approvalState === "pending" && !isAdminOrManager) {
      return res.status(403).json({ message: "งานนี้ยังไม่ได้รับการอนุมัติ ดูข้อมูลได้อย่างเดียว แก้ไขไม่ได้จนกว่าจะอนุมัติหรือไม่อนุมัติก่อน" });
    }
    // ✅ งานที่ "ถูกปฏิเสธ" (rejected) ยังแก้ไขต่อได้ตามปกติ เพื่อส่งขออนุมัติใหม่ (ดู shouldResubmit
    // ด้านล่าง) — คนละเคสกับ pending ด้านบน แต่ยังห้าม "ขอปิดงาน"/ปิดงานจนกว่าจะได้รับการอนุมัติก่อน
    if (approvalState === "rejected" && !isAdminOrManager) {
      if (req.body.closeRequested === true) {
        return res.status(403).json({ message: "งานนี้ยังไม่ได้รับการอนุมัติ ยังขอปิดงานไม่ได้" });
      }
      if (req.body.status === "ดำเนินการเสร็จสิ้น") {
        return res.status(403).json({ message: "งานนี้ยังไม่ได้รับการอนุมัติ ยังปิดงานไม่ได้" });
      }
    }

    // ✅ แก้ไขงานที่ถูกปฏิเสธไปแล้ว (approvalStatus:"rejected") ถือเป็นการ "ส่งขออนุมัติใหม่"
    // โดยอัตโนมัติ ถ้าแก้ไข "เนื้อหางานจริง" (ไม่ใช่แค่ comment/log/สถานะเอกสารซึ่งไม่เกี่ยวกับสิ่งที่
    // แอดมินเคยปฏิเสธไป) — เจ้าของ/ผู้ถูกมอบหมายแก้ไขแล้วส่งกลับเข้าคิวรออนุมัติได้เองโดยไม่ต้องรอแอดมิน
    // สร้างงานใหม่ทั้งอัน — เก็บ approvalRejectReason เดิมไว้ให้เห็นเป็นประวัติ (จะถูกล้างทิ้งเองตอน
    // ตัดสินใจครั้งถัดไปที่ PUT /:id/approval)
    const APPROVAL_RESUBMIT_FIELDS = [
      "company", "site", "title", "system", "time", "team", "resPerson", "teamMembers",
      "date", "start", "end", "startTime", "endTime", "subject", "description", "docNo", "jobValue",
    ];
    const touchesResubmitField = APPROVAL_RESUBMIT_FIELDS.some((f) => req.body[f] !== undefined);
    const shouldResubmit = approvalState === "rejected" && !isAdminOrManager && touchesResubmitField;
    const resubmitterName = [req.user?.fname, req.user?.lname].filter(Boolean).join(" ") || req.user?.username || "ผู้ดูแลระบบ";

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
      // 🐛 BUG ที่แก้ (แก้ "เข้าทุกกี่เดือน" จากหน้าปฏิทินแล้วหายเงียบ): route นี้ไม่เคยรับ intervalMonths
      // เลยแม้แต่ครั้งเดียว ทั้งที่ฟอร์มแก้ไขงาน (EditEvent.js) มีช่องนี้ให้กรอกและส่งค่ามาทุกครั้งที่บันทึก
      // — ผู้ใช้แก้แล้วกดบันทึก ได้ข้อความ "สำเร็จ" แต่ค่าไม่เคยถูกเก็บ ต้องไปแก้ที่หน้า "ภาพรวมงาน"
      // (PUT /contract/:contractGroupId ซึ่งรับฟิลด์นี้อยู่แล้ว) เท่านั้นถึงจะได้ผลจริง
      intervalMonths,
      jobValue,
    } = req.body;

    // ✅ ตรวจข้อมูลสัญญาให้ตรงกับ PUT /contract/:contractGroupId และ POST /draft เป๊ะๆ — เดิม route นี้
    // ไม่ตรวจอะไรเลย ทำให้ "ฟิลด์เดียวกันของสัญญาเดียวกัน" มีกติกาคนละชุดขึ้นกับว่าแก้จากหน้าไหน:
    // แก้จากหน้า "ภาพรวมงาน" ติดเพดาน 12 ครั้ง แต่แก้จากฟอร์มในปฏิทินใส่เท่าไหร่ก็ได้ — ตั้งเกิน 12 ไป
    // แล้วตารางภาพรวมงานจะเรนเดอร์ได้แค่ 12 คอลัมน์ (ดู maxVisitCount) ครั้งที่เกินมามองไม่เห็น/เข้าไม่ถึง
    // และแก้กลับจากหน้านั้นก็ไม่ได้อีก (โดนเพดานบล็อก) กลายเป็นสัญญาที่ค้างอยู่ในสถานะที่ซ่อมได้ทางเดียว
    if (intervalMonths !== undefined && intervalMonths !== "" && intervalMonths !== null) {
      const n = Number(intervalMonths);
      if (!n || n < 1 || n > 24) {
        return res.status(400).json({ message: "ระยะห่างระหว่างรอบต้องอยู่ระหว่าง 1-24 เดือน" });
      }
    }
    if (visitCount !== undefined && visitCount !== "" && visitCount !== null) {
      const n = Number(visitCount);
      if (!n || n < 1 || n > 12) {
        return res.status(400).json({ message: "จำนวนครั้งทั้งหมดต้องอยู่ระหว่าง 1-12 ครั้ง" });
      }
    }

    // ⚠️ ตัดออกตามที่ผู้ใช้ขอ: เดิมเช็คช่างชนกัน (double-booking) ทุกครั้งที่ resPerson/ช่วงวันที่
    // เปลี่ยนไปจากเดิม ทำให้ลากงานย้ายวันบนปฏิทิน (eventDrop → PUT /:id) พังบ่อยเพราะช่างคนเดิมมีงาน
    // อื่นอยู่แล้ววันนั้น ทั้งที่ในทางปฏิบัติ 1 ทีมรับงานหลายงานในวันเดียวกันได้ตามปกติ ไม่ควรบล็อก
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
      intervalMonths, // ✅ เดิมตกหล่นไป ทำให้ค่าที่แก้จากฟอร์มในปฏิทินไม่เคยถูกบันทึก (ดูคอมเมนต์ด้านบน)
      jobValue,

      // ✅ ส่งขออนุมัติใหม่อัตโนมัติ (ดู shouldResubmit ด้านบน) — ไม่เข้าเงื่อนไขก็ไม่ใส่ key พวกนี้เลย
      // (ไม่ใช่ใส่เป็น undefined) ปล่อยให้ approvalStatus เดิมในฐานข้อมูลไม่ถูกแตะต้อง
      ...(shouldResubmit ? {
        approvalStatus: "pending",
        approvalRequestedAt: new Date(),
        approvalRequestedBy: resubmitterName,
        approvalRequestedByUserId: userId,
        approvalDecidedAt: null,
        approvalDecidedBy: "",
      } : {}),

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

    if (shouldResubmit) {
      sendPushToRoles(["admin", "manager"], {
        title: `🔄 ${resubmitterName} แก้ไขงานที่ถูกตีกลับ ส่งขออนุมัติใหม่`,
        body: `${updatedEvent.title || "งาน"} · ${jobLabel}`,
        url: `/operation/${updatedEvent._id}`,
        tag: `approval-resubmit-${updatedEvent.jobGroupId || updatedEvent._id}`,
        renotify: true,
      }).catch((err) => console.error("❌ Push notify error (approval-resubmit):", err));
    }

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

    // ❌ งานที่ยังรออนุมัติ ช่างทำอะไรไม่ได้เลย รวมถึงลบด้วย (เทียบ pattern เดียวกับ PUT /:id) —
    // เปิดดูได้อย่างเดียว
    if ((existingEvent.approvalStatus || "approved") === "pending" && !isAdminOrManager) {
      return res.status(403).json({ message: "งานนี้ยังไม่ได้รับการอนุมัติ ดูข้อมูลได้อย่างเดียว แก้ไขไม่ได้จนกว่าจะอนุมัติหรือไม่อนุมัติก่อน" });
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
