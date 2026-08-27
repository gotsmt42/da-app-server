const path = require("path");

/**
 * ที่เดียวที่รู้ว่าโฟลเดอร์ไฟล์อัปโหลด/รูปภาพอยู่ตรงไหนบนดิสก์
 *
 * 🐛 ทำไมต้องมีไฟล์นี้: เดิมแต่ละไฟล์นับ `../` เอาเองจากตำแหน่งของตัวเอง เช่น
 *   routes/file.js        →  path.join(__dirname, "../asset/uploads/files")
 *   index.js              →  path.join(__dirname, "asset/uploads")
 * พอย้ายซอร์สทั้งชุดเข้า src/ ความลึกเปลี่ยน path พวกนี้ก็ชี้ผิดทันที — และเป็นความผิดพลาดที่
 * `node --check` กับ ESLint จับไม่ได้เลย รู้ตัวอีกทีคือผู้ใช้อัปโหลดไฟล์แล้วพัง
 *
 * รวมมาไว้ที่เดียว = ย้ายโฟลเดอร์อีกกี่ครั้งก็แก้ที่ไฟล์นี้ไฟล์เดียว
 *
 * ⚠️ ใช้ค่าจากไฟล์นี้เสมอ อย่าเขียน path แบบ relative-to-cwd (เช่น "asset/uploads/images/")
 * เพราะมันขึ้นกับว่า "สั่งรันจากโฟลเดอร์ไหน" ไม่ใช่ว่าโค้ดอยู่ที่ไหน — รันจากที่อื่นแล้วไฟล์จะไปโผล่ผิดที่
 */
const PROJECT_ROOT = path.resolve(__dirname, "../..");
const ASSET_DIR = path.join(PROJECT_ROOT, "asset");
const UPLOADS_DIR = path.join(ASSET_DIR, "uploads");

module.exports = {
  PROJECT_ROOT,
  ASSET_DIR,
  UPLOADS_DIR,
  UPLOAD_FILES_DIR: path.join(UPLOADS_DIR, "files"),
  UPLOAD_IMAGES_DIR: path.join(UPLOADS_DIR, "images"),
  IMAGE_DIR: path.join(ASSET_DIR, "image"),
};
