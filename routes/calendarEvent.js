const express = require("express");
const router = express.Router();

const CalendarEvent = require("../models/Events");
const User = require("../models/User");

const axios = require("axios");

const verifyToken = require("../middleware/auth");

router.post("/linenotify", verifyToken, async (req, res) => {
  try {
    let { description } = req.body;

    let message = "\n📢📢 มีการแจ้งเตือนอัพเดตตารางแผนงานใหม่ 😊\n";

    await sendLineNotification(`\n${message}\nคำอธิบาย: ${description}\n`);

    // ส่งข้อความผ่าน Line Notify
    async function sendLineNotification(message) {
      const url_line_notification = `${process.env.APP_URL_LINE_NOTIFY}`;
      const footer = `\nข้อความนี้ถูกส่งโดยระบบแจ้งเตือนการอัพเดตแผนงานสำหรับข้อมูลเพิ่มเติมคลิ๊กที่นี่: ${process.env.APP_API_URL}/event\n\nUsername: admin \nPassword: admin`;



      // เพิ่ม footer ในข้อความ
      message += footer;

      // ส่งข้อความผ่าน Line Notify
      await axios.post(url_line_notification, null, {
        params: {
          message: message,
        },
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Bearer ${process.env.APP_TOKEN_LINE_NOTIFY}`,
        },
      });
    }
  } catch (err) {
    console.error("Error fetching user LineNotify:", error);
    res.status(500).send(err.message);
  }
});

router.post("/", verifyToken, async (req, res) => {
  try {
    const userId = req.userId;

    const {
      title,
      date,
      backgroundColor,
      textColor,
      fontSize,
      start,
      end,
      allDay,
    } = req.body;
    const event = new CalendarEvent({
      title,
      date,
      backgroundColor,
      textColor,
      fontSize,
      start,
      end,
      allDay,

      userId,
    });
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

    let userEvents;

    // ✅ เงื่อนไข: ถ้าเป็น admin ให้ดึง event ทั้งหมด
    if (userRole === "admin") {
      userEvents = await CalendarEvent.find({});
    } else {
      // ✅ ถ้าเป็น user ทั่วไป ให้ดึงเฉพาะ event ของตัวเอง
      userEvents = await CalendarEvent.find({ userId: userId });
    }

    // ดึง userId ทั้งหมดจาก userEvents
    const userIds = userEvents.map((event) => event.userId);

    // ค้นหาข้อมูลผู้ใช้จาก model User โดยใช้ userIds
    const users = await User.find({ _id: { $in: userIds } });

    // แปลงค่า userId ใน userEvents เป็น role จากข้อมูลใน users
    const updatedUserEvents = userEvents.map((event) => {
      const user = users.find(
        (user) => user._id.toString() === event.userId.toString()
      );
      if (user) {
        // คัดลอกค่าทั้งหมดของผู้ใช้ยกเว้น _id
        const { _id, ...userDataWithoutId } = user.toObject();
        return { ...event._doc, user: userDataWithoutId }; // เพิ่ม property user ที่มีค่าข้อมูลผู้ใช้ยกเว้น _id
      } else {
        return event; // ถ้าไม่พบ user ให้ใช้ค่าเดิมของ event
      }
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


router.put("/:id", verifyToken, async (req, res) => {
  try {
    const id = req.params.id;
    const {
      title,
      date,
      backgroundColor,
      textColor,
      fontSize,
      start,
      end,
      allDay,
    } = req.body;

    console.log(id);
    console.log(req.body);

    const newEvent = {
      title,
      date,
      backgroundColor,
      textColor,
      fontSize,
      start,
      end,
      allDay,
    };

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

    res.status(200).json({updatedEvent: updatedEvent}); // ส่งข้อมูลของเหตุการณ์ที่ถูกอัปเดตกลับไป
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
