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
    const fileType = file.mimetype; // เช่น "application/pdf", "image/jpeg"

    // ✅ แก้ชื่อไฟล์เพี้ยนตรงนี้
    const originalName = Buffer.from(file.originalname, "latin1").toString(
      "utf8"
    );

  const uploadToCloudinary = () =>
  new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        resource_type: "raw", // ✅ เปลี่ยนจาก "auto" เป็น "raw"
        folder: `events/${eventId}`,
      },
      (error, result) => {
        if (error) reject(error);
        else resolve(result);
      }
    );
    streamifier.createReadStream(file.buffer).pipe(stream);
  });

    const result = await uploadToCloudinary();

    await CalendarEvent.findByIdAndUpdate(eventId, {
      [`${type}FileName`]: originalName,
      [`${type}FileUrl`]: result.secure_url,
      [`${type}FileType`]: fileType, // ✅ เพิ่มตรงนี้
      [`documentSent${capitalize(type)}`]: true, // ✅ sync สถานะใน DB
      
    });

    res.status(200).json({
      fileName: originalName,
      fileUrl: result.secure_url,
      fileType: fileType, // ✅ ส่งกลับไปด้วย
    });
  } catch (err) {
    console.error("Upload error:", err);
    res.status(500).send("Upload failed");
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
    };

    console.log("🧾 newEvent:", newEvent);

    const updatedEvent = await CalendarEvent.findOneAndUpdate(
      { _id: id },
      newEvent,
      {
        new: true, // เพิ่มพารามิเตอร์นี้เพื่อให้ MongoDB ส่งข้อมูลของเหตุการณ์ที่ถูกอัปเดตกลับมา
      }
    ).exec();

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

    console.log(id);
    // Delete file from database
    await CalendarEvent.findByIdAndDelete(id);

    res.status(200).send("Event deleted successfully");
  } catch (err) {
    console.error("Error deleting Event:", err);
    res.status(500).send(err.message);
  }
});

module.exports = router;
