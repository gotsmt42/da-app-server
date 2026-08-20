/**
 * แผนงานล่วงหน้า (unscheduled) และการแปลงไป-กลับกับงานจริงบนปฏิทิน
 *
 * แยกออกมาจาก routes/calendarEvent.js เดิมที่ยาว 2,708 บรรทัดในไฟล์เดียว (29 route)
 * ⚠️ ลำดับการประกาศ route ภายในไฟล์นี้ = ลำดับเดิม ห้ามสลับ (ดูเหตุผลที่ index.js)
 */
const {
  moment,
  CalendarEvent,
  verifyToken,
  crypto,
  sendPushToRoles,
  findMutualOverlaps,
  findDuplicateContractRound,
  findDuplicateContractNo,
  effectiveResponsibleOrClauses,
  strictResponsibleOrClauses,
} = require("./shared");

module.exports = (router) => {
  // ✅ งาน "วางแผนล่วงหน้า" (unscheduled) — บันทึกไว้ก่อนว่ามีงานนี้แน่ๆ ในเดือนไหน แต่ยังไม่รู้วันที่
  // เจาะจง จัดกลุ่มแสดงตาม plannedMonth แล้วค่อยลาก/กดลงตารางจริงทีหลัง (ดู PUT /:id/schedule)
  // ต้องอยู่ก่อน "/:id" ไม่งั้น Express จะจับ "draft"/"drafts" เป็นค่า :id แทน
  router.post("/draft", verifyToken, async (req, res) => {
    try {
      const {
        company, site, title, system, time, team, resPerson, plannedMonth,
        backgroundColor, textColor, fontSize, description,
        // ✅ สัญญาแบบยังไม่มีวันที่เข้างานเลย ("ฉบับร่าง") — เก็บเป็น draft เดียวที่มีข้อมูลสัญญาครบ
        // แต่ยังไม่มี date/start/end/time จนกว่าจะกด "+ เพิ่มครั้งถัดไป" แปลงเป็นครั้งที่ 1 จริง
        // (ดู PUT /:id/schedule) — ไม่ต้องสร้าง event ที่มีวันที่ปลอมๆ ขึ้นมาแค่เพื่อให้มี record
        // ✅ contractGroupId: รับจาก client ได้ด้วย (ใช้ตอนวางแผนล่วงหน้าครั้งถัดไปของ "สัญญาที่มีอยู่แล้ว"
        // จากหน้าแผนงานล่วงหน้า) ถ้าไม่ส่งมาค่อยสุ่มใหม่ (กรณีสร้างสัญญาใหม่ทั้งชุดจากหน้าภาพรวมสัญญา)
        isContractBatch, contractGroupId, contractNo, quotationNo, contractStart, contractEnd, visitCount, intervalMonths, jobValue,
        // ✅ เลือกหมวดหมู่ "งานทั่วไป"/"งานโปรเจค" ได้ตั้งแต่ตอนสร้างแผนงานเลย (ขั้นตอนที่ 1 ในฟอร์ม
        // AddDraftEvent.js) แทนที่จะต้องไปกดจัดหมวดหมู่ย้อนหลังทีหลังในหน้า "ภาพรวมงาน" เสมอ — ไม่เกี่ยวกับ
        // งานตามสัญญา (isContractBatch) ซึ่งไม่มีแนวคิดหมวดหมู่นี้อยู่แล้ว (เป็นสัญญาจริงเสมอ)
        jobClassification,
        // ✅ ผู้รับผิดชอบงาน — มาได้ 2 ทาง: (1) แผนงานทั่วไป/โปรเจค คนที่เพิ่มเองเป็นผู้รับผิดชอบทันที
        // (ดู payload ฝั่ง AddDraftEvent.js) (2) สัญญาที่สร้างจากฟอร์ม "เพิ่มสัญญาใหม่" ในหน้า "ภาพรวมงาน"
        // ซึ่ง admin/manager เลือกผู้รับผิดชอบไว้ตั้งแต่ตอนสร้าง — ต้องเก็บค่าตรงๆ ที่ส่งมาเท่านั้น ห้าม
        // fallback ไปที่ team เอง เพราะสิทธิ์ที่ผูกกับ "ผู้รับผิดชอบตัวจริง" (แก้ไขทีมรายครั้ง ฯลฯ) เช็คแบบ
        // เข้มงวดว่าต้องมอบหมายไว้ชัดเจนเท่านั้น (ดู rawResponsiblePersonId ฝั่ง frontend)
        responsiblePerson, responsiblePersonId,
      } = req.body;

      if (!site || !title || !system) {
        return res.status(400).json({ message: "กรุณาระบุชื่อโครงการ/ประเภทงาน/ระบบงาน" });
      }

      // ✅ ระยะห่างระหว่างรอบ (intervalMonths) เป็นข้อมูลอ้างอิงสำหรับเตือน "เกินกำหนด" เท่านั้น — ไม่ใช่
      // ฟิลด์บังคับ ไม่ต้องมีช่วงสัญญาครบก็สร้างสัญญาได้เหมือนเดิม (งานจริงเลื่อน/ชนกันได้เสมอ ให้ผู้ใช้
      // กำหนดวันที่/จำนวนครั้งเองทั้งหมด) เช็คแค่ความถูกต้องของค่านี้เองถ้ามีการระบุมา
      if (intervalMonths !== undefined && intervalMonths !== "" && intervalMonths !== null) {
        const n = Number(intervalMonths);
        if (!n || n < 1 || n > 24) {
          return res.status(400).json({ message: "ระยะห่างระหว่างรอบต้องอยู่ระหว่าง 1-24 เดือน" });
        }
      }

      // ✅ ห้ามใส่จำนวนครั้งทั้งหมดเกิน 12 — เทียบ pattern เดียวกับ intervalMonths ด้านบน (เช็คซ้ำฝั่ง
      // backend เสมอ ไม่พึ่งฝั่งจอเช็คอย่างเดียว) กันตาราง "ภาพรวมงาน" เรนเดอร์คอลัมน์ "ครั้งที่ N"
      // เกินจำเป็นจนหน้าพัง (ดู maxVisitCount ใน ContractOverview.js)
      if (visitCount !== undefined && visitCount !== "" && visitCount !== null) {
        const n = Number(visitCount);
        if (!n || n < 1 || n > 12) {
          return res.status(400).json({ message: "จำนวนครั้งทั้งหมดต้องอยู่ระหว่าง 1-12 ครั้ง" });
        }
      }

      // ✅ แผนงานที่สร้างโดยคนที่ไม่ใช่แอดมิน/manager (ช่าง/เซล) ต้องรอการอนุมัติก่อน เทียบ pattern
      // เดียวกับ POST / (สร้างงานแบบมีวันที่ทันที) เป๊ะๆ — ดูเหตุผลที่คอมเมนต์ตรงนั้น
      const isAdminOrManager = ["admin", "manager"].includes(req.user.role);
      const creatorName = [req.user?.fname, req.user?.lname].filter(Boolean).join(" ") || req.user?.username || "ผู้ดูแลระบบ";

      // ⚠️ BUG ที่แก้: เดิมสัญญาฉบับร่างที่ไม่ได้ส่ง plannedMonth มา (ฟอร์ม "เพิ่มสัญญาใหม่" ในหน้า
      // "ภาพรวมงาน" ไม่มีช่องนี้เลย) จะถูก "เดา" เดือนให้เองเสมอ — จากวันที่เริ่มสัญญา ไม่งั้นใช้เดือน
      // ปัจจุบัน — ทำให้สัญญาที่ผู้ใช้ตั้งใจสร้างเป็น "สัญญาเปล่า ยังไม่มีวันที่" กลายเป็นมีเดือนติดมาเอง
      // แล้วไปโผล่ในแผง/วิดเจ็ต "งานวางแผนล่วงหน้า" เหมือนถูกวางแผนไว้เดือนนั้นจริงๆ ทั้งที่ยังไม่เคยมีใคร
      // ระบุ — ตอนนี้เก็บเฉพาะค่าที่ผู้ใช้ระบุมาจริงเท่านั้น ไม่ระบุมาก็ปล่อยว่างไว้ (สัญญาเปล่าจริงๆ)
      // ค่อยไปลงวันที่ครั้งที่ 1 ทีหลังผ่านปุ่มในตาราง "ภาพรวมงาน" (ดู handleAddVisitSubmit ซึ่งแปลง
      // ฉบับร่างนี้เป็นครั้งที่ 1 จริงผ่าน PUT /:id/schedule)
      // ⚠️ ยังบังคับสำหรับแผนงานทั่วไป/โปรเจคเหมือนเดิม — ฟอร์ม AddDraftEvent.js มีช่องให้เลือกเดือนอยู่แล้ว
      // และแผงงานล่วงหน้าในปฏิทินจัดกลุ่มการ์ดตามเดือนนี้ ถ้าว่างจะไม่มีที่อยู่ให้แสดง (ต่างจากสัญญาซึ่ง
      // ไม่โผล่ในแผงนั้นอยู่แล้ว — ดู visibleDrafts ใน EventCalendar/index.js)
      const resolvedPlannedMonth = plannedMonth || undefined;
      if (!isContractBatch && !resolvedPlannedMonth) {
        return res.status(400).json({ message: "กรุณาระบุเดือนที่ตั้งใจจะทำงานนี้" });
      }

      // ✅ เช็คซ้ำ — กันเพิ่มแผนงานล่วงหน้าไปทับ "ครั้งที่" ที่มีอยู่แล้วในสัญญาเดียวกัน (ทั้งที่ลงตารางแล้วและที่เป็นแผนงานอื่นค้างอยู่)
      if (isContractBatch && contractGroupId && time) {
        const dupRound = await findDuplicateContractRound(contractGroupId, time);
        if (dupRound) {
          return res.status(409).json({ message: `ครั้งที่ ${time} ของสัญญานี้ถูกใช้ไปแล้ว กรุณาตรวจสอบ` });
        }
      }

      // ✅ ห้ามเลขที่สัญญาซ้ำกับสัญญาอื่น — excludeContractGroupId ส่ง contractGroupId ที่ client ให้มา
      // ด้วย (ถ้ามี) เผื่อเป็นการเพิ่มแผนงานล่วงหน้าครั้งถัดไปของสัญญาเดิม ซึ่งเลขที่สัญญาจะซ้ำกับตัวเองเสมอ
      if (isContractBatch && contractNo) {
        const dupContractNo = await findDuplicateContractNo(contractNo, contractGroupId);
        if (dupContractNo) {
          return res.status(409).json({ message: `เลขที่สัญญา "${contractNo}" ถูกใช้ไปแล้ว กรุณาตรวจสอบ` });
        }
      }

      const draft = await new CalendarEvent({
        company,
        site,
        title,
        system,
        time,
        team,
        description,
        resPerson: resPerson || undefined,
        responsiblePerson: responsiblePerson || undefined,
        responsiblePersonId: responsiblePersonId || undefined,
        unscheduled: true,
        plannedMonth: resolvedPlannedMonth,
        // ✅ ให้ค่าเริ่มต้นเสมอ (schema บังคับ required) แทนสีที่ผู้ใช้เลือกจริงตอนลงตาราง — ใช้สีม่วงคราม
        // #6366f1 สื่อว่า "งานใหม่" (เดิมใช้สีแดงธีมแอป แต่สีแดงตอนนี้ถูกใช้สื่อ "ไม่อนุมัติ"/วันหยุด
        // ราชการไปแล้วในปฏิทิน ทำให้แผนงานใหม่ปนกับสองอย่างนั้นจนแยกไม่ออก — เทียบสีเดียวกับ
        // EventCalendar/index.js defaultBackgroundColor และไอคอนแจ้งเตือน "งานใหม่" ใน NotificationBell.js)
        backgroundColor: backgroundColor || "#6366f1",
        textColor: textColor || "#ffffff",
        fontSize: fontSize || 8,
        userId: req.userId,
        // 🐛 BUG ที่แก้ (กรอกมูลค่างานตอนสร้างสัญญาแล้วไม่ขึ้นในตาราง): jobValue ถูก destructure จาก
        // req.body ไว้แล้ว (ดูด้านบน) แต่ตกหล่นไม่ได้ถูกเขียนลง document เลยสักครั้ง — ค่าที่ผู้ใช้กรอก
        // จึงหายไปเงียบๆ ทุกครั้งที่สร้าง "สัญญาเปล่า" (ไม่ระบุวันที่ครั้งที่ 1 ซึ่งเป็นเส้นทางปกติ)
        // ⚠️ เส้นทางที่ระบุวันที่มาด้วยไม่เจอปัญหานี้ เพราะไปทาง POST / ซึ่งมี jobValue ใน allowedFields
        // อยู่แล้ว — ผู้ใช้เลยเจออาการ "บางทีก็ขึ้น บางทีก็ไม่ขึ้น" แล้วแต่ว่ากรอกวันที่มาหรือเปล่า
        ...(isContractBatch ? {
          contractGroupId: contractGroupId || crypto.randomUUID(),
          contractNo, quotationNo, contractStart, contractEnd, intervalMonths, visitCount, jobValue,
        } : (jobClassification ? { jobClassification } : {})),
        // ✅ ห้ามรับ approvalStatus จาก client ตรงๆ (ไม่อยู่ใน destructure ด้านบนเลย) คำนวณเองจาก role
        // ของผู้เรียกเท่านั้น — เทียบ pattern เดียวกับ POST / (buildEventData) เป๊ะๆ
        ...(isAdminOrManager
          ? { approvalStatus: "approved" }
          : {
              approvalStatus: "pending",
              approvalRequestedAt: new Date(),
              approvalRequestedBy: creatorName,
              approvalRequestedByUserId: req.userId,
            }),
      }).save();

      // ✅ เดิม route นี้ไม่แจ้งเตือนเลย — แจ้งแอดมิน/manager เฉพาะตอนรออนุมัติ (เทียบ pattern เดียวกับ
      // POST / เป๊ะๆ) ใช้ deep-link ?draft=<id>&month=<เดือน> ที่ EventCalendar/index.js เปิดฟังอยู่แล้ว
      // (ใช้เปิดแผงงานล่วงหน้าไปที่แผนงานนี้โดยตรง ไม่ต้องเพิ่ม routing ฝั่ง frontend เลย)
      // ⚠️ ยกเว้นฉบับร่างของ "สัญญา" — ไม่โผล่ในแผงงานล่วงหน้าของปฏิทินเลย (ดู visibleDrafts ใน
      // EventCalendar/index.js) deep-link นั้นจึงพาไปหน้าที่ไม่มีการ์ดนี้อยู่ ต้องส่งไปหน้า "ภาพรวมงาน"
      // ซึ่งเป็นที่เดียวที่จัดการสัญญาฉบับร่างได้จริงแทน — และเดือนอาจว่างได้แล้ว (สัญญาเปล่า) จึงไม่ต่อ
      // ท้ายข้อความ/URL ถ้าไม่มีค่า กัน "เดือน undefined" โผล่ในแจ้งเตือน
      if (draft.approvalStatus === "pending") {
        const monthSuffix = resolvedPlannedMonth ? ` · เดือน ${resolvedPlannedMonth}` : "";
        sendPushToRoles(["admin", "manager"], {
          title: `⏳ ${creatorName} ส่งแผนงานล่วงหน้ารออนุมัติ`,
          body: `${draft.title || "งาน"} · ${draft.company || "-"}${draft.site ? " - " + draft.site : ""}${monthSuffix}`,
          // ✅ แผนงานล่วงหน้าที่รออนุมัติก็อยู่ในแท็บ "รออนุมัติ" เดียวกัน (PendingApprovalsPanel รวมทั้ง
          // งานที่ลงตารางแล้วและฉบับร่างไว้ที่เดียว) — พาไปที่นั่นให้ตรงกับแจ้งเตือนงานใหม่รออนุมัติ
          // ⚠️ ยกเว้นฉบับร่างของ "สัญญา" ที่จัดการได้จริงเฉพาะหน้า "ภาพรวมงาน" เท่านั้น ยังคงส่งไปที่นั่น
          url: draft.contractGroupId ? "/contracts" : "/operation?tab=approvals",
          tag: `approval-draft-${draft._id}`,
          renotify: true,
        }).catch((err) => console.error("❌ Push notify error (approval-request-draft):", err));
      }

      res.status(201).json({ event: draft });
    } catch (error) {
      console.error("❌ Error creating draft event:", error);
      res.status(500).send("Internal Server Error");
    }
  });

  router.get("/drafts", verifyToken, async (req, res) => {
    try {
      const userId = req.userId;
      const userRole = req.user.role;
      const isAdminOrManager = ["admin", "manager"].includes(userRole);

      // ✅ ป้อนแผงงานล่วงหน้าให้ทั้งหน้า "การดำเนินงาน"/"ภาพรวมงาน" — เทียบ pattern เดียวกับ GET /event-op
      // เป๊ะๆ (ดูคอมเมนต์ละเอียดที่นั่น) สิทธิ์เป็นของ "ผู้รับผิดชอบ" ไม่ใช่ "ทีมที่เข้างาน" อีกต่อไป
      // ✅ ?scope=responsible — โหมดเข้มงวดเหมือน GET /event-op (ดูคำอธิบายที่นั่น) หน้า "ภาพรวมงาน"
      // รวมแผนงานล่วงหน้าเข้าไปในตารางเดียวกัน ถ้ากรองคนละกติกากับงานที่ลงตารางแล้ว จะกลายเป็นตาราง
      // เดียวที่มี 2 มาตรฐานปนกัน (สัญญาที่ยังไม่ลงวันที่โผล่ ทั้งที่สัญญาที่ลงวันที่แล้วของงานเดียวกันไม่โผล่)
      const strictScope = req.query.scope === "responsible";
      const query = isAdminOrManager
        ? { unscheduled: true }
        : strictScope
          ? { unscheduled: true, $or: strictResponsibleOrClauses(userId, req.user.fname) }
          : { unscheduled: true, $or: [
              { userId: userId },                                       // ผู้ลงงาน
              ...effectiveResponsibleOrClauses(userId, req.user.fname), // ผู้รับผิดชอบ
              // ✅ หัวหน้าทีม + ลูกทีม เห็นแผนงานล่วงหน้าที่ตัวเองมีชื่ออยู่ด้วย — ต้องตรงกับ GET /event-op
              // (ดูเหตุผลที่ jobParticipantViewClauses ที่นั่น) ไม่งั้นหน้าการดำเนินงานจะเห็นงานที่ลงตาราง
              // แล้วแต่ไม่เห็นแผนงานล่วงหน้าของงานเดียวกัน
              { team: req.user.fname },
              { resPerson: userId },
              { "teamMembers.userId": userId },
              { "teamMembers.name": req.user.fname },
            ] };

      const drafts = await CalendarEvent.find(query).sort({ createdAt: -1 }).lean();
      res.json({ drafts });
    } catch (error) {
      console.error("❌ Error fetching draft events:", error);
      res.status(500).send("Internal Server Error");
    }
  });

  // ✅ แปลง draft ให้เป็นงานที่ลงตารางจริง (กำหนดวันที่ + ปลด unscheduled ออก) — ใช้ทั้งตอนลาก
  // การ์ดวางลงปฏิทิน (eventReceive), ตอนกดปุ่ม "ลงตาราง" เลือกวันที่เอง, และตอนแก้ไขงานล่วงหน้า
  // แล้วเลือกใส่วันที่ start/end เอง (เหมือนฟอร์มเพิ่มงานปกติ)
  // ✅ รองรับ dates[] (งานเข้าหลายวันไม่ติดกัน) แบบเดียวกับ POST / — ช่วงแรกอัปเดตลงตัว draft เดิม
  // ช่วงที่เหลือ clone เป็น record ใหม่ผูกด้วย jobGroupId เดียวกัน
  // ✅ ไม่บล็อกการ "ลงตาราง" งานที่ยังรออนุมัติ/ถูกปฏิเสธ (approvalStatus ไม่ใช่ "approved") ตามที่ผู้ใช้
  // ขอไว้ — ปล่อยให้ลงตารางได้ตามปกติ ค่า approvalStatus/approvalRequestedBy/ฯลฯ ของ existingEvent จะ
  // ยังคงอยู่ในเอกสารเดิมโดยอัตโนมัติต่อไป (route นี้ mutate เฉพาะ field ที่แก้ไว้ด้านล่างเท่านั้น ไม่ใช่
  // full replace) งานจึงยังคงขึ้นเป็น "รออนุมัติ"/"ถูกปฏิเสธ" ต่อไปแม้จะมีวันที่จริงแล้วก็ตาม จนกว่าแอดมิน/
  // manager จะกดอนุมัติที่ PUT /:id/approval
  router.put("/:id/schedule", verifyToken, async (req, res) => {
    try {
      const { id } = req.params;
      const { start, end, date, startTime, endTime, dates, team, resPerson, teamMembers, time } = req.body;

      const existingEvent = await CalendarEvent.findById(id);
      if (!existingEvent) return res.status(404).json({ message: "ไม่พบงานนี้" });
      if (!existingEvent.unscheduled) {
        return res.status(400).json({ message: "งานนี้ถูกลงตารางไปแล้ว" });
      }

      const isAdminOrManager = ["admin", "manager"].includes(req.user.role);
      const isOwner = existingEvent.userId.toString() === req.userId.toString();
      if (!isAdminOrManager && !isOwner) {
        return res.status(403).json({ message: "คุณไม่มีสิทธิ์แก้ไขงานนี้" });
      }

      const isMultiDate = Array.isArray(dates) && dates.length > 0;
      if (!isMultiDate && !date) {
        return res.status(400).json({ message: "กรุณาระบุวันที่" });
      }

      // ⚠️ ตัดการเช็คช่างชนกัน (double-booking กับงานอื่นในระบบ) ออกตามที่ผู้ใช้ขอ — 1 ทีมรับหลายงานใน
      // วันเดียวกันได้ตามปกติ ไม่ควรบล็อก ยังคงเหลือแค่เช็ค "ชนกันเอง" ภายในชุดวันที่หลายวันไม่ติดกันของ
      // งานเดียวกันไว้ (เป็นการกรอกข้อมูลผิดพลาดจริง ไม่ใช่ double-booking)
      const rangesToCheck = isMultiDate ? dates.filter((d) => d && d.start && d.end) : [{ start: start || date, end: end || date }];
      if (isMultiDate && rangesToCheck.length > 0) {
        const mutualConflicts = findMutualOverlaps(rangesToCheck);
        if (mutualConflicts.length > 0) {
          const [a, b] = mutualConflicts[0];
          return res.status(409).json({
            message: `วันที่ที่กรอกทับกันเอง (${moment(a.start).locale("th").format("D MMM YYYY")} กับ ${moment(b.start).locale("th").format("D MMM YYYY")}) กรุณาตรวจสอบวันที่แต่ละครั้งอีกครั้ง`,
          });
        }
      }

      if (isMultiDate) {
        const [first, ...rest] = dates;
        const jobGroupId = dates.length > 1 ? (existingEvent.jobGroupId || crypto.randomUUID()) : existingEvent.jobGroupId;

        existingEvent.unscheduled = false;
        existingEvent.plannedMonth = undefined;
        if (jobGroupId) existingEvent.jobGroupId = jobGroupId;
        existingEvent.date = first.date || first.start;
        existingEvent.start = first.start;
        existingEvent.end = first.end;
        if (startTime !== undefined) existingEvent.startTime = startTime;
        if (endTime !== undefined) existingEvent.endTime = endTime;
        // ✅ เดิมฟอร์ม "ลงตาราง" ไม่มีช่องทีมเลย — งานที่ยังไม่เคยมอบหมายทีมตอนสร้าง draft
        // จะไม่มีทางกำหนดได้จนกว่าจะไปแก้ไขแยกอีกที ตอนนี้เลือก/แก้ทีมได้พร้อมกันตอนลงตารางเลย
        if (team !== undefined) existingEvent.team = team;
        if (resPerson !== undefined) existingEvent.resPerson = resPerson;
        if (teamMembers !== undefined) existingEvent.teamMembers = teamMembers;
        await existingEvent.save();

        if (rest.length > 0) {
          const base = existingEvent.toObject();
          delete base._id;
          delete base.createdAt;
          delete base.updatedAt;
          delete base.__v;
          await Promise.all(
            rest.map((d) =>
              new CalendarEvent({
                ...base,
                date: d.date || d.start,
                start: d.start,
                end: d.end,
              }).save()
            )
          );
        }

        return res.json({ event: existingEvent });
      }

      existingEvent.unscheduled = false;
      existingEvent.plannedMonth = undefined;
      existingEvent.date = date;
      existingEvent.start = start || date;
      existingEvent.end = end || date;
      if (startTime !== undefined) existingEvent.startTime = startTime;
      if (endTime !== undefined) existingEvent.endTime = endTime;
      if (team !== undefined) existingEvent.team = team;
      if (resPerson !== undefined) existingEvent.resPerson = resPerson;
      if (teamMembers !== undefined) existingEvent.teamMembers = teamMembers;
      // ✅ ใช้ตอนแปลงสัญญาฉบับร่าง (ยังไม่มีครั้งไหนลงตารางเลย) ให้กลายเป็น "ครั้งที่ 1" จริง —
      // เดิม route นี้ไม่รับ time เลย เพราะฟอร์ม "ลงตาราง" ทั่วไปไม่เคยต้องกำหนดครั้งที่มาก่อน
      if (time !== undefined) {
        // ✅ เช็คซ้ำ — excludeId เป็นตัวมันเอง เพราะ draft ที่กำลังแปลงนี้อาจถือ "ครั้งที่" นี้อยู่แล้วตั้งแต่ตอนสร้าง
        const dupRound = await findDuplicateContractRound(existingEvent.contractGroupId, time, existingEvent._id);
        if (dupRound) {
          return res.status(409).json({ message: `ครั้งที่ ${time} ของสัญญานี้ถูกใช้ไปแล้ว กรุณาตรวจสอบ` });
        }
        existingEvent.time = time;
      }

      await existingEvent.save();
      res.json({ event: existingEvent });
    } catch (error) {
      console.error("❌ Error scheduling draft event:", error);
      res.status(500).send("Internal Server Error");
    }
  });

  // ✅ แก้ไขข้อมูลงานวางแผนล่วงหน้า (ยังไม่ลงตาราง) — ทำเฉพาะฟิลด์ของ draft เท่านั้น (ไม่มีวันที่)
  // แยกจาก PUT /:id (แก้ไขงานที่ลงตารางแล้ว) ที่มี logic แจ้งเตือน/เงื่อนไขซับซ้อนกว่ามาก
  router.put("/:id/draft", verifyToken, async (req, res) => {
    try {
      const { id } = req.params;
      const existingEvent = await CalendarEvent.findById(id);
      if (!existingEvent) return res.status(404).json({ message: "ไม่พบงานนี้" });
      if (!existingEvent.unscheduled) {
        return res.status(400).json({ message: "งานนี้ถูกลงตารางไปแล้ว ให้แก้ไขผ่านหน้าปฏิทินปกติ" });
      }

      const isAdminOrManager = ["admin", "manager"].includes(req.user.role);
      const isOwner = existingEvent.userId.toString() === req.userId.toString();
      if (!isAdminOrManager && !isOwner) {
        return res.status(403).json({ message: "คุณไม่มีสิทธิ์แก้ไขงานนี้" });
      }

      const { company, site, title, system, time, team, resPerson, plannedMonth, description } = req.body;
      if (!site || !title || !system) {
        return res.status(400).json({ message: "กรุณาระบุชื่อโครงการ/ประเภทงาน/ระบบงาน" });
      }
      if (!plannedMonth) {
        return res.status(400).json({ message: "กรุณาระบุเดือนที่ตั้งใจจะทำงานนี้" });
      }

      existingEvent.company = company;
      existingEvent.site = site;
      existingEvent.title = title;
      existingEvent.system = system;
      existingEvent.time = time;
      existingEvent.team = team;
      existingEvent.resPerson = resPerson || undefined;
      existingEvent.plannedMonth = plannedMonth;
      existingEvent.description = description;

      // ✅ แก้ไขแผนงานที่ถูกปฏิเสธไปแล้วถือเป็นการส่งขออนุมัติใหม่อัตโนมัติ — route นี้เขียนฟิลด์เนื้อหา
      // งานทุกช่องอยู่แล้วทุกครั้งที่เรียก (ไม่มีการแก้ไขบางส่วน) จึงถือว่าทุกครั้งที่เจ้าของ/ผู้ถูกมอบหมาย
      // (ไม่ใช่แอดมิน/manager) บันทึกสำเร็จคือ "แก้ไขแล้วส่งใหม่" เทียบ pattern เดียวกับ PUT /:id
      let resubmitted = false;
      if (existingEvent.approvalStatus === "rejected" && !isAdminOrManager) {
        existingEvent.approvalStatus = "pending";
        existingEvent.approvalRequestedAt = new Date();
        existingEvent.approvalRequestedBy = [req.user?.fname, req.user?.lname].filter(Boolean).join(" ") || req.user?.username || "ผู้ดูแลระบบ";
        existingEvent.approvalRequestedByUserId = req.userId;
        existingEvent.approvalDecidedAt = null;
        existingEvent.approvalDecidedBy = "";
        resubmitted = true;
      }

      await existingEvent.save();

      if (resubmitted) {
        sendPushToRoles(["admin", "manager"], {
          title: `🔄 ${existingEvent.approvalRequestedBy} แก้ไขแผนงานที่ถูกตีกลับ ส่งขออนุมัติใหม่`,
          body: `${existingEvent.title || "งาน"} · ${existingEvent.company || "-"}${existingEvent.site ? " - " + existingEvent.site : ""}`,
          // ⚠️ เหมือน POST /draft: ฉบับร่างของ "สัญญา" ไม่โผล่ในแผงงานล่วงหน้าของปฏิทินแล้ว (ดู
          // visibleDrafts) ลิงก์ ?draft= จะพาไปหน้าที่ไม่มีการ์ดนี้อยู่ ต้องส่งไปหน้า "ภาพรวมงาน" แทน —
          // และ plannedMonth ว่างได้แล้ว (สัญญาเปล่า) จึงต้องไม่ต่อท้าย URL เป็น "month=undefined"
          url: existingEvent.contractGroupId
            ? "/contracts"
            : `/event?draft=${existingEvent._id}${existingEvent.plannedMonth ? `&month=${existingEvent.plannedMonth}` : ""}`,
          tag: `approval-resubmit-draft-${existingEvent._id}`,
          renotify: true,
        }).catch((err) => console.error("❌ Push notify error (approval-resubmit-draft):", err));
      }

      res.json({ event: existingEvent });
    } catch (error) {
      console.error("❌ Error updating draft event:", error);
      res.status(500).send("Internal Server Error");
    }
  });

  // ✅ ย้ายงานที่ลงตารางไปแล้วกลับไปเป็น "วางแผนล่วงหน้า" (unscheduled) — ใช้ตอนอยากเอาวันที่ออก
  // กลับไปอยู่ในแผงงานล่วงหน้าเหมือนเดิม โดยไม่ต้องลบทิ้งทั้งงาน (ปุ่ม "ย้ายไปแผนล่วงหน้า" ใน
  // EditEvent.js และตอนลากงานจากปฏิทินไปวางบนแผงงานล่วงหน้า)
  router.put("/:id/unschedule", verifyToken, async (req, res) => {
    try {
      const { id } = req.params;
      const existingEvent = await CalendarEvent.findById(id);
      if (!existingEvent) return res.status(404).json({ message: "ไม่พบงานนี้" });
      if (existingEvent.unscheduled) {
        return res.status(400).json({ message: "งานนี้เป็นงานวางแผนล่วงหน้าอยู่แล้ว" });
      }

      const isAdminOrManager = ["admin", "manager"].includes(req.user.role);
      const isOwner = existingEvent.userId.toString() === req.userId.toString();
      if (!isAdminOrManager && !isOwner) {
        return res.status(403).json({ message: "คุณไม่มีสิทธิ์แก้ไขงานนี้" });
      }
      // ❌ งานที่ยังรออนุมัติ ช่างทำอะไรไม่ได้เลย (เทียบ pattern เดียวกับ PUT /:id) — เปิดดูได้อย่างเดียว
      if ((existingEvent.approvalStatus || "approved") === "pending" && !isAdminOrManager) {
        return res.status(403).json({ message: "งานนี้ยังไม่ได้รับการอนุมัติ ดูข้อมูลได้อย่างเดียว แก้ไขไม่ได้จนกว่าจะอนุมัติหรือไม่อนุมัติก่อน" });
      }
      // ❌ งานที่ปิดแล้ว (ดำเนินการเสร็จสิ้น) ห้ามย้ายกลับไปแผนล่วงหน้าเด็ดขาด ไม่มีข้อยกเว้นแม้แต่ admin/
      // manager — ต่างจากจุดล็อกอื่นๆ ในไฟล์นี้ (แก้ไข/อัปโหลดไฟล์/ลบไฟล์) ที่ยกเว้นให้ admin/manager
      // เพราะจุดเหล่านั้นแก้ไข "ข้อมูลของงานเดิม" เท่านั้น แต่ unschedule ไปเคลียร์ date/start/end ทิ้ง
      // (ดูด้านล่าง) โดยไม่แตะ status เลย ทำให้เกิดสถานะขัดแย้งกันเอง: "แผนงานล่วงหน้า" ที่ status ยังเป็น
      // "ดำเนินการเสร็จสิ้น" อยู่ ซึ่งไม่มีเหตุผลใดที่ควรเกิดขึ้นได้จริง จึงต้องปิดเด็ดขาด ไม่ใช่แค่จำกัดสิทธิ์
      // ✅ เพิ่ม "ยืนยันแล้ว"/"กำลังดำเนินการ" ตามที่ผู้ใช้ขอ — สองสถานะนี้แปลว่างานถูกนัดหมาย/เริ่มลงมือ
      // ไปแล้วจริง การดึงกลับไปเป็นแผนล่วงหน้าที่ไม่มีวันที่ ทำให้ประวัติงานขัดแย้งกันเองแบบเดียวกัน
      // ⚠️ ต้องเช็คที่ backend ด้วย ไม่ใช่แค่ซ่อนปุ่ม/กันการลากที่หน้าจอ — ทั้งสองทางนั้นเลี่ยงได้ด้วยการ
      // ยิง API ตรง จุดนี้คือด่านสุดท้ายที่เลี่ยงไม่ได้จริง
      const UNSCHEDULE_BLOCKED_STATUSES = ["ดำเนินการเสร็จสิ้น", "ยืนยันแล้ว", "กำลังดำเนินการ"];
      if (UNSCHEDULE_BLOCKED_STATUSES.includes(existingEvent.status)) {
        return res.status(403).json({
          message: `งานสถานะ "${existingEvent.status}" ไม่สามารถย้ายกลับไปแผนล่วงหน้าได้`,
        });
      }

      existingEvent.unscheduled = true;
      existingEvent.plannedMonth = req.body.plannedMonth || moment(existingEvent.start || existingEvent.date).format("YYYY-MM");
      existingEvent.date = undefined;
      existingEvent.start = undefined;
      existingEvent.end = undefined;

      await existingEvent.save();
      res.json({ event: existingEvent });
    } catch (error) {
      console.error("❌ Error unscheduling event:", error);
      res.status(500).send("Internal Server Error");
    }
  });
};
