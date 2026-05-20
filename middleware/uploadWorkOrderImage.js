const multer = require("multer");
const path = require("path");

// จัดเก็บไฟล์
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const type = req.params.type; // before / after

    const folder =
      type === "before"
        ? "asset/uploads/workorders/before/"
        : "asset/uploads/workorders/after/";

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
