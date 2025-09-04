const express = require("express");
const router = express.Router();
const multer = require("multer");
const File = require("../models/File");
const User = require("../models/User");
const verifyToken = require("../middleware/auth");
const bucket = require("../firebaseConfig");

const storage = multer.memoryStorage();
const upload = multer({ storage }).array("files");

function sanitizeFilename(name) {
  return name.replace(/\s+/g, "_").replace(/[^\w.-]/g, "");
}

router.post("/", verifyToken, (req, res) => {
  upload(req, res, async (err) => {
    if (err) return res.status(500).send("Error uploading files.");

    const files = req.files;
    if (!files || files.length === 0)
      return res.status(400).json({ message: "No files uploaded" });

    const userId = req.userId;
    const uploadedFiles = [];

    for (const file of files) {
      const originalName = decodeURIComponent(file.originalname);
      const sanitized = sanitizeFilename(originalName);
      const blob = bucket.file(`uploads/${sanitized}`);

      const blobStream = blob.createWriteStream({
        metadata: { contentType: file.mimetype },
      });

      await new Promise((resolve, reject) => {
        blobStream.on("error", reject);

        blobStream.on("finish", async () => {
          const publicUrl = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(blob.name)}?alt=media`;

          const newFile = new File({
            filename: originalName,
            path: publicUrl,
            size: file.size,
            userId,
          });

          const savedFile = await newFile.save();
          uploadedFiles.push(savedFile);
          resolve();
        });

        blobStream.end(file.buffer);
      });
    }

    res.status(201).json({
      message: "Files uploaded to Firebase successfully",
      data: uploadedFiles,
    });
  });
});

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

    const updatedUserFiles = userFiles.map((file) => {
      const user = users.find(
        (user) => user._id.toString() === file.userId.toString()
      );
      if (user) {
        const { _id, ...userDataWithoutId } = user.toObject();
        return { ...file._doc, user: userDataWithoutId };
      } else {
        return file;
      }
    });

    res.json({ userFiles: updatedUserFiles });
  } catch (err) {
    console.error("Error fetching users:", err);
    res.status(500).send(err.message);
  }
});

router.delete("/:id", verifyToken, async (req, res) => {
  try {
    const id = req.params.id;

    const file = await File.findByIdAndDelete(id);
    if (file) {
      const firebasePath = file.path.split("/o/")[1].split("?")[0];
      const decodedPath = decodeURIComponent(firebasePath);
      await bucket.file(decodedPath).delete().catch((err) => {
        console.warn("Firebase file delete failed:", err.message);
      });
    }

    res.status(200).send("File deleted successfully");
  } catch (err) {
    console.error("Error deleting file:", err);
    if (err.response && err.response.status === 404) {
      return res.status(404).send("File not found.");
    }
    res.status(500).send(err.message);
  }
});

module.exports = router;
