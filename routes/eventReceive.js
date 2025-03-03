const express = require("express");
const router = express.Router();

const EventReceive = require("../models/EventReceive");
const User = require("../models/User");

const axios = require("axios");

const verifyToken = require("../middleware/auth");


router.post("/", verifyToken, async (req, res) => {
  try {
    const userId = req.userId;

    const {
      title,
      start,
      end,
    } = req.body;
    const event = new EventReceive({
      title,
      start,
      end,
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
    const userId = req.userId;

    let userEvents;

    if (req.user.role === "admin") {
      userEvents = await EventReceive.find({});
    } else {
      userEvents = await EventReceive.find({ userId: userId });
    }

    // ดึง userId ทั้งหมดจาก userFiles
    const userIds = userEvents.map((event) => event.userId);

    // ค้นหาข้อมูลผู้ใช้จาก model User โดยใช้ userIds
    const users = await User.find({ _id: { $in: userIds } });

    // แปลงค่า userId ใน userFiles เป็น role จากข้อมูลใน users
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

    if (!userEvents) {
      return res.status(404).json({ message: "Event not found" });
    }

    res.json({ userEvents: updatedUserEvents });
  } catch (err) {
    console.error("Error fetching user products:", err); // ✅ แก้ไขตรงนี้
    res.status(500).send(err.message);
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

    // console.log(id);
    // console.log(req.body);

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

    const updatedEvent = await EventReceive.findOneAndUpdate(
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
    
    console.log(`🗑 Attempting to delete event with ID: ${id}`); // เช็กว่า ID ถูกต้องไหม

    const deletedEvent = await EventReceive.findByIdAndDelete(id);

    if (!deletedEvent) {
      return res.status(404).json({ message: "❌ Event not found" });
    }

    console.log("✅ Event deleted successfully:", deletedEvent);
    res.status(200).json({ message: "Event deleted successfully" });
  } catch (err) {
    console.error("❌ Error deleting event:", err);
    res.status(500).send(err.message);
  }
});


module.exports = router;
