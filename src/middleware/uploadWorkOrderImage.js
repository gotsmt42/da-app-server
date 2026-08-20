const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { WORKORDER_BEFORE_DIR, WORKORDER_AFTER_DIR } = require("../config/paths");

// จัดเก็บไฟล์
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const type = req.params.type; // before / after

    // ⚠️ เดิมใช้พาธแบบ "asset/uploads/workorders/before/" ซึ่งอิงกับ "โฟลเดอร์ที่สั่งรัน" (cwd)
    // ไม่ใช่ตำแหน่งของโค้ด — รันจากที่อื่นเมื่อไหร่ไฟล์จะไปโผล่ผิดที่ทันที และ multer จะไม่สร้าง
    // โฟลเดอร์ให้เองด้วย (โยน ENOENT) เปลี่ยนมาใช้พาธสัมบูรณ์จาก src/config/paths.js
    const folder = type === "before" ? WORKORDER_BEFORE_DIR : WORKORDER_AFTER_DIR;

    fs.mkdirSync(folder, { recursive: true });
    cb(null, folder);
  },

  filename: function (req, file, cb) {
    const uniqueName =
      Date.now() + "-" + Math.round(Math.random() * 1e9) + path.extname(file.originalname);

    cb(null, uniqueName);
  },
});

// อนุญาตเฉพาะภาพ
const fileFilter = (req, file, cb) => {
  if (file.mimetype.startsWith("image/")) {
    cb(null, true);
  } else {
    cb(new Error("ไฟล์ต้องเป็นรูปภาพเท่านั้น!"), false);
  }
};

module.exports = multer({ storage, fileFilter });
