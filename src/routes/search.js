/**
 * /api/search — ค้นหารวมข้ามงานและลูกค้าจากช่องเดียว
 *
 * ✅ ที่มา: แอปมีช่องค้นหาแยกอยู่ในแต่ละหน้ารวม 16 หน้า แต่ไม่มีที่ไหนค้นข้ามได้เลย
 *    คนที่รู้แค่ "ชื่อลูกค้า" หรือ "เลขที่เอกสาร" ต้องเดาเองก่อนว่าของที่หาอยู่หน้าไหน
 *
 * 🔒 การมองเห็นต้องเท่ากับหน้ารายการของแต่ละเรื่องเป๊ะๆ — ค้นหาต้องไม่กลายเป็นช่องโหว่
 *    ที่ทำให้เห็นงานที่ปกติมองไม่เห็น จึงใช้ตัวกรองชุดเดียวกับ routes/calendarEvent/queries.js
 *    (viewAllJobs + withDepartmentScope) ไม่ได้เขียนเงื่อนไขขึ้นใหม่
 * ⚠️ ลูกค้าเป็น master list ที่ทุกคนที่ล็อกอินเห็นเท่ากันอยู่แล้ว (ดู routes/customer.js)
 *    จึงไม่ต้องกรองเพิ่ม
 * ⚠️ ออกแบบให้เพิ่มกลุ่มใหม่ได้ง่าย (เอกสาร/ใบเบิก) — แต่ละกลุ่มต้องมาพร้อมตัวกรองสิทธิ์ของตัวเอง
 *    ห้ามเพิ่มกลุ่มโดยไม่คิดเรื่องการมองเห็น
 */
const express = require("express");

const Customer = require("../models/Customer");
const verifyToken = require("../middleware/auth");
const { CalendarEvent, can, withDepartmentScope, moment } = require("./calendarEvent/shared");

const router = express.Router();

/** สั้นกว่านี้ผลลัพธ์จะกว้างเกินจนไม่มีประโยชน์ และเปลืองงานฐานข้อมูลทุกตัวอักษรที่พิมพ์ */
const MIN_CHARS = 2;
/** จำนวนผลลัพธ์ต่อกลุ่ม — พอให้เห็นว่า "ใช่อันนี้ไหม" ไม่ใช่หน้ารายการเต็ม */
const PER_GROUP = 6;

/**
 * ⚠️ ต้อง escape ก่อนเอาไปทำ RegExp เสมอ — ผู้ใช้พิมพ์ "(" หรือ "*" มาแล้ว query จะพังทั้งคำขอ
 *    และรูปแบบอย่าง "(a+)+" ยังทำให้ regex วิ่งนานผิดปกติจนเซิร์ฟเวอร์อืดได้
 */
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

router.get("/", verifyToken, async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    if (q.length < MIN_CHARS) return res.json({ query: q, groups: [] });

    const rx = new RegExp(escapeRegex(q), "i");
    const userId = req.userId;

    // ── งาน — การมองเห็นเท่ากับหน้าตารางงาน/การดำเนินงาน ────────────────────
    const ownJobClauses = [
      { resPerson: userId }, { userId }, { responsiblePersonId: userId },
      { team: req.user?.fname }, { responsiblePerson: req.user?.fname },
    ];
    const jobVisibility = can(req.user, "viewAllJobs") ? {} : { $or: ownJobClauses };
    const jobMatch = {
      $or: [{ title: rx }, { site: rx }, { company: rx }, { docNo: rx }, { contactName: rx }, { contractNo: rx }],
    };
    // ⚠️ ห้ามรวม $or สองชุดด้วยการ spread ทับกัน — ตัวหลังจะกลืนตัวแรกทิ้งแล้วกลายเป็นเห็นทุกงาน
    const jobQuery = jobVisibility.$or ? { $and: [jobVisibility, jobMatch] } : jobMatch;

    const [jobs, customers] = await Promise.all([
      CalendarEvent.find(withDepartmentScope(jobQuery, req))
        .select("title site company docNo status date start")
        .sort({ date: -1, createdAt: -1 })
        .limit(PER_GROUP)
        .lean(),
      Customer.find({ $or: [{ cCompany: rx }, { cSite: rx }, { cName: rx }, { tel: rx }, { cEmail: rx }] })
        .select("cCompany cSite cName tel")
        .limit(PER_GROUP)
        .lean(),
    ]);

    const groups = [
      {
        key: "jobs",
        label: "งาน",
        items: jobs.map((j) => ({
          id: String(j._id),
          title: j.title || j.site || "(ไม่มีชื่องาน)",
          // บรรทัดรองต้องพอให้ "ชี้ตัวถูก" ได้เมื่อชื่องานซ้ำกันหลายใบ
          // ⚠️ ต้องมีวันที่ด้วย — ของจริงมีงานชื่อ "Service" ที่ไซต์เดียวกันสถานะเดียวกันหลายใบ
          //    ถ้าไม่มีวันที่จะแยกไม่ออกเลยว่าอันไหนคืออันที่หาอยู่
          sub: [
            j.company || j.site,
            j.docNo,
            j.status,
            j.date || j.start ? moment(j.date || j.start).format("D MMM YY") : "",
          ].filter(Boolean).join(" · "),
          href: `/operation/${j._id}`,
        })),
      },
      {
        key: "customers",
        label: "ลูกค้า",
        items: customers.map((c) => ({
          id: String(c._id),
          title: c.cCompany || c.cSite || c.cName || "(ไม่มีชื่อ)",
          sub: [c.cSite, c.cName, c.tel].filter(Boolean).join(" · "),
          href: "/customers",
        })),
      },
    ].filter((g) => g.items.length);

    res.json({ query: q, groups });
  } catch (err) {
    console.error("❌ ค้นหารวมไม่สำเร็จ:", err);
    res.status(500).json({ message: "ค้นหาไม่สำเร็จ" });
  }
});

module.exports = router;
