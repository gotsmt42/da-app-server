const express = require("express");
const router = express.Router();
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const File = require("../models/File");
const User = require("../models/User");
const verifyToken = require("../middleware/auth");

const Category = require("../models/Category");

let archiver;
(async () => {
  archiver = (await import("archiver")).default;
})();

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, path.join(__dirname, "../asset/uploads/files")); // ✅ ใช้โฟลเดอร์เดียวกัน
  },
  filename: (req, file, cb) => {
    const sanitized = file.originalname
      .replace(/\s+/g, "_")
      .replace(/[^\w.-]/g, "");
    cb(null, Date.now() + "_" + sanitized);
  },
});

const upload = multer({ storage }).array("files");

const uploadDir = path.join(__dirname, "../asset/uploads/files");
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Upload files
router.post("/", verifyToken, (req, res) => {
  upload(req, res, async (err) => {
    if (err) return res.status(500).send("Error uploading files.");

    const files = req.files;
    if (!files || files.length === 0) {
      return res.status(400).json({ message: "No files uploaded" });
    }

    const userId = req.userId;
    const uploadedFiles = [];

    try {
      const categories = req.body.categories; // ✅ multer จะ parse เป็น array

      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const originalName = Buffer.from(file.originalname, "latin1").toString(
          "utf8",
        );

        const categoryValue = Array.isArray(categories)
          ? categories[i]
          : categories;

        let categoryDoc = null;
        if (categoryValue) {
          categoryDoc = await Category.findOneAndUpdate(
            { name: categoryValue.trim() },
            { name: categoryValue.trim() },
            { upsert: true, new: true }, // ✅ ถ้าไม่มีให้สร้างใหม่
          );
        }
        const newFile = new File({
          filename: originalName,
          path: file.path,
          size: file.size,
          category: categoryValue || "ไม่มีหมวดหมู่", // ✅ ใช้ค่าที่ส่งมา
          userId,
        });

        const savedFile = await newFile.save();
        uploadedFiles.push(savedFile);
      }

      res.status(201).json({
        message: "Files uploaded locally successfully",
        data: uploadedFiles.map((f) => ({
          ...f._doc,
          filename: f.filename,
          category: f.category, // ✅ ส่งหมวดหมู่กลับไปด้วย
          url: `/api/files/${f._id}/download`,
        })),
      });
    } catch (error) {
      console.error("Upload failed:", error);
      res.status(500).json({ message: "Upload failed", error: error.message });
    }
  });
});

router.get("/categories", verifyToken, async (req, res) => {
  try {
    const categories = await Category.find({}).sort({ name: 1 });
    res.json({ categories });
  } catch (err) {
    res.status(500).json({ message: "Error fetching categories" });
  }
});



// Get files
router.get("/", verifyToken, async (req, res) => {
  try {
    let userFiles;

    if (req.user.role === "admin") {
      userFiles = await File.find({});
    } else {
      userFiles = await File.find({ userId: req.userId });
    }

    const userIds = userFiles.map((file) => file.userId);
    const users = await User.find({ _id: { $in: userIds } });

    // const updatedUserFiles = userFiles.map((file) => {
    //   const user = users.find(
    //     (user) => user._id.toString() === file.userId.toString()
    //   );
    //   const decodedName = Buffer.from(file.filename, "latin1").toString("utf8");
    //   if (user) {
    //     const { _id, ...userDataWithoutId } = user.toObject();
    //     return { ...file._doc, filename: decodedName, user: userDataWithoutId };
    //   } else {
    //     return { ...file._doc, filename: decodedName };
    //   }
    // });

    // fileRouter.js
    const updatedUserFiles = userFiles.map((file) => {
      const user = users.find(
        (u) => u._id.toString() === file.userId.toString(),
      );
      // const decodedName = Buffer.from(file.filename, "latin1").toString("utf8");
      const decodedName = file.filename; // ✅ ส่งกลับตรง ๆ
      return {
        ...file._doc,
        filename: decodedName,
        category: file.category, // ✅ ส่งหมวดหมู่กลับไป
        user: user ? { ...user.toObject(), _id: undefined } : null,
        url: `/api/files/${file._id}/download`, // ✅ ใช้ API route
      };
    });

    res.json({ userFiles: updatedUserFiles });
  } catch (err) {
    console.error("Error fetching users:", err);
    res.status(500).send(err.message);
  }
});

router.post("/files/download-zip", async (req, res) => {
  const { fileIds } = req.body;

  // โหลด archiver แบบ dynamic import
  const archiver = (await import("archiver")).default;

  const archive = archiver("zip", { zlib: { level: 9 } });
  res.attachment("files.zip");
  archive.pipe(res);

  for (const id of fileIds) {
    const file = await File.findById(id);
    archive.file(file.path, { name: file.filename });
  }

  archive.finalize();
});

router.get("/:id/download", verifyToken, async (req, res) => {
  try {
    const file = await File.findById(req.params.id);
    if (!file) return res.status(404).send("File not found");

    res.download(file.path, file.filename);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// Update file (แก้ไขชื่อไฟล์)
// Update file (แก้ไขชื่อไฟล์)
router.put("/:id", verifyToken, async (req, res) => {
  try {
    const { filename, category } = req.body;
    if (!filename || filename.trim() === "") {
      return res.status(400).json({ message: "Filename is required" });
    }

    const file = await File.findById(req.params.id);
    if (!file) return res.status(404).json({ message: "File not found" });

    // ✅ เก็บ UTF-8 ตรง ๆ
    file.filename = filename;
    if (category) file.category = category; // ✅ อัปเดตหมวดหมู่ด้วย
    await file.save();

    res.json({
      message: "File updated successfully",
      data: {
        ...file._doc,
        filename: file.filename, // ✅ ส่งกลับตรง ๆ ไม่ต้อง Buffer
        category: file.category, // ✅ ส่งหมวดหมู่กลับไป
        url: `/api/files/${file._id}/download`,
      },
    });
  } catch (err) {
    console.error("Error updating file:", err);
    res.status(500).json({ message: "Update failed", error: err.message });
  }
});

router.delete("/:id", verifyToken, async (req, res) => {
  try {
    const id = req.params.id;
    const file = await File.findByIdAndDelete(id);

    if (file && fs.existsSync(file.path)) {
      fs.unlink(file.path, (err) => {
        if (err) console.warn("Local file delete failed:", err.message);
      });
    }

    res.status(200).send("File deleted successfully");
  } catch (err) {
    console.error("Error deleting file:", err);
    res.status(500).send(err.message);
  }
});

module.exports = router;
