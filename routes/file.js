const express = require("express");
const router = express.Router();
const File = require("../models/File");
const User = require("../models/User");
const verifyToken = require("../middleware/auth");

const multer = require("multer");
const fs = require("fs");

const LineNotify = require("../services/LineNotify");


// Route to upload multiple files
router.post("/", verifyToken, async (req, res) => {
  try {
    // เรียกใช้ multer middleware และกำหนด storage ที่เราเขียนขึ้นข้างบน
    const storage = multer.diskStorage({
      destination: (req, file, callback) => {
        callback(null, "asset/uploads/files/");
      },
      filename: async (req, file, callback) => {
        const decodedFilename = decodeURIComponent(file.originalname);
        let newFilename = decodedFilename;
        let count = 1;

        try {
          while (await File.findOne({ filename: newFilename })) {
            const extensionIndex = decodedFilename.lastIndexOf(".");
            const name = decodedFilename.substring(0, extensionIndex);
            const extension = decodedFilename.substring(extensionIndex);

            // สร้างชื่อใหม่โดยเพิ่มเลขลำดับท้ายชื่อไฟล์
            newFilename = `${name} (${count})${extension}`;
            count++;
          }

          callback(null, newFilename);
        } catch (error) {
          callback(error);
        }
      },
    });

    const upload = multer({ storage: storage }).array("files");

    upload(req, res, async (err) => {
      if (err) {
        console.error("Error uploading files:", err);
        return res.status(500).send(err.message);
      }

      const files = req.files;
      const userId = req.userId;

      const uploadedFiles = [];

      for (let file of files) {
        const { filename, path, size } = file;

        const newFile = new File({
          filename,
          path,
          size,
          userId,
        });

        const savedFile = await newFile.save();

        uploadedFiles.push(savedFile);
      }
      // ส่งข้อความผ่าน Line Notify เมื่อมีการอัปโหลดไฟล์เสร็จสิ้น
      LineNotify(uploadedFiles, userId);

      res.status(201).json({
        message: "Files uploaded successfully",
        data: uploadedFiles,
      });
    });
  } catch (err) {
    console.error("Failed to upload files:", err);
    res.status(500).send(err.message);
  }
});

// Route to get all files
router.get("/", verifyToken, async (req, res) => {
  try {
    let userFiles;

    if (req.user.role === "admin") {
      userFiles = await File.find({});
    } else {
      userFiles = await File.find({ userId: req.userId });
    }

    // ดึง userId ทั้งหมดจาก userFiles
    const userIds = userFiles.map((file) => file.userId);

    // ค้นหาข้อมูลผู้ใช้จาก model User โดยใช้ userIds
    const users = await User.find({ _id: { $in: userIds } });

    // แปลงค่า userId ใน userFiles จากข้อมูลใน users
    const updatedUserFiles = userFiles.map((file) => {
      const user = users.find(
        (user) => user._id.toString() === file.userId.toString()
      );
      if (user) {
        // คัดลอกค่าทั้งหมดของผู้ใช้ยกเว้น _id
        const { _id, ...userDataWithoutId } = user.toObject();
        return { ...file._doc, user: userDataWithoutId }; // เพิ่ม property user ที่มีค่าข้อมูลผู้ใช้ยกเว้น _id
      } else {
        return file; // ถ้าไม่พบ user ให้ใช้ค่าเดิมของ file
      }
    });

    res.json({ userFiles: updatedUserFiles });
  } catch (err) {
    console.error("Error fetching users:", err);
    res.status(500).send(err.message);
  }
});

// Route to delete a file
router.delete("/:id", verifyToken, async (req, res) => {
  try {
    const id = req.params.id;

    const fileToDelete = await File.findById(id);
    if (!fileToDelete) {
      return res.status(404).send("File not found.");
    }

    // // Check if the authenticated user is the owner of the file or an admin
    // if (fileToDelete.userId !== req.userId && req.user.role !== "admin") {
    //   return res.status(403).send("Unauthorized to delete this file.");
    // }

    // Delete file data from database
    await File.findByIdAndDelete(id);

    // // Check if the file exists in disk
    // if (!fs.existsSync(fileToDelete.path)) {
    //   return res.status(404).send("File not found in disk.");
    // }

    // // Delete file from disk
    // fs.unlink(fileToDelete.path, async (err) => {
    //   if (err) {
    //     console.error("Error deleting file from disk:", err);
    //     return res.status(500).send("Error deleting file from disk.");
    //   }

    //   res.status(200).send("File deleted successfully");
    // });
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
