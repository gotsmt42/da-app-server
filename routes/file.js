const express = require("express");
const router = express.Router();
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const File = require("../models/File");
const User = require("../models/User");
const verifyToken = require("../middleware/auth");


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

    console.log("Uploaded files:", req.files); // ✅ ดูไฟล์ที่เข้ามา

    const files = req.files;
    if (!files || files.length === 0) {
      return res.status(400).json({ message: "No files uploaded" });
    }

    const userId = req.userId;
    const uploadedFiles = [];

    try {
      for (const file of files) {
        const newFile = new File({
          filename: file.originalname,
          path: file.path,
          size: file.size,
          userId,
        });

        const savedFile = await newFile.save();
        uploadedFiles.push(savedFile);
      }
      res.status(201).json({
        message: "Files uploaded locally successfully",
        data: uploadedFiles.map((f) => ({
          ...f._doc,
          filename: Buffer.from(f.filename, "latin1").toString("utf8"),
          url: `/api/files/${f._id}/download`, // ✅ เพิ่ม URL สำหรับดาวน์โหลด
        })),
      });
    } catch (error) {
      console.error("Upload error:", error);
      res.status(500).json({ message: "Upload failed", error: error.message });
    }
  });
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
  const user = users.find((u) => u._id.toString() === file.userId.toString());
  const decodedName = Buffer.from(file.filename, "latin1").toString("utf8");
  return {
    ...file._doc,
    filename: decodedName,
    user: user ? { ...user.toObject(), _id: undefined } : null,
    url: `/api/files/${file._id}/download` // ✅ ใช้ API route
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
