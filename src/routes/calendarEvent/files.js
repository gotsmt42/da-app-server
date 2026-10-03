/**
 * แนบไฟล์เข้างาน / ลบไฟล์ออกจากงาน (อัปโหลดขึ้น Cloudinary)
 *
 * แยกออกมาจาก routes/calendarEvent.js เดิมที่ยาว 2,708 บรรทัดในไฟล์เดียว (29 route)
 * ⚠️ ลำดับการประกาศ route ภายในไฟล์นี้ = ลำดับเดิม ห้ามสลับ (ดูเหตุผลที่ index.js)
 */
const { syncQuotationStartSafe } = require("../../services/quotationAutoStart");
const {
  CalendarEvent,
  verifyToken,
  can,
  upload,
  cloudinary,
  streamifier,
} = require("./shared");
const { ALLOWED_TYPES, ALLOWED_IMAGE_TYPES } = require("../../config/upload");

module.exports = (router) => {
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
      const isAdminOrManager = can(req.user, "editAnyJob");
      if (eventForLock.status === "ดำเนินการเสร็จสิ้น" && !isAdminOrManager && type !== "quotation") {
        return res.status(403).send("งานนี้ปิดแล้ว ไม่สามารถแก้ไขไฟล์ได้");
      }

      // ✅ แปลงชื่อไฟล์ให้เป็น UTF-8 และ sanitize
      const originalName = Buffer.from(file.originalname, "latin1").toString(
        "utf8"
      );
      const sanitizedName = originalName.replace(/[^\w\-.]/g, "_"); // คงนามสกุลไว้
      /**
       * 🐛 ผู้ใช้แจ้ง (28 ก.ย. 2569): "หน้าช่างอัปโหลดไฟล์ไม่ได้"
       * สาเหตุ: แอปย่อรูปก่อนอัปโหลด (shared/utils/fileUpload.js) และได้ไฟล์ .webp บนเครื่องที่รองรับ
       * (มือถือ Android/Chrome เกือบทุกเครื่อง) — แต่ route นี้มีรายการชนิดไฟล์ของตัวเองที่ไม่มี webp/heic
       * รูปจากช่างจึงถูกปฏิเสธ 400 ทุกรูป ✅ ใช้รายการกลางชุดเดียวกับ multer (config/upload.js) แทน
       */
      // บางเครื่องส่ง mimetype เป็น application/octet-stream (เช่น .heic) — multer ผ่านให้ด้วยนามสกุลแล้ว ต้องผ่านตรงนี้ด้วย
      const okByExt = ["jpg", "jpeg", "png", "webp", "heic", "heif", "pdf", "doc", "docx", "xls", "xlsx"]
        .includes(String(originalName).split(".").pop().toLowerCase());
      if (!ALLOWED_TYPES.includes(fileType) && !okByExt) {
        return res.status(415).json({ message: "รองรับเฉพาะรูปภาพ (JPG, PNG, WebP, HEIC) และเอกสาร (PDF, Word, Excel)" });
      }

      // ✅ perf: รูปภาพอัพโหลดด้วย resource_type "image" แทน "raw" — "raw" เป็น blob ดิบๆ
      // ไม่รองรับ Cloudinary URL transformation (resize/compress) เลย ทำให้ตอนเปิดดูรูปพรีวิวต้องโหลด
      // ไฟล์เต็มความละเอียดต้นฉบับเสมอ (รูปจากมือถือหลาย MB) รู้สึกหน่วง/ค้าง — "image" เปิดให้แปะ query
      // param (f_auto,q_auto,w_...) ตอนแสดงผลได้ ย่อ/บีบอัดแบบ on-the-fly โดยไม่กระทบไฟล์ต้นฉบับที่เก็บไว้
      // (เอกสารอื่น PDF/Word/Excel ไม่ได้ประโยชน์จาก transformation นี้ ใช้ "raw" เหมือนเดิม)
      const isImage = ALLOWED_IMAGE_TYPES.includes(fileType);
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

      // ✅ แนบใบเสนอราคาของงานที่ส่งงานแล้ว = เริ่มนับติดตามทันที (services/quotationAutoStart.js)
      if (type === "quotation") await syncQuotationStartSafe({ ids: [eventId] });

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
      res.status(500).json({ message: "อัปโหลดขึ้นที่เก็บไฟล์ไม่สำเร็จ ลองใหม่อีกครั้ง" });
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
      const isAdminOrManager = can(req.user, "editAnyJob");
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
};
