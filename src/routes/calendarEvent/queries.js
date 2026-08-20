/**
 * การอ่านข้อมูลแบบเจาะจงมุมมอง + แก้ไขข้อมูลพื้นฐานหลายงานพร้อมกัน
 *
 * แยกออกมาจาก routes/calendarEvent.js เดิมที่ยาว 2,708 บรรทัดในไฟล์เดียว (29 route)
 * ⚠️ ลำดับการประกาศ route ภายในไฟล์นี้ = ลำดับเดิม ห้ามสลับ (ดูเหตุผลที่ index.js)
 */
const {
  CalendarEvent,
  User,
  verifyToken,
  effectiveResponsibleOrClauses,
  strictResponsibleOrClauses,
} = require("./shared");

module.exports = (router) => {
  router.get("/event-op", verifyToken, async (req, res) => {
    try {
      const userId = req.userId; // ดึง userId จาก Token
      const userRole = req.user.role; // ดึง role ของ User

      // ✅ ป้อนข้อมูลให้ทั้งหน้า "การดำเนินงาน" และ "ภาพรวมงาน" — ผู้ใช้ต้องการให้สองหน้านี้เป็นสิทธิ์ของ
      // "ผู้รับผิดชอบ" (responsiblePerson) โดยเฉพาะ ไม่ใช่ "ทีมที่เข้างาน" (team) เหมือนเดิมอีกต่อไป —
      // ใช้ effectiveResponsibleOrClauses (fallback ไปที่ team/resPerson เฉพาะงานที่ยังไม่เคยตั้งค่า
      // ผู้รับผิดชอบแยกไว้เลย กันงานเก่า/งานที่ยังไม่ได้มอบหมายผู้รับผิดชอบชัดเจนหายไปจากทุกคนกะทันหัน)
      // บวก userId (คนที่เพิ่ม event นี้เอง ให้เห็นงานที่ตัวเองสร้างไว้เสมอแม้จะไม่ได้เป็นผู้รับผิดชอบ/ทีม)
      // ⚠️ BUG ที่แก้: เดิมเช็คแค่ userRole === "admin" (ไม่รวม manager) ทำให้ manager ถูกกรองเหลือแค่งาน
      // ตัวเองด้วย ทั้งที่ทุกจุดอื่นในไฟล์นี้ให้สิทธิ์ manager เท่า admin — แก้ให้ตรงกัน
      // ✅ ตัดงาน "วางแผนล่วงหน้า" (unscheduled) ออกเสมอ — ยังไม่มีวันที่จริง ไม่ควรปนกับงานที่ลงตารางแล้ว
      const isAdminOrManagerRole = ["admin", "manager"].includes(userRole);
      // ✅ "คนที่ต้องไปทำงานนี้" ต้องเห็นงานนี้เสมอ — หัวหน้าทีมที่เข้างาน (team/resPerson) และลูกทีม
      // (teamMembers) ไม่ว่างานนั้นจะมอบหมาย "ผู้รับผิดชอบ" ไว้เป็นใครก็ตาม
      // ⚠️ ต้องแยกออกมาเป็น "clause การมองเห็น" ต่างหาก ห้ามไปรวมใน effectiveResponsibleOrClauses —
      // ฟังก์ชันนั้นมีความหมายว่า "ผู้รับผิดชอบตัวจริง" ซึ่ง fallback ไปที่ทีมได้เฉพาะงานที่ยังไม่มอบหมาย
      // เท่านั้น ถ้าเอา 2 เรื่องมาปนกันจะกลายเป็นว่าหัวหน้าทีม/ลูกทีมได้สิทธิ์ระดับผู้รับผิดชอบไปด้วย
      // 🐛 ที่แก้: ก่อนหน้านี้หัวหน้าทีม (team/resPerson) พึ่ง fallback ใน effectiveResponsibleOrClauses
      // อย่างเดียว พอไปอุดบั๊ก fallback (ให้ทำงานเฉพาะงานที่ยังไม่มอบหมาย) หัวหน้าทีมของงานที่มอบหมาย
      // ผู้รับผิดชอบเป็นคนอื่นไว้แล้ว เลยหลุดหายไปจากหน้าการดำเนินงานโดยไม่ตั้งใจ
      const jobParticipantViewClauses = [
        { team: req.user.fname },
        { resPerson: userId },
        { "teamMembers.userId": userId },
        { "teamMembers.name": req.user.fname },
      ];
      // ✅ ?scope=responsible — โหมดเข้มงวดสำหรับหน้า "ภาพรวมงาน" โดยเฉพาะ: เห็นเฉพาะงานที่ระบุตัวเอง
      // เป็น "ผู้รับผิดชอบหลัก" ไว้ตรงๆ ไม่อิงทีมที่เข้างาน/ลูกทีม และไม่รวมงานที่ยังไม่มอบหมาย
      // ⚠️ ไม่ใส่ { userId } (คนสร้างงาน) ในโหมดนี้ด้วย — ช่างที่สร้างงานไว้เองแต่ถูกมอบหมายให้คนอื่น
      // รับผิดชอบ ก็ไม่ควรเห็นงานนั้นในสรุปความรับผิดชอบของตัวเอง
      // ⚠️ หน้าอื่นที่ใช้ route นี้ (การดำเนินงาน/งานของฉัน/แดชบอร์ด/วางบิล) ไม่ส่ง scope มา จึงได้
      // ตัวกรองเดิมทุกประการ — ช่างยังเห็นงานที่ตัวเองต้องไปทำครบเหมือนเดิม
      const strictScope = req.query.scope === "responsible";
      const query = isAdminOrManagerRole
        ? { unscheduled: { $ne: true } }
        : strictScope
          ? { unscheduled: { $ne: true }, $or: strictResponsibleOrClauses(userId, req.user.fname) }
          : { unscheduled: { $ne: true }, $or: [
              { userId: userId },                                    // ผู้ลงงาน (คนสร้างงานนี้เอง)
              ...effectiveResponsibleOrClauses(userId, req.user.fname), // ผู้รับผิดชอบ
              ...jobParticipantViewClauses,                          // หัวหน้าทีม + ลูกทีม
            ] };

      const userEvents = await CalendarEvent.find(query)
        .sort({ start: -1 })
        .lean();

      const userIds = userEvents.map((event) => event.userId.toString());
      const uniqueUserIds = [...new Set(userIds)];

      const users = await User.find({ _id: { $in: uniqueUserIds } }).lean();

      const userMap = new Map();
      users.forEach((user) => {
        userMap.set(user._id.toString(), user);
      });

      const updatedUserEvents = userEvents.map((event) => {
        const user = userMap.get(event.userId.toString());
        if (user) {
          const { _id, password, ...userDataWithoutId } = user;
          return { ...event, user: userDataWithoutId };
        }
        return event;
      });

      if (!userEvents.length) {
        return res.status(404).json({ message: "ไม่พบข้อมูลปฏิทิน" });
      }

      res.json({ userEvents: updatedUserEvents });
    } catch (err) {
      console.error("❌ Error fetching calendar events:", err);
      res.status(500).send("เกิดข้อผิดพลาดในการดึงข้อมูลปฏิทิน");
    }
  });

  // ✅ รวมไฟล์เอกสารประจำงาน (Service Report/ใบเสนอราคา/ใบวางบิล/ใบส่งมอบงาน) จากทุก event
  // ให้แบนราบเป็นรายการเดียว สำหรับหน้า Files แสดงเป็นตาราง แยกจากไฟล์ทั่วไป (model File เดิม)
  // ต้องอยู่ก่อน "/:id" ไม่งั้น Express จะจับ "documents" เป็นค่า :id แทน
  router.get("/documents", verifyToken, async (req, res) => {
    try {
      const userId = req.userId;
      const userRole = req.user.role;

      const isAdminOrManager = ["admin", "manager"].includes(userRole);
      const query = isAdminOrManager
        ? { unscheduled: { $ne: true } }
        : { unscheduled: { $ne: true }, $or: [
            { resPerson: userId }, { team: req.user.fname }, { userId: userId },
            { responsiblePersonId: userId }, { responsiblePerson: req.user.fname },
          ] };

      const events = await CalendarEvent.find(query)
        .select("docNo company site title system team teamMembers time status reportFiles quotationFiles invoiceFiles completionFiles")
        .sort({ updatedAt: -1 })
        .lean();

      const DOC_TYPE_LABELS = {
        report: "Service Report",
        quotation: "ใบเสนอราคา",
        invoice: "ใบวางบิล",
        completion: "ใบส่งมอบงาน",
      };

      const files = [];
      for (const ev of events) {
        for (const type of ["report", "quotation", "invoice", "completion"]) {
          const arr = ev[`${type}Files`] || [];
          for (const f of arr) {
            files.push({
              fileId: f._id,
              fileName: f.fileName,
              fileUrl: f.fileUrl,
              fileType: f.fileType,
              uploadedAt: f.uploadedAt,
              docType: type,
              docTypeLabel: DOC_TYPE_LABELS[type],
              eventId: ev._id,
              docNo: ev.docNo || "",
              company: ev.company || "",
              site: ev.site || "",
              title: ev.title || "",
              system: ev.system || "",
              team: ev.team || "",
              teamMembers: ev.teamMembers || [],
              time: ev.time || "",
              status: ev.status || "",
            });
          }
        }
      }

      files.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));

      res.json({ files });
    } catch (err) {
      console.error("❌ Error fetching event documents:", err);
      res.status(500).json({ message: "เกิดข้อผิดพลาดในการดึงข้อมูลเอกสารประจำงาน" });
    }
  });

  // ✅ แก้ไขบริษัท/โครงการ/ระบบ/ประเภทงาน พร้อมกันทุก document ของ "แถว" เดียวกันในหน้า "ภาพรวมงาน"
  // (ทั้งสัญญาจริง — ทุกครั้งที่ผูก contractGroupId เดียวกัน — และงานทั่วไป/โปรเจค/ยังไม่จัดกลุ่มที่อาจ
  // เข้าหลายวันไม่ติดกัน ผูกด้วย jobGroupId เดียวกัน) รับ eventIds ตรงๆ จาก frontend (ซึ่งรู้อยู่แล้วว่า
  // แถวนี้ประกอบด้วย document ไหนบ้างจาก groupEventsByContract) แทนที่จะคำนวณ query เองซ้ำฝั่งนี้
  // ⚠️ ต้องประกาศ "ก่อน" PUT /:id (path 1 segment เหมือนกัน "basic-info" vs ":id") ไม่งั้น Express จะจับ
  // "basic-info" เป็นค่า :id ไปแทน route นี้จะไม่มีทางถูกเรียกถึงเลย (เทียบปัญหาเดียวกับ /contract/merge
  // ที่ต้องมาก่อน /contract/:contractGroupId ด้านบน)
  router.put("/basic-info", verifyToken, async (req, res) => {
    try {
      // ✅ docNo/team/resPerson/responsiblePerson เพิ่มเข้ามาให้แก้ไขผ่าน route นี้ได้ด้วย (ใช้กับแถว
      // งานทั่วไป/โปรเจคใน ContractOverview.js ที่ไม่มี contractGroupId จริงให้ใช้ PUT
      // /contract/:contractGroupId เหมือนสัญญาจริง — ดู commitEdit ในหน้านั้น) team/responsiblePerson
      // ของสัญญาจริงยังคงแก้ผ่าน PUT /contract/:contractGroupId เหมือนเดิม (อัปเดตทุกครั้งของสัญญา
      // พร้อมกัน) ไม่ได้มาทาง route นี้
      // ✅ jobValue เพิ่มเข้ามาให้แก้ไขผ่าน route นี้ได้ด้วย — หน้า "ภาพรวมงาน" แสดงมูลค่างานทุกแท็บแล้ว
      // (ไม่ใช่เฉพาะสัญญาจริงเหมือนเดิม) งานทั่วไป/โปรเจค/ยังไม่จัดกลุ่มไม่มี contractGroupId จริงจึงใช้
      // PUT /contract/:contractGroupId ไม่ได้ ต้องมาทางนี้ (เทียบ pattern เดียวกับ docNo) — ส่วนมูลค่างาน
      // ของสัญญาจริงยังแก้ผ่าน /contract/:contractGroupId เหมือนเดิม (อัปเดตทุกครั้งของสัญญาพร้อมกัน)
      // 🐛 BUG ที่แก้ (แท็บที่ไม่ใช่สัญญาใส่ค่าคอมไม่ได้ ขึ้น "ไม่มีข้อมูลให้แก้ไข"): commission ไม่เคยถูก
      // รับเข้ามาใน route นี้เลย — แถวงานทั่วไป/งานโปรเจค/ยังไม่จัดกลุ่มไม่มี contractGroupId จริง จึงส่ง
      // ค่าคอมมาทางนี้ (ดู useBasicInfoEndpoint ใน ContractOverview.js) พอไม่มีใครอ่านค่า update ก็ว่าง
      // เปล่า แล้วตกไปเข้าเงื่อนไข "ไม่มีข้อมูลให้แก้ไข" ด้านล่างทุกครั้ง — ส่วนแท็บสัญญาไม่เจอปัญหาเพราะ
      // ไปอีก route (PUT /contract/:contractGroupId) ซึ่งรองรับ commission อยู่แล้ว
      const { eventIds, company, site, system, title, docNo, team, resPerson, responsiblePerson, responsiblePersonId, jobValue, commission } = req.body;
      if (!Array.isArray(eventIds) || eventIds.length === 0) {
        return res.status(400).json({ message: "ไม่พบรายการที่จะแก้ไข" });
      }
      // ✅ กันค่าติดลบ/ไม่ใช่ตัวเลข (ฝั่งจอเช็คให้แล้วชั้นหนึ่ง — เช็คซ้ำที่นี่เพราะ API เรียกตรงได้เสมอ)
      // ⚠️ ค่าคอมใช้กฎเดียวกับมูลค่างานเป๊ะๆ ทั้งคู่เป็นจำนวนเงิน ติดลบไม่ได้ และล้างค่าด้วย "" ได้
      for (const [value, label] of [[jobValue, "มูลค่างาน"], [commission, "ค่าคอมมิชชั่น"]]) {
        if (value !== undefined && value !== null && value !== "") {
          const n = Number(value);
          if (Number.isNaN(n) || n < 0) {
            return res.status(400).json({ message: `${label}ต้องเป็นตัวเลขและต้องไม่ติดลบ` });
          }
        }
      }

      const isAdminOrManager = ["admin", "manager"].includes(req.user.role);
      if (!isAdminOrManager) {
        // ✅ ผู้รับผิดชอบงานแก้ไข "ทีมที่เข้างาน" (team/resPerson) ของแต่ละครั้งได้อยู่แล้ว (ดู
        // beginRoundTeamEdit ใน ContractOverview.js) — ตอนนี้เพิ่มให้แก้ไขข้อมูลพื้นฐาน (บริษัท/โครงการ/
        // ระบบ/ประเภทงาน/เอกสาร) ของ "งานทั่วไป/งานโปรเจคที่ตัวเองรับผิดชอบ" ได้ด้วยตามที่ผู้ใช้ขอ — ยกเว้น
        // การมอบหมาย "ผู้รับผิดชอบ" เอง (responsiblePerson/responsiblePersonId) ยังคงเฉพาะแอดมิน/manager
        // เท่านั้น (ไม่ให้โยนความรับผิดชอบทิ้งเองได้) และงานตามสัญญาจริงยังคงเฉพาะแอดมิน/manager ทุกฟิลด์
        // เหมือนเดิม (เช็คจาก contractGroupId ด้านล่าง) เพราะต้องผ่านการตรวจสอบจากส่วนกลางก่อนเสมอ
        if (responsiblePerson !== undefined || responsiblePersonId !== undefined) {
          return res.status(403).json({ message: "เฉพาะแอดมิน/manager เท่านั้นที่มอบหมายผู้รับผิดชอบได้" });
        }
        // ✅ มูลค่างานเป็นข้อมูลการเงิน — ให้แก้ได้เฉพาะแอดมิน/manager เท่านั้นเหมือนกัน (ผู้รับผิดชอบงาน
        // แก้ข้อมูลพื้นฐานของงานตัวเองได้ก็จริง แต่ไม่ควรแก้ตัวเลขมูลค่าเองได้) — ตรงกับฝั่งจอที่เปิดให้
        // แก้ช่องนี้เฉพาะ isAdminOrManager อยู่แล้ว (ดู ContractOverview.js)
        // ⚠️ ค่าคอมต้องถูกกันด้วยเงื่อนไขเดียวกับมูลค่างาน — เป็นข้อมูลการเงินเหมือนกัน และฝั่งจอก็เปิดให้
        // แก้เฉพาะ isAdminOrManager อยู่แล้ว (ดู editable ของช่อง commission ใน ContractOverview.js)
        // ถ้าลืมกันตรงนี้จะกลายเป็นช่องโหว่ที่ยิง API ตรงๆ แล้วผู้รับผิดชอบงานแก้ตัวเลขค่าคอมเองได้
        if (jobValue !== undefined) {
          return res.status(403).json({ message: "เฉพาะแอดมิน/manager เท่านั้นที่แก้ไขมูลค่างานได้" });
        }
        if (commission !== undefined) {
          return res.status(403).json({ message: "เฉพาะแอดมิน/manager เท่านั้นที่แก้ไขค่าคอมมิชชั่นได้" });
        }
        // ✅ ต้องเป็น "ผู้รับผิดชอบ" ของทุก event ที่จะแก้ไขจริง (เช็คค่าที่ตั้งไว้ตรงๆ ไม่ fallback ไปที่
        // ทีมที่เข้างาน — สิทธิ์นี้ต้องถูกมอบหมายไว้ชัดเจนก่อนเท่านั้น เทียบ
        // pattern เดียวกับ canEditTeamAssignment ใน EditEvent.js) และห้ามเป็นงานตามสัญญาจริงเด็ดขาด
        const targetEvents = await CalendarEvent.find({ _id: { $in: eventIds } })
          .select("responsiblePersonId responsiblePerson contractGroupId").lean();
        const userId = req.userId;
        const isAllResponsible = targetEvents.length === eventIds.length && targetEvents.every((e) =>
          !e.contractGroupId && (
            (e.responsiblePersonId && e.responsiblePersonId === userId) ||
            (e.responsiblePerson && e.responsiblePerson === req.user.fname)
          )
        );
        if (!isAllResponsible) {
          return res.status(403).json({ message: "คุณไม่มีสิทธิ์แก้ไขงานนี้" });
        }
      }

      const update = {};
      if (company !== undefined) update.company = company;
      if (site !== undefined) update.site = site;
      if (system !== undefined) update.system = system;
      if (title !== undefined) update.title = title;
      if (docNo !== undefined) update.docNo = docNo;
      if (team !== undefined) update.team = team;
      if (resPerson !== undefined) update.resPerson = resPerson;
      if (responsiblePerson !== undefined) update.responsiblePerson = responsiblePerson;
      if (responsiblePersonId !== undefined) update.responsiblePersonId = responsiblePersonId;
      // ✅ ล้างค่าได้ด้วยการส่ง "" มา (ให้กลับไปเป็น "ยังไม่ระบุ") ไม่งั้นลบค่าที่เคยใส่ผิดไว้ไม่ได้เลย
      if (jobValue !== undefined) update.jobValue = (jobValue === "" || jobValue === null) ? null : Number(jobValue);
      if (commission !== undefined) update.commission = (commission === "" || commission === null) ? null : Number(commission);
      if (Object.keys(update).length === 0) {
        return res.status(400).json({ message: "ไม่มีข้อมูลให้แก้ไข" });
      }
      await CalendarEvent.updateMany({ _id: { $in: eventIds } }, { $set: update });
      const updatedEvents = await CalendarEvent.find({ _id: { $in: eventIds } }).lean();
      res.json({ events: updatedEvents });
    } catch (error) {
      console.error("❌ Error updating basic info:", error);
      res.status(500).send("Internal Server Error");
    }
  });
};
