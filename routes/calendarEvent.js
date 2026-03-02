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

router.put("/upload/:id", upload.single("file"), async (req, res) => {
  try {
    const capitalize = (str = "") => str.charAt(0).toUpperCase() + str.slice(1);

    const file = req.file;
    const eventId = req.params.id;
    const type = req.body.type;
    const fileType = file.mimetype;

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
    const isOfficeFile =
      fileType === "application/msword" ||
      fileType ===
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
      fileType === "application/vnd.ms-excel" ||
      fileType ===
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

    const isPdf = fileType === "application/pdf";

    const uploadToCloudinary = () =>
      new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          {
            resource_type: "raw",
            folder: `events/${eventId}`,
            public_id: isOfficeFile ? sanitizedName : undefined, // ✅ ใช้ชื่อไฟล์สำหรับ Office เท่านั้น
            use_filename: true,
            unique_filename: false, // ✅ PDF ไม่สุ่มชื่อ แต่ไม่ใช้ public_id
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

    // ✅ อัปเดตข้อมูลใน MongoDB
    // await CalendarEvent.findByIdAndUpdate(eventId, {
    //   [`${type}FileName`]: originalName,
    //   [`${type}FileUrl`]: result.secure_url,
    //   [`${type}FileType`]: fileType,
    //   [`documentSent${capitalize(type)}`]: true,
    // });

    await CalendarEvent.updateOne(
      { _id: eventId },
      {
        $set: {
          [`${type}FileName`]: originalName,
          [`${type}FileUrl`]: result.secure_url,
          [`${type}FileType`]: fileType,
          [`documentSent${capitalize(type)}`]: true,
        },
      }
    );

    res.status(200).json({
      fileName: originalName,
      fileUrl: result.secure_url,
      fileType: fileType,
    });
  } catch (err) {
    console.error("Upload error:", err);
    res.status(500).send("Upload failed");
  }
});

router.put("/delete-file/:id", async (req, res) => {
  try {
    const capitalize = (str = "") => str.charAt(0).toUpperCase() + str.slice(1);

    const { id } = req.params;
    const { type } = req.body;

    const update = {
      [`${type}FileName`]: null,
      [`${type}FileUrl`]: null,
      [`${type}FileType`]: null,
      [`documentSent${capitalize(type)}`]: false,
    };

    await CalendarEvent.findByIdAndUpdate(id, update);
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
    ];

    const eventData = {};
    allowedFields.forEach((field) => {
      if (req.body[field] !== undefined) {
        eventData[field] = req.body[field];
      }
    });

    eventData.userId = req.userId;

    const event = new CalendarEvent(eventData);
    await event.save();

    res.status(201).send(event);
  } catch (error) {
    console.error(error);
    res.status(500).send("Internal Server Error");
  }
});

router.get("/event-op", verifyToken, async (req, res) => {
  try {
    const userId = req.userId; // ดึง userId จาก Token
    const userRole = req.user.role; // ดึง role ของ User

    let userEvents;

    if (userRole === "admin") {
      // admin เห็นทั้งหมด
      userEvents = await CalendarEvent.find({});
    } else {
      // user เห็นเฉพาะของตัวเอง
      userEvents = await CalendarEvent.find({ resPerson: userId });
    }

    // ดึง userId ทั้งหมดจาก userEvents
    const userIds = userEvents.map((event) => event.userId);

    const users = await User.find({ _id: { $in: userIds } });

    const updatedUserEvents = userEvents.map((event) => {
      const user = users.find(
        (user) => user._id.toString() === event.userId.toString()
      );
      if (user) {
        const { _id, ...userDataWithoutId } = user.toObject();
        return { ...event._doc, user: userDataWithoutId };
      } else {
        return event;
      }
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

    // ✅ เงื่อนไข: admin แก้ไขได้ทุก event, user แก้ไขได้เฉพาะของตัวเอง
    if (
      req.user.role !== "admin" &&
      existingEvent.userId.toString() !== userId.toString()
    ) {
      return res.status(403).json({ message: "คุณไม่มีสิทธิ์แก้ไข Event นี้" });
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
      subject,
      description,
      startTime,
      endTime,
      documentSentQuotation,
      documentSentReport,
      documentSent,
      documentFile, // ✅ เพิ่มตรงนี้
      resPerson, // ✅ เพิ่มตรงนี้
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
      subject,
      description,
      startTime,
      endTime,
      documentSentQuotation,
      documentSentReport,
      documentSent,
      documentFile, // ✅ เพิ่มตรงนี้
      resPerson, // ✅ เพิ่มตรงนี้

      userId: existingEvent.userId, // ❌ ไม่เปลี่ยนเจ้าของเดิม
      // lastModifiedBy: req.userId, // ✅ บันทึกคนที่แก้ไขล่าสุด
    };

    console.log("🧾 newEvent:", newEvent);
    const query =
      req.user.role === "admin" ? { _id: id } : { _id: id, userId: req.userId };

    const updatedEvent = await CalendarEvent.findOneAndUpdate(query, newEvent, {
      new: true,
    }).exec();

    if (!updatedEvent) {
      return res.status(404).json("Event not found");
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


    
    // Delete file from database
    await CalendarEvent.findByIdAndDelete(id);

    res.status(200).send("Event deleted successfully");
  } catch (err) {
    console.error("Error deleting Event:", err);
    res.status(500).send(err.message);
  }
});

module.exports = router;
