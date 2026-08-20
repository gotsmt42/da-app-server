// ⚠️ เดิมเขียนว่า `module.exports = checkFile = async (...)` ซึ่ง checkFile ไม่เคยถูกประกาศ
// = สร้างตัวแปร global โดยไม่ตั้งใจ (เหตุผลเดียวกับ middleware/auth.js)
const checkFile = async (req, res, next) => {
  if (req.file) {
    // Cloudinary จะให้ path เป็น URL เต็มอยู่แล้ว
    req.imageUrl = req.file.path;
    req.fileUrl = req.file.path;
    console.log("🟢 Cloudinary image URL set to:", req.file.path);
  }

  next();
};

module.exports = checkFile;
