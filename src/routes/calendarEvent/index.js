const express = require("express");

const registerFiles = require("./files");
const registerDrafts = require("./drafts");
const registerQueries = require("./queries");
const registerWorkflow = require("./workflow");
const registerContracts = require("./contracts");
const registerBilling = require("./billing");
const registerCore = require("./core");

/**
 * /api/events — router ของงานบนปฏิทิน
 *
 * เดิมทั้งหมดนี้อยู่ในไฟล์เดียว routes/calendarEvent.js ยาว 2,708 บรรทัด / 29 route
 * (คิดเป็น 42% ของโค้ด backend ทั้งก้อน) แตกเป็นหมวดตามเรื่องที่ทำ โดย "ยกโค้ดไปทั้งบล็อก"
 * ไม่ได้เขียน logic ใหม่เลยแม้แต่บรรทัดเดียว
 *
 * ⚠️⚠️ ลำดับการ register ด้านล่างสำคัญมาก — Express จับคู่ route ตามลำดับที่ประกาศ
 * ตัวแรกที่ match ชนะ แล้ว "เงียบ" ไม่มี error ให้เห็นเลยถ้าผิด
 *
 * กติกาเดียวที่ต้องจำ: **registerCore ต้องอยู่ท้ายสุดเสมอ**
 * เพราะ core มี route แบบพารามิเตอร์ล้วนที่กินทุกอย่างที่เป็นเซกเมนต์เดียว:
 *     GET /:id   ·   PUT /:id   ·   DELETE /:id
 * ถ้า core ขึ้นก่อน route ที่ชื่อเฉพาะเจาะจงและเป็นเซกเมนต์เดียวเหมือนกันจะโดนกลืนหมด ได้แก่
 *     GET /event-op · GET /drafts · GET /documents   (จะกลายเป็น id ชื่อ "event-op" ฯลฯ)
 *     PUT /basic-info                                 (จะกลายเป็นการแก้งาน id="basic-info")
 *
 * ส่วนภายในแต่ละไฟล์ก็ห้ามสลับลำดับเช่นกัน จุดที่คอขวดจริงคือใน contracts.js:
 *     PUT /contract/merge  ต้องมาก่อน  PUT /contract/:contractGroupId
 *
 * ✅ วิธีตรวจว่าไม่มีอะไรหาย/สลับ: dump ตาราง route ที่ Express ลงทะเบียนจริงแล้วเทียบ
 * (ดูวิธีใน README.md) ตอนนี้ /api/events ต้องได้ 29 route พอดี
 */
const router = express.Router();

registerFiles(router);
registerDrafts(router);
registerQueries(router);
registerWorkflow(router);
registerContracts(router);
registerBilling(router);
registerCore(router); // ⚠️ ต้องท้ายสุดเสมอ — ดูเหตุผลด้านบน

module.exports = router;
