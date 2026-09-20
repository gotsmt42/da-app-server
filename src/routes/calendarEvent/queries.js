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
  can,
  effectiveResponsibleOrClauses,
  strictResponsibleOrClauses,
  withDepartmentScope,
  isServiceObserver,
  DEPARTMENT,
} = require("./shared");

module.exports = (router) => {
  router.get("/event-op", verifyToken, async (req, res) => {
    try {
      const userId = req.userId; // ดึง userId จาก Token

      // ✅ ป้อนข้อมูลให้ทั้งหน้า "การดำเนินงาน" และ "ภาพรวมงาน" — ผู้ใช้ต้องการให้สองหน้านี้เป็นสิทธิ์ของ
      // "ผู้รับผิดชอบ" (responsiblePerson) โดยเฉพาะ ไม่ใช่ "ทีมที่เข้างาน" (team) เหมือนเดิมอีกต่อไป —
      // ใช้ effectiveResponsibleOrClauses (fallback ไปที่ team/resPerson เฉพาะงานที่ยังไม่เคยตั้งค่า
      // ผู้รับผิดชอบแยกไว้เลย กันงานเก่า/งานที่ยังไม่ได้มอบหมายผู้รับผิดชอบชัดเจนหายไปจากทุกคนกะทันหัน)
      // บวก userId (คนที่เพิ่ม event นี้เอง ให้เห็นงานที่ตัวเองสร้างไว้เสมอแม้จะไม่ได้เป็นผู้รับผิดชอบ/ทีม)
      // ⚠️ BUG ที่แก้: เดิมเช็คแค่ userRole === "admin" (ไม่รวม manager) ทำให้ manager ถูกกรองเหลือแค่งาน
      // ตัวเองด้วย ทั้งที่ทุกจุดอื่นในไฟล์นี้ให้สิทธิ์ manager เท่า admin — แก้ให้ตรงกัน
      // ✅ ตัดงาน "วางแผนล่วงหน้า" (unscheduled) ออกเสมอ — ยังไม่มีวันที่จริง ไม่ควรปนกับงานที่ลงตารางแล้ว
      const isAdminOrManagerRole = can(req.user, "viewAllJobs");
      // ✅ เซลที่เปิดดู "ตารางงานช่าง" (?dept=service) ต้องเห็นงานของช่างทั้งแผนก — อ่านอย่างเดียว
      // ⚠️ ต้องข้ามตัวกรอง "งานของฉัน" ด้วย ไม่งั้นจะเห็นศูนย์รายการเสมอ — เซลไม่มีทางมีชื่ออยู่ในงานช่างอยู่แล้ว
      // ⚠️ การขยายนี้เป็น "สิทธิ์อ่าน" ล้วนๆ — ด่านกันเขียน (PUT/DELETE) ไม่ได้ถูกแตะเลย
      const serviceObserver = isServiceObserver(req.user, req.query.dept);
      const seesAllJobs = isAdminOrManagerRole || serviceObserver;
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
      const query = seesAllJobs
        ? { unscheduled: { $ne: true } }
        : strictScope
          ? { unscheduled: { $ne: true }, $or: strictResponsibleOrClauses(userId, req.user.fname) }
          : { unscheduled: { $ne: true }, $or: [
              { userId: userId },                                    // ผู้ลงงาน (คนสร้างงานนี้เอง)
              ...effectiveResponsibleOrClauses(userId, req.user.fname), // ผู้รับผิดชอบ
              ...jobParticipantViewClauses,                          // หัวหน้าทีม + ลูกทีม
            ] };

      // ✅ กรองตามแผนกก่อนเสมอ — เซลเห็นเฉพาะแผนงานฝ่ายขาย ช่างเห็นเฉพาะงานบริการ
      /**
      * โหมด "เอาเฉพาะที่ใช้สรุป" — สำหรับหน้ารายงานที่ไม่ได้แสดงไฟล์แนบ/คอมเมนต์/ประวัติกิจกรรม
      *
      * ⚠️ เอกสารงานหนึ่งใบหนักราว 3.7 KB โดย activityLog กินไปเกือบครึ่ง (วัดจากข้อมูลจริง)
      *    ที่ 1000 งานจึงเป็นราว 3.6 MB ต่อการเปิดหน้าหนึ่งครั้ง — หน้ารายงานใช้แค่ 15 ฟิลด์
      *    โหมดนี้จึงลดขนาดลงราว 10 เท่า
      * ⚠️ ฟิลด์ในลิสต์นี้ตัดทิ้งไม่ได้ตามใจ — getOverdueGroupKey ใช้ company/site/title/system/
      *    team/time/jobGroupId ส่วน buildDaysPastDueMap ใช้ start/end/allDay/status/
      *    closeRequested/approvalStatus ถ้าขาดตัวใดตัวหนึ่ง ตัวเลข "ค้างงาน" จะเพี้ยนเงียบๆ
      */
      const SLIM_FIELDS = "status start end allDay date system company site title team time "
        + "jobGroupId closeRequested approvalStatus responsiblePerson userId";
      const slim = req.query.slim === "1" || req.query.slim === "true";

      /**
      * ✅ ค่าเริ่มต้น "ไม่ส่งประวัติกิจกรรม" — วัดจากข้อมูลจริงแล้ว activityLog กินพื้นที่ 58.5% ของ
      *    ทั้ง response คนเดียว (1,708 จาก 2,850 bytes ต่อแถว) ทั้งที่มีแค่ 4 หน้าที่อ่านมันจริง
      *    ตัวที่เจ็บที่สุดคือป้ายตัวเลขบนเมนู (useAppBadges) ซึ่ง poll ทุก 30 วินาทีตลอดเวลาที่เปิดแอป
      *    ที่ 1000 งาน = ดาวน์โหลด 3.6 MB ทุกครึ่งนาทีต่อผู้ใช้หนึ่งคน เพื่อนับเลขไม่กี่ตัว
      * ⚠️ ทำเป็น "ไม่ส่งโดยปริยาย + ขอเพิ่มเมื่อต้องใช้" ไม่ใช่ "ส่งโดยปริยาย + สั่งตัดเมื่อไม่ใช้"
      *    หน้าใหม่ที่เขียนทีหลังจะได้ค่าที่เบาอัตโนมัติ โดยไม่ต้องรู้เรื่องนี้มาก่อน
      * ⚠️ หน้าที่ต้องส่ง detail=1 (ไล่ทั้ง src แล้ว): การดำเนินงาน · งานของฉัน · ติดตามใบเสนอราคา ·
      *    ภาพรวมสัญญา — สามหน้าแรกทำ read-modify-write กับ activityLog ด้วย (อ่านมาทั้งก้อน
      *    ต่อท้ายรายการใหม่ แล้วเขียนกลับ) ถ้าหน้าไหนได้ก้อนเปล่าไปแล้วบันทึก ประวัติจะถูกลบทิ้งทั้งชุด
      */
      const detail = req.query.detail === "1" || req.query.detail === "true";

      const userEvents = await CalendarEvent.find(withDepartmentScope(query, req))
        .select(slim ? SLIM_FIELDS : (detail ? undefined : "-activityLog"))
        .sort({ start: -1 })
        .lean();

      // โหมด slim ไม่ต้องแนบข้อมูลผู้ใช้เต็มก้อน (ราว 380 bytes ต่อแถว) — รายงานไม่ได้ใช้
      if (slim) return res.json({ userEvents });

      const userIds = userEvents.map((event) => event.userId.toString());
      const uniqueUserIds = [...new Set(userIds)];

      /**
      * ✅ เอาเฉพาะ "ชื่อคนสร้างงาน" พอ — ไม่ใช่ทั้งโปรไฟล์
      * ⚠️ เดิมแนบ user ทั้งก้อน (ตัดแค่ password) = 380 bytes ต่อแถว หรือ 12.3% ของทั้ง response
      *    โดย imageUrl (URL รูปโปรไฟล์) กินไป 91 bytes ทั้งที่ไม่มีหน้าไหนเอาไปแสดงเลย
      *    และยังมี email/tel/jobTitle ติดไปทุกแถวด้วย ซึ่งเป็นข้อมูลติดต่อของพนักงาน
      *    ไม่ควรกระจายไปกับรายการงานโดยไม่มีใครขอ
      * ⚠️ ไล่ทั้ง src ฝั่งหน้าเว็บแล้ว มีที่เดียวที่อ่าน event.user คือ useEventNotifications
      *    ซึ่งใช้ fname/lname/username ทำเป็นชื่อผู้ส่ง — role/rank ใส่เพิ่มไว้เผื่อ (รวมแค่ 21 bytes)
      */
      const users = await User.find({ _id: { $in: uniqueUserIds } })
        .select("fname lname username role rank")
        .lean();

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

      // 🐛 ที่แก้: เดิมตอบ 404 เมื่อผู้ใช้ยังไม่มีงานเลย — "ไม่มีข้อมูล" ไม่ใช่ "ไม่พบเส้นทาง"
      // ผลคือผู้ใช้ใหม่ทุกคน (และเซลทุกคน ซึ่งไม่มีงานช่างอยู่แล้วโดยธรรมชาติ) จะเจอ error ใน
      // console ทุกครั้งที่เปิด Dashboard/Header และจุดที่เรียก route นี้ต้องดัก .catch() ไว้เอง
      // ทุกที่ (ซึ่งหลายที่ทำอยู่แล้วด้วยการแปลงกลับเป็น { userEvents: [] } — ตรงกับที่คืนตรงนี้เลย)
      // ✅ รายการว่างคือคำตอบที่ถูกต้อง ตอบ 200 พร้อม array ว่าง

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

      const isAdminOrManager = can(req.user, "viewAllJobs");
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

  /**
   * ✅ จัดลำดับงานภายใน "วันเดียวกัน" บนปฏิทิน — ผู้ใช้ลากสลับบน/ล่างเองได้
   *
   * รับมาเป็นลิสต์ [{ id, displayOrder }] ทีเดียวทั้งวัน แทนที่จะให้ frontend ยิง PUT /:id ทีละใบ
   * ⚠️ เหตุผลที่ต้องเป็นคำขอเดียว: การเรียงคือ "ผลลัพธ์ของทั้งวัน" ถ้ายิงแยกแล้วสำเร็จบ้างล้มบ้าง
   * ลำดับจะเพี้ยนค้างอยู่แบบครึ่งๆ (บางใบเลขใหม่ บางใบเลขเก่า) ซึ่งกู้คืนเองไม่ได้เลย
   *
   * ⚠️ ต้องประกาศ "ก่อน" PUT /:id เหมือน /basic-info ด้านล่าง ไม่งั้น Express จะจับ "reorder"
   * เป็นค่า :id แล้ว route นี้จะไม่มีวันถูกเรียกถึง
   */
  router.put("/reorder", verifyToken, async (req, res) => {
    try {
      const { items } = req.body;
      if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ message: "ไม่มีรายการให้จัดลำดับ" });
      }
      // ⚠️ จำกัดจำนวนต่อคำขอ — ลำดับเป็นเรื่องของ "งานในวันเดียว" ซึ่งมีไม่กี่สิบใบเป็นอย่างมาก
      // ถ้ามีมากผิดปกติแปลว่าฝั่งเรียกส่งผิด ไม่ควรปล่อยให้ไปเขียนฐานข้อมูลเป็นพันแถวรวดเดียว
      if (items.length > 200) {
        return res.status(400).json({ message: "รายการมากเกินไป" });
      }
      const ops = [];
      for (const it of items) {
        const order = Number(it?.displayOrder);
        if (!it?.id || !Number.isFinite(order)) continue;
        ops.push({
          updateOne: { filter: { _id: it.id }, update: { $set: { displayOrder: order } } },
        });
      }
      if (ops.length === 0) {
        return res.status(400).json({ message: "ไม่มีรายการที่ถูกต้อง" });
      }

      // ✅ ตรวจสิทธิ์จาก "งานจริงในฐานข้อมูล" ไม่ใช่เชื่อ id ที่ส่งมา — และต้องผ่าน departmentScope
      // ด้วย เพื่อไม่ให้ข้ามแผนกไปจัดลำดับงานที่ตัวเองมองไม่เห็นด้วยซ้ำ
      const ids = ops.map((o) => o.updateOne.filter._id);
      const targets = await CalendarEvent.find(
        withDepartmentScope({ _id: { $in: ids } }, req)
      ).select("_id").lean();
      if (targets.length !== ids.length) {
        return res.status(403).json({ message: "มีงานที่คุณไม่มีสิทธิ์จัดลำดับ" });
      }

      await CalendarEvent.bulkWrite(ops);
      res.json({ message: "จัดลำดับเรียบร้อย", updated: ops.length });
    } catch (error) {
      console.error("❌ Error reordering events:", error);
      res.status(500).json({ message: "จัดลำดับไม่สำเร็จ" });
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
      const { eventIds, company, site, system, title, docNo, team, resPerson, responsiblePerson, responsiblePersonId, jobValue, commission, departmentTag, statusNote, remark, contactName, contactTel } = req.body;
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

      const isAdminOrManager = can(req.user, "editContracts");
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
      // ✅ ป้ายกำกับแผนกของงานทั่วไป/โปรเจค (แถวที่ไม่มี contractGroupId จริง จึงใช้ /contract/:id ไม่ได้
      // — เทียบ pattern เดียวกับ jobValue/commission ด้านบน) ⚠️ ต้องเป็นค่าที่ schema รู้จักเท่านั้น
      // ⚠️ ไม่ใช่ฟิลด์ department ที่คุมขอบเขตการมองเห็น — ตัวนี้เป็นข้อมูลประกอบสำหรับดู/กรอง/รายงานล้วนๆ
      if (departmentTag !== undefined) {
        if (!Object.values(DEPARTMENT).includes(departmentTag)) {
          return res.status(400).json({ message: "แผนกไม่ถูกต้อง" });
        }
        update.departmentTag = departmentTag;
      }
      // ✅ หมายเหตุสถานะของงานทั่วไป/โปรเจค — เทียบ pattern เดียวกับ departmentTag ด้านบน
      if (statusNote !== undefined) update.statusNote = String(statusNote || "").trim();
      if (remark !== undefined) update.remark = String(remark || "").trim();
      // ✅ ผู้ติดต่อหน้างาน — แก้ได้จากหน้าภาพรวมงานเหมือนช่องข้อมูลพื้นฐานอื่น
      if (contactName !== undefined) update.contactName = String(contactName || "").trim();
      if (contactTel !== undefined) update.contactTel = String(contactTel || "").trim();
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
  /**
   * GET /api/events/contracts — รายชื่อ "สัญญาที่ยังเพิ่มครั้งได้" สำหรับเอาไปให้เลือกในฟอร์ม
   *
   * ✅ ทำไมต้องมี endpoint นี้ ทั้งที่หน้า "ภาพรวมงาน"/ฟอร์มของช่างจัดกลุ่มเองได้จาก events ที่โหลดมาแล้ว:
   * ฟอร์มแจ้งงานของเซลไม่ได้โหลด events ทั้งแผนกไว้อยู่แล้ว การจะให้เลือกสัญญาได้ต้องดึงงานฝ่ายช่าง
   * ทั้งหมดมาแค่เพื่อสร้าง dropdown ตัวเดียว ซึ่งเปลืองทั้งเน็ตและเวลาเปิดกล่องโดยไม่จำเป็น —
   * ตรงนี้ยุบให้เหลือเฉพาะข้อมูลระดับ "สัญญา" ที่ต้องใช้จริง
   *
   * ⚠️ ใช้ withDepartmentScope ตัวเดียวกับทุก route ในไฟล์นี้ — เซลอ่านสัญญาฝ่ายช่างได้เมื่อส่ง
   * ?dept=service เท่านั้น (สิทธิ์ viewServiceCalendar) ไม่ได้เปิดช่องทางอ่านใหม่ที่ไหนเพิ่ม
   * ⚠️ อ่านอย่างเดียวล้วน ไม่มีทางเขียนใดๆ ผ่านเส้นทางนี้
   */
  router.get("/contracts", verifyToken, async (req, res) => {
    try {
      const query = withDepartmentScope(
        { contractGroupId: { $exists: true, $nin: [null, ""] } },
        req
      );
      const rows = await CalendarEvent.find(query)
        .select("contractGroupId company site system title contractNo quotationNo contractStart contractEnd visitCount intervalMonths jobValue responsiblePerson responsiblePersonId team resPerson userId time")
        .lean();

      // จัดกลุ่มตาม contractGroupId — เทียบตรรกะเดียวกับ contractMap ใน AddEvent.js/ContractOverview.js
      const map = new Map();
      for (const e of rows) {
        const key = String(e.contractGroupId);
        if (!map.has(key)) {
          map.set(key, {
            key,
            company: e.company || "",
            site: e.site || "",
            system: e.system || "",
            title: e.title || "",
            contractNo: e.contractNo || "",
            quotationNo: e.quotationNo || "",
            contractStart: e.contractStart || "",
            contractEnd: e.contractEnd || "",
            visitCount: e.visitCount || 0,
            intervalMonths: e.intervalMonths,
            jobValue: e.jobValue,
            responsiblePerson: e.responsiblePerson || e.team || "",
            responsiblePersonId: e.responsiblePersonId || e.resPerson || "",
            usedRounds: new Set(),
          });
        }
        const c = map.get(key);
        // ⚠️ นับ "ครั้งที่ไม่ซ้ำกัน" ไม่ใช่จำนวน document — งานครั้งเดียวที่เข้าหลายวันมีหลาย document
        // นับตรงๆ จะเกินจริงแล้วสัญญาจะดูเหมือนเต็มทั้งที่ยังว่าง (ตรงกับ countUsedRounds ฝั่งหน้าจอ)
        if (e.time !== undefined && e.time !== null && e.time !== "") c.usedRounds.add(String(e.time));
      }

      const contracts = [...map.values()]
        .map((c) => {
          const used = [...c.usedRounds];
          const usedVisits = used.length;
          // ครั้งถัดไปที่ยังว่าง — เลขแรกใน 1..visitCount ที่ยังไม่ถูกใช้
          let nextRound = null;
          for (let i = 1; i <= (c.visitCount || 0); i += 1) {
            if (!c.usedRounds.has(String(i))) { nextRound = i; break; }
          }
          const { usedRounds, ...rest } = c;
          return { ...rest, usedVisits, usedRounds: used, nextRound };
        })
        // เอาเฉพาะสัญญาที่ยังเพิ่มครั้งได้จริง — ที่ครบแล้วโชว์ไปก็เลือกไม่ได้ (backend บล็อกอยู่แล้ว)
        .filter((c) => c.visitCount > 0 && c.usedVisits < c.visitCount)
        .sort(
          (a, b) =>
            (a.company || "").localeCompare(b.company || "", "th") ||
            (a.site || "").localeCompare(b.site || "", "th")
        );

      res.json({ contracts });
    } catch (err) {
      console.error("❌ ดึงรายชื่อสัญญาไม่สำเร็จ:", err);
      res.status(500).json({ message: "ดึงรายชื่อสัญญาไม่สำเร็จ" });
    }
  });
};
