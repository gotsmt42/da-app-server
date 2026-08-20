// ✅ JobType/SystemType เป็น lookup list ที่มีรูปร่างเหมือนกันเป๊ะ (แค่ฟิลด์ name) ต่างจาก
// Customer ที่มีหลายฟิลด์/ผูก userId เจ้าของ — ใช้ factory เดียวสร้าง router ให้ทั้งคู่แทนการ
// copy/paste โค้ด CRUD ซ้ำสองรอบ
const express = require("express");
const verifyToken = require("../middleware/auth");

// label ใช้แค่ทำข้อความ error ให้อ่านง่าย เช่น "ประเภทงาน"/"ระบบ"
const createLookupRouter = (Model, label) => {
  const router = express.Router();

  // ✅ เปิดให้ทุก role ที่ล็อกอินแล้วอ่านได้ (ไม่ใช่แค่ admin) เพราะฟอร์มเพิ่ม/แก้ไขแผนงานของ
  // ทุกคนต้องใช้ลิสต์นี้เป็นตัวเลือกใน dropdown
  router.get("/", verifyToken, async (req, res) => {
    try {
      const items = await Model.find({}).sort({ name: 1 });
      res.json({ items });
    } catch (err) {
      res.status(500).send(err.message);
    }
  });

  // ✅ เพิ่ม/แก้ไข/ลบ จำกัดเฉพาะ admin — เป็นรายการกลางของทั้งระบบ ไม่ใช่ของใครคนใดคนหนึ่ง
  router.post("/", verifyToken, async (req, res) => {
    if (req.user.role !== "admin") {
      return res.status(403).send(`Unauthorized to add ${label}.`);
    }
    try {
      const { name } = req.body;
      if (!name || !name.trim()) {
        return res.status(400).send(`กรุณาระบุชื่อ${label}`);
      }
      const item = await new Model({ name: name.trim() }).save();
      res.status(201).json({ message: `เพิ่ม${label}สำเร็จ`, data: item });
    } catch (err) {
      if (err.code === 11000) {
        return res.status(409).send(`มี${label}นี้อยู่แล้ว`);
      }
      res.status(500).send(err.message);
    }
  });

  router.put("/:id", verifyToken, async (req, res) => {
    if (req.user.role !== "admin") {
      return res.status(403).send(`Unauthorized to edit ${label}.`);
    }
    try {
      const { name } = req.body;
      if (!name || !name.trim()) {
        return res.status(400).send(`กรุณาระบุชื่อ${label}`);
      }
      const updated = await Model.findByIdAndUpdate(
        req.params.id,
        { name: name.trim() },
        { new: true, runValidators: true }
      );
      if (!updated) return res.status(404).send(`ไม่พบ${label}นี้`);
      res.status(200).json({ message: `แก้ไข${label}สำเร็จ`, data: updated });
    } catch (err) {
      if (err.code === 11000) {
        return res.status(409).send(`มี${label}นี้อยู่แล้ว`);
      }
      res.status(500).send(err.message);
    }
  });

  router.delete("/:id", verifyToken, async (req, res) => {
    if (req.user.role !== "admin") {
      return res.status(403).send(`Unauthorized to delete ${label}.`);
    }
    try {
      const deleted = await Model.findByIdAndDelete(req.params.id);
      if (!deleted) return res.status(404).send(`ไม่พบ${label}นี้`);
      res.status(200).send(`ลบ${label}สำเร็จ`);
    } catch (err) {
      res.status(500).send(err.message);
    }
  });

  return router;
};

module.exports = createLookupRouter;
