/**
 * CRUD หลักของงาน — สร้าง อ่าน แก้ไข ลบ
 *
 * แยกออกมาจาก routes/calendarEvent.js เดิมที่ยาว 2,708 บรรทัดในไฟล์เดียว (29 route)
 * ⚠️ ลำดับการประกาศ route ภายในไฟล์นี้ = ลำดับเดิม ห้ามสลับ (ดูเหตุผลที่ index.js)
 */
const {
  CalendarEvent,
  User,
  verifyToken,
  can,
  isAdminOrManager: isSupervisorRole,
  SUPERVISOR_ROLES,
  crypto,
  sendPushToUsers,
  sendPushToRoles,
  sendPushToAllUsers,
  findMutualOverlaps,
  findDuplicateContractRound,
  departmentOf,
  DEPARTMENT,
  withDepartmentScope,
} = require("./shared");
const { thaiDate } = require("../../utils/thaiDate");

module.exports = (router) => {
  router.post("/", verifyToken, async (req, res) => {
    try {
      const allowedFields = [
        "docNo",
        "company",
        "site",
        "title",
        "system",
        "time",
        "team",
        "date",
        "backgroundColor",
        "textColor",
        "fontSize",
        "start",
        "end",
        "allDay",
        "status",
        "status_two",
        "status_three",
        "isAutoUpdated",
        // ⚠️ ต้องรับตอนสร้างด้วย ไม่ใช่เฉพาะตอนแก้ไข — ฟอร์มนัดหมายของฝ่ายขายส่ง manualStatus:true
        // มาเพื่อกันตัวไล่สถานะอัตโนมัติของงานช่างมาเปลี่ยนสถานะนัด (ดู useEffect ใน CalendarBoard)
        // 🐛 เดิมตกหล่นจากลิสต์นี้ ค่าที่ส่งมาจึงถูกทิ้งเงียบๆ แล้วกลับไปใช้ default ของ schema
        "manualStatus",
        "subject",
        "description",
        "startTime",
        "endTime",
        "documentSent",
        "documentFile",
        "resPerson",
        "teamMembers",
        "contractNo",
        "quotationNo",
        "contractStart",
        "contractEnd",
        "visitCount",
        "intervalMonths",
        "jobValue",
        // ✅ เลือกหมวดหมู่ "งานทั่วไป"/"งานโปรเจค" ได้ตั้งแต่ตอนสร้างงานเลย (ขั้นตอนที่ 1 ในฟอร์ม
        // AddEvent.js) แทนที่จะต้องไปกดจัดหมวดหมู่ย้อนหลังทีหลังในหน้า "ภาพรวมงาน" เสมอ
        "jobClassification",
        // ✅ งานทั่วไป/งานโปรเจคที่สร้างจาก AddEvent.js ตั้งผู้สร้างเป็นผู้รับผิดชอบให้อัตโนมัติทันที
        // (ดู payload ฝั่ง frontend) — งานตามสัญญายังคงปล่อยว่างไว้เหมือนเดิม (admin/manager มอบหมายเอง
        // ผ่านหน้า "ภาพรวมงาน" เท่านั้น ฟอร์มฝั่งสัญญาไม่ได้ส่งฟิลด์นี้มาด้วย)
        "responsiblePerson",
        "responsiblePersonId",
      ];

      // ✅ รองรับสร้างงานที่ต้องเข้าหลายวันแบบไม่ติดกันในครั้งเดียว: ส่ง dates เป็น array ของ
      // { start, end, date } มาแทน start/end/date เดี่ยว — ทุก record ที่สร้างจะผูกกันด้วย
      // jobGroupId เดียวกัน เพื่อให้หน้า Operation รู้ว่าเป็น "งานเดียวกัน" ไม่ใช่งานแยกกันคนละชิ้น
      //
      // ⚠️ ต้องผูก jobGroupId เฉพาะตอนสร้างมากกว่า 1 ช่วงจริงๆ หรือมี jobGroupId ส่งมาจาก client
      // อยู่แล้ว (เช่น เพิ่มวันที่เข้าไปในงานที่เป็นกลุ่มอยู่ก่อนแล้ว) — เดิมสุ่ม jobGroupId ให้
      // "ทุก" งานที่สร้างใหม่แม้จะเป็นงานเดี่ยวธรรมดา ทำให้หน้า Operation เข้าใจผิดว่างานเดี่ยว
      // เป็นส่วนหนึ่งของงานหลายวัน (ขึ้นสัญลักษณ์ 🔗 ทั้งที่จริงมีวันเดียว)
      //
      // ✅ isContractBatch แยกความหมายออกจาก jobGroupId ข้างบน — dates[] ชุดนี้คือ "หลายครั้ง"
      // ของสัญญาเดียวกัน (ครั้งที่ 1, 2, 3...) ไม่ใช่วันไม่ติดกันของครั้งเดียว จึงผูกด้วย contractGroupId
      // คนละตัวแทน ไม่แตะ jobGroupId เดิม (client เดิมที่ไม่ส่ง isContractBatch มา พฤติกรรมเหมือนเดิมทุกอย่าง)
      const { dates, isContractBatch, resPerson } = req.body;
      // ✅ ใช้ตัดสินว่างานนี้ต้องรอการอนุมัติหรือไม่ (ดู buildEventData ด้านล่าง) และเลือกว่าจะแจ้งเตือน
      // แบบไหน (ดูท้ายฟังก์ชัน) — เทียบ pattern เดียวกับทุก route ที่กันสิทธิ์ไว้เฉพาะแอดมิน/manager
      const isAdminOrManager = can(req.user, "approveJobs");
      // ✅ ใช้ทั้งใน approvalRequestedBy (ด้านล่าง) และหัวข้อแจ้งเตือน — ย้ายมาคำนวณตรงนี้แทนที่จะรอ
      // คำนวณทีหลังตอนจะแจ้งเตือนเหมือนเดิม เพราะ buildEventData ต้องใช้ค่านี้ตั้งแต่ตอนสร้าง record ด้วย
      const creatorName = [req.user?.fname, req.user?.lname].filter(Boolean).join(" ") || req.user?.username || "ผู้ดูแลระบบ";
      const isMultiDate = Array.isArray(dates) && dates.length > 1;
      const jobGroupId = (isMultiDate && !isContractBatch) ? (req.body.jobGroupId || crypto.randomUUID()) : req.body.jobGroupId;
      // ✅ สัญญาต้องได้ contractGroupId แม้มีแค่ครั้งเดียวตอนสร้าง (ยังไม่ได้ลงครั้งที่ 2 ทันที) —
      // ต่างจาก jobGroupId ด้านบนที่ต้องมากกว่า 1 ช่วงจริงๆ ถึงจะผูก เพราะสัญญาคือ 1 หน่วยข้อมูล
      // (เลขที่สัญญา/มูลค่างาน ฯลฯ) ตั้งแต่ครั้งแรกอยู่แล้ว ไม่ต้องรอให้มีครั้งที่ 2 ก่อนถึงจะนับเป็นสัญญา
      const hasContractDates = isContractBatch && Array.isArray(dates) && dates.length >= 1;
      const contractGroupId = hasContractDates ? (req.body.contractGroupId || crypto.randomUUID()) : req.body.contractGroupId;

      // 🐛 BUG ที่แก้ (เพิ่มวันเข้ากลุ่มเดิมแล้ววันนั้นหลุดหมวดหมู่): "หมวดหมู่งาน" (งานทั่วไป/งานโปรเจค)
      // เก็บอยู่ที่ทุก document แยกกัน แต่ความหมายจริงเป็นของ "ทั้งงาน" (ทั้ง jobGroupId) — เวลาเพิ่มวันที่
      // ใหม่เข้าไปในงานที่มีอยู่แล้ว client ไม่ได้ส่ง jobClassification มาด้วย (เช่น rangeData ใน
      // EditEvent.js ประกอบจาก buildSharedFields ซึ่งไม่มีฟิลด์นี้เลย) document ใหม่จึงเกิดมาเป็น ""
      // = "ยังไม่จัดกลุ่ม" ทั้งที่พี่น้องในกลุ่มเดียวกันเป็น "project" อยู่ ผลคือข้อมูลชุดเดียวกันขัดกันเอง
      // แล้วลามไปทุกหน้าที่อ่านค่านี้: หน้า "การดำเนินงาน" การ์ดบางใบไม่มีชิปหมวดหมู่ · ปฏิทินแถบสีขอบซ้าย
      // ไม่ตรงกันรายวัน · หน้า "ภาพรวมงาน" อ่านจาก document แรกของกลุ่ม ถ้าดันเป็นตัวที่ว่าง ทั้งแถวจะ
      // หลุดออกจากแท็บ "งานโปรเจค" ไปเลย
      // ✅ แก้ที่ backend จุดเดียวให้ครอบคลุมทุกเส้นทางที่สร้างงานเข้ากลุ่มเดิม (แก้ไขช่วงวันที่ใน
      // EditEvent, ต่อวันจากภาพรวมงาน, คัดลอก-วาง ฯลฯ) แทนไล่แก้ทีละ client แล้วตกหล่นอีกในอนาคต —
      // ถ้า client ส่งค่ามาเองก็เคารพค่านั้น (ไม่ทับ) ไม่งั้นสืบทอดจากกลุ่มเดิมให้อัตโนมัติ
      let inheritedJobClassification;
      if (!isContractBatch && jobGroupId && req.body.jobClassification === undefined) {
        const sibling = await CalendarEvent.findOne({
          jobGroupId,
          jobClassification: { $in: ["general", "project"] },
        }).select("jobClassification").lean();
        if (sibling) inheritedJobClassification = sibling.jobClassification;
      }

      // ⚠️ ตัดการเช็คช่างชนกัน (double-booking กับงานอื่นในระบบ) ออกตามที่ผู้ใช้ขอ — 1 ทีมรับหลายงานใน
      // วันเดียวกันได้ตามปกติ ไม่ควรบล็อก ยังคงเหลือแค่เช็ค "ชนกันเอง" ภายในชุดที่กำลังจะสร้างพร้อมกัน
      // (เช่น กรอกวันที่ครั้งที่ 1/3 ทับกันเอง) ไว้ เพราะเป็นการกรอกข้อมูลผิดพลาดจริง ไม่ใช่ double-booking
      const rangesToCheck = (Array.isArray(dates) && dates.length > 0 ? dates : [{ start: req.body.start, end: req.body.end }])
        .filter((d) => d && d.start && d.end);

      if (resPerson && rangesToCheck.length > 0) {
        const mutualConflicts = findMutualOverlaps(rangesToCheck);
        if (mutualConflicts.length > 0) {
          const [a, b] = mutualConflicts[0];
          return res.status(409).json({
            message: `วันที่ที่กรอกทับกันเอง (${thaiDate(a.start)} กับ ${thaiDate(b.start)}) กรุณาตรวจสอบวันที่แต่ละครั้งอีกครั้ง`,
          });
        }
      }

      // ✅ เช็คซ้ำ — กันเผลอเพิ่มครั้งที่ซ้ำกับที่มีอยู่แล้วในสัญญาเดียวกัน (ทั้งที่ลงตารางแล้วและที่เป็นแผนงานล่วงหน้า)
      // ✅ ยกเว้น "ตั้งใจต่อวันที่ไม่ต่อเนื่องให้ครั้งเดิม" — ส่ง jobGroupId มาตรงกับของ record เดิมที่ครองครั้งนี้
      // อยู่แล้ว (ดูหน้าภาพรวมสัญญา ปุ่ม "เพิ่มวันที่ต่อเนื่อง") กรณีนี้ไม่ถือว่าซ้ำ ปล่อยผ่านได้ — ต้องเช็คก่อน
      // เพื่อให้เช็คจำนวนครั้งสูงสุดด้านล่างรู้ด้วยว่าไม่ควรนับเป็นครั้งใหม่
      let isIntentionalExtend = false;
      if (req.body.contractGroupId && req.body.time) {
        const dupRound = await findDuplicateContractRound(req.body.contractGroupId, req.body.time);
        if (dupRound) {
          isIntentionalExtend = Boolean(req.body.jobGroupId) && String(dupRound.jobGroupId || "") === String(req.body.jobGroupId);
          if (!isIntentionalExtend) {
            return res.status(409).json({
              message: `ครั้งที่ ${req.body.time} ของสัญญานี้ถูกใช้ไปแล้ว กรุณาตรวจสอบ`,
            });
          }
        }
      }

      // ✅ ห้ามเพิ่มครั้งเกินจำนวนที่สัญญากำหนดไว้ (visitCount) — เช็คเฉพาะตอน client ระบุ contractGroupId
      // ของสัญญาที่มีอยู่แล้วมาเอง (เช่นกดปุ่ม "เพิ่มครั้งถัดไป" ในหน้าภาพรวมสัญญา) ไม่กระทบตอนสร้าง
      // สัญญาใหม่ทั้งชุด (contractGroupId ยังไม่มีตอนนั้น เพิ่งถูกสุ่มด้านบน) และไม่กระทบตอนต่อวันที่ไม่
      // ต่อเนื่องให้ครั้งเดิม (isIntentionalExtend) เพราะไม่ได้กินโควตาครั้งใหม่เพิ่ม
      if (req.body.contractGroupId && Number(req.body.visitCount) > 0 && rangesToCheck.length > 0 && !isIntentionalExtend) {
        const visitCount = Number(req.body.visitCount);
        const existingCount = await CalendarEvent.countDocuments({ contractGroupId: req.body.contractGroupId });
        if (existingCount + rangesToCheck.length > visitCount) {
          return res.status(409).json({
            message: `สัญญานี้กำหนดไว้ ${visitCount} ครั้ง ตอนนี้มี ${existingCount} ครั้งแล้ว ไม่สามารถเพิ่มอีก ${rangesToCheck.length} ครั้งได้`,
          });
        }
      }

      const buildEventData = (dateOverride) => {
        const eventData = {};
        allowedFields.forEach((field) => {
          if (req.body[field] !== undefined) {
            eventData[field] = req.body[field];
          }
        });
        if (dateOverride) {
          eventData.start = dateOverride.start;
          eventData.end = dateOverride.end;
          eventData.date = dateOverride.date;
          if (dateOverride.time !== undefined) eventData.time = dateOverride.time;
        }
        if (jobGroupId) eventData.jobGroupId = jobGroupId;
        if (contractGroupId) eventData.contractGroupId = contractGroupId;
        // ✅ สืบทอดหมวดหมู่งานจากพี่น้องในกลุ่มเดิม (ดูเหตุผลเต็มที่ inheritedJobClassification ด้านบน)
        if (inheritedJobClassification) eventData.jobClassification = inheritedJobClassification;
        eventData.userId = req.userId || req.body.userId;
        // ✅ ประทับแผนกจาก role ของผู้สร้าง — ห้ามรับจาก client (ไม่อยู่ใน allowedFields)
        // ไม่งั้นแก้ request เองแล้วยัดแผนงานข้ามสายงานได้ ซึ่งทำลายการแยกทั้งหมดที่ทำมา
        // ⚠️ แอดมิน/ผู้จัดการไม่สังกัดแผนก — งานที่เขาสร้างถือเป็นงานบริการตามพฤติกรรมเดิมของระบบ
        // ✅ แอดมิน/ผู้จัดการไม่สังกัดแผนก จึงระบุแผนกปลายทางเองได้ — ใช้ตอนเปิดเมนู
        //    "ตารางงานเซล" (?dept=sales) แล้วลงนัดหมายให้ฝ่ายขาย
        // 🐛 ที่แก้: เดิม department มาจาก role ของผู้สร้างอย่างเดียว นัดที่แอดมินลงในปฏิทินเซล
        //    จึงถูกบันทึกเป็นงานฝ่ายบริการ แล้วไปโผล่ในปฏิทิน/การดำเนินงานของช่างแทน
        // ⚠️ role อื่นยัด department มาเองไม่ได้ — ถูกเขียนทับด้วยแผนกจริงของตัวเองเสมอ
        const requestedDept = String(req.body.department || "");
        eventData.department =
          isAdminOrManager && Object.values(DEPARTMENT).includes(requestedDept)
            ? requestedDept
            : departmentOf(req.user) || DEPARTMENT.SERVICE;
        // ✅ งานที่ช่างสร้างเองต้องรอการอนุมัติก่อนถึงจะถือว่ายืนยันแล้วจริง — ห้ามรับ approvalStatus
        // จาก client ตรงๆ (ไม่อยู่ใน allowedFields ด้านบนเลย) คำนวณเองจาก role ของผู้เรียกเท่านั้น
        //
        // ⚠️ ฝ่ายขาย "ไม่" ต้องรออนุมัติ — นัดของเซลเป็นตารางนัดของตัวเอง (เข้าพบลูกค้า/สำรวจ
        // หน้างาน) ไม่ได้กินคิวช่างและไม่ชนกับใคร ด่านอนุมัติจึงไม่ได้ป้องกันอะไรเลย มีแต่ทำให้นัด
        // ขึ้นเป็นแถบลาย "รออนุมัติ" ค้างในปฏิทินตัวเอง
        // ⚠️ งานที่เซลอยากให้ช่างไปทำไม่ได้ลงผ่านทางนี้ — ต้องผ่านฟอร์ม "แจ้งงานให้ช่าง" ซึ่งมี
        // ขั้นตอนตรวจสอบของตัวเองอยู่แล้ว (routes/dispatch.js) การอนุมัติยังอยู่ครบตรงที่ต้องมีจริง
        if (isAdminOrManager || departmentOf(req.user) === DEPARTMENT.SALES) {
          eventData.approvalStatus = "approved";
        } else {
          eventData.approvalStatus = "pending";
          eventData.approvalRequestedAt = new Date();
          eventData.approvalRequestedBy = creatorName;
          eventData.approvalRequestedByUserId = req.userId;
        }
        return eventData;
      };

      let events;
      if (Array.isArray(dates) && dates.length > 0) {
        events = await Promise.all(
          dates.map((d) => new CalendarEvent(buildEventData(d)).save())
        );
      } else {
        events = [await new CalendarEvent(buildEventData()).save()];
      }

      // ✅ แจ้งเตือนตอนเพิ่มงานใหม่ (ไม่ await เพื่อไม่ให้ response ช้าลง) — อ้างอิงจาก record แรก
      // เป็นตัวแทนของทั้งชุด (ข้อมูลบริษัท/ไซต์/ผู้รับผิดชอบเหมือนกันทุก record อยู่แล้ว)
      // - ถ้ามอบหมายไว้ (resPerson) ส่งข้อความเจาะจงถึงคนนั้นโดยตรง
      // - คนอื่นๆ ในระบบ (ยกเว้นคนสร้างเองและคนที่ได้รับมอบหมายซึ่งได้ข้อความเจาะจงไปแล้ว) ได้รับแจ้งว่ามีงานใหม่เข้าระบบ
      const primary = events[0];
      const daysSuffix = events.length > 1 ? ` (${events.length} วัน)` : "";
      // ✅ เดิมแจ้งแค่ชื่องาน/บริษัท/ไซต์ ไม่มีวันเวลาเลย ต้องเปิดแอพเข้าไปดูเองถึงจะรู้ว่างานนัดไว้เมื่อไหร่
      // — ใส่วันที่ + ช่วงเวลาไว้ในเนื้อหาแจ้งเตือนเลย ให้เห็นครบตั้งแต่หน้าจอแจ้งเตือนจริง
      const dateLabel = thaiDate(primary.start || primary.date);
      const timeLabel = (primary.startTime || primary.endTime)
        ? `${primary.startTime || "-"}-${primary.endTime || "-"}`
        : "ทั้งวัน";
      const jobLabelNew = `📅 ${dateLabel} 🕐 ${timeLabel} · ${primary.title || "งาน"} · ${primary.company || "-"}${primary.site ? " - " + primary.site : ""}${daysSuffix}`;
      // ✅ งานเดี่ยวไม่มี jobGroupId แล้ว (ดูคอมเมนต์ด้านบน) ใช้ _id ของตัวเองแทนกัน tag ชนกัน
      // ระหว่างงานเดี่ยวหลายๆ งาน (ซึ่งจะทำให้ browser แจ้งเตือนทับ/แทนที่กันเองผิดๆ)
      const notifyTag = `event-${jobGroupId || primary._id}`;

      // ⚠️ BUG ที่แก้ (เลี่ยง): เดิมแจ้ง "มอบหมายงานใหม่ให้คุณ" + broadcast "เพิ่มงานใหม่เข้าระบบ" ทันที
      // ไม่ว่างานนั้นจะยังรออนุมัติอยู่หรือไม่ — ประกาศงานที่ยังไม่ผ่านการอนุมัติให้ทั้งบริษัทเห็นก่อนใครยืนยัน
      // เป็นเรื่องเข้าใจผิดได้ง่าย (เช่น ช่างเห็นว่าตัวเอง "ถูกมอบหมาย" ทั้งที่งานนั้นอาจโดนตีกลับภายหลัง)
      // — ถ้ายังรออนุมัติ ให้แจ้งเฉพาะแอดมิน/manager ว่ามีงานรออนุมัติแทน ส่วนแจ้งเตือน "มอบหมายงาน" ให้
      // เลื่อนไปแจ้งตอนอนุมัติแล้วจริงๆ (ดู PUT /:id/approval) — งานที่ admin/manager สร้างเอง (ไม่ต้องรอ
      // อนุมัติ) ยังคงพฤติกรรมเดิมทุกประการ
      // ⚠️ นัดของฝ่ายขายไม่แจ้งใครเลย — เป็นตารางนัดส่วนตัวของเซล (เข้าพบลูกค้า/สำรวจหน้างาน)
      // ไม่ได้มอบหมายให้ใคร ไม่กินคิวใคร และไม่ต้องรออนุมัติ
      // 🐛 ที่แก้: เดิมตกไปเข้า sendPushToAllUsers ด้านล่าง = เซลลงนัดหนึ่งครั้ง ช่างทั้งบริษัท
      // ได้แจ้งเตือน "เพิ่มงานใหม่เข้าระบบ" พร้อมลิงก์ไปหน้าการดำเนินงานที่ไม่มีงานนั้นอยู่จริง
      const isSalesPlan = primary.department === DEPARTMENT.SALES;
      if (isSalesPlan) {
        // ไม่ต้องแจ้งเตือนอะไร
      } else if (primary.approvalStatus === "pending") {
        sendPushToRoles(SUPERVISOR_ROLES, {
          title: `⏳ ${creatorName} ส่งงานใหม่รออนุมัติ`,
          body: jobLabelNew,
          // ✅ พาไปที่ "แท็บรออนุมัติ" ตรงๆ ไม่ใช่ /operation/<id> แบบเดิม — สิ่งเดียวที่ต้องทำต่อจาก
          // แจ้งเตือนนี้คือกดอนุมัติ/ไม่อนุมัติ ซึ่งปุ่มอยู่ในแท็บนั้นที่เดียว (การ์ดในแท็บ "รายการงาน"
          // ไม่มีปุ่มอนุมัติเลย) เดิมกดมาแล้วต้องมาสลับแท็บเองอีกทีทุกครั้ง
          // 🧹 แท็บ "รออนุมัติ" ย้ายออกจากหน้าการดำเนินงานไปเป็นเมนู "คำขอลงงาน" แล้ว
          url: "/dispatch?tab=approvals",
          tag: notifyTag,
          renotify: true,
        }).catch((err) => console.error("❌ Push notify error (approval-request):", err));
      } else {
        if (primary.resPerson && primary.resPerson !== req.userId) {
          sendPushToUsers(primary.resPerson, {
            title: `📋 ${creatorName} มอบหมายงานใหม่ให้คุณ`,
            body: jobLabelNew,
            url: `/operation/${primary._id}`,
            tag: notifyTag,
            renotify: true,
          }).catch((err) => console.error("❌ Push notify error (assign):", err));
        }

        sendPushToAllUsers(
          {
            title: `🆕 ${creatorName} เพิ่มงานใหม่เข้าระบบ`,
            body: jobLabelNew,
            url: `/operation/${primary._id}`,
            tag: notifyTag,
            renotify: true,
          },
          [req.userId, primary.resPerson]
        ).catch((err) => console.error("❌ Push notify error (new-event-broadcast):", err));
      }

      res.status(201).json({ events });
    } catch (error) {
      console.error(error);
      res.status(500).send("Internal Server Error");
    }
  });

  router.get("/", verifyToken, async (req, res) => {
    try {
      // ⚠️ route นี้คืนงาน "ทั้งหมด" โดยตั้งใจ (ตัวกรองตามสิทธิ์อยู่ที่ GET /event-op) — เดิมมีบรรทัด
      // ดึง userId/userRole ค้างไว้ตรงนี้แต่ไม่มีอะไรเรียกใช้เลย ทำให้อ่านแล้วเข้าใจผิดว่ามีการกรองสิทธิ์
      // ลบออกแล้ว ถ้าจะเพิ่มการกรองในอนาคตให้ทำที่ query ตรงๆ ไม่ใช่ประกาศตัวแปรทิ้งไว้เฉยๆ

      // let userEvents;

      // ✅ เงื่อนไข: ถ้าเป็น admin ให้ดึง event ทั้งหมด
      // if (userRole === "admin") {
      //   userEvents = await CalendarEvent.find({});
      // } else {
      //   // ✅ ถ้าเป็น user ทั่วไป ให้ดึงเฉพาะ event ของตัวเอง
      //   userEvents = await CalendarEvent.find({ userId: userId });
      // }
      // userEvents = await CalendarEvent.find({});

      // // ดึง userId ทั้งหมดจาก userEvents
      // const userIds = userEvents.map((event) => event.userId);

      // // ค้นหาข้อมูลผู้ใช้จาก model User โดยใช้ userIds
      // const users = await User.find({ _id: { $in: userIds } });

      // // แปลงค่า userId ใน userEvents เป็น role จากข้อมูลใน users
      // const updatedUserEvents = userEvents.map((event) => {
      //   const user = users.find(
      //     (user) => user._id.toString() === event.userId.toString()
      //   );
      //   if (user) {
      //     // คัดลอกค่าทั้งหมดของผู้ใช้ยกเว้น _id
      //     const { _id, ...userDataWithoutId } = user.toObject();
      //     return { ...event._doc, user: userDataWithoutId }; // เพิ่ม property user ที่มีค่าข้อมูลผู้ใช้ยกเว้น _id
      //   } else {
      //     return event; // ถ้าไม่พบ user ให้ใช้ค่าเดิมของ event
      //   }
      // });

      // ✅ ตัดงาน "วางแผนล่วงหน้า" (unscheduled) ออกเสมอ — ยังไม่มีวันที่จริง ไม่ควรโผล่ในปฏิทิน
      // ✅ ปฏิทินรวม — กรองตามแผนกเช่นกัน ไม่งั้นเซลจะเห็นงานช่างเต็มปฏิทินทั้งที่ไม่เกี่ยวกัน
      const userEvents = await CalendarEvent.find(
        withDepartmentScope({ unscheduled: { $ne: true } }, req)
      ).lean();

      // 🐛 BUG ที่แก้ (ปฏิทินพังทั้งหน้าถ้ามี event สักตัวที่ไม่มี userId): userId ใน schema ไม่ได้เป็น
      // required — งานที่หลุดมาโดยไม่มี userId (ข้อมูลเก่า/นำเข้า/สร้างผ่านทางอื่น) จะทำให้
      // event.userId.toString() โยน TypeError → 500 ทั้ง endpoint → ปฏิทินโหลดไม่ขึ้นเลยสำหรับทุกคน
      // เพราะงานเสียแค่ตัวเดียว — กันด้วย optional chaining แล้วข้ามเฉพาะตัวที่ไม่มีไปเงียบๆ
      const uniqueUserIds = [...new Set(userEvents.map((e) => e.userId?.toString()).filter(Boolean))];

      const users = await User.find({ _id: { $in: uniqueUserIds } }).lean();

      const userMap = new Map();
      users.forEach((user) => {
        userMap.set(user._id.toString(), user);
      });

      const updatedUserEvents = userEvents.map((event) => {
        const user = event.userId ? userMap.get(event.userId.toString()) : null;
        if (user) {
          const { _id, password, ...userDataWithoutId } = user;
          return { ...event, user: userDataWithoutId };
        }
        return event;
      });

      // 🐛 BUG ที่แก้ (ไม่มีงานเลย = วันหยุดหายทั้งปฏิทิน): เดิมตอบ 404 เมื่อยังไม่มีงานสักรายการ ซึ่งไม่ใช่
      // ข้อผิดพลาด — "ยังไม่มีงาน" เป็นผลลัพธ์ที่ถูกต้อง — axios ฝั่งจอจะ throw ทำให้ Promise.all ใน
      // getFetchEvents (ที่ดึงงาน + วันหยุดราชการพร้อมกัน) reject ทั้งก้อน วันหยุดที่ดึงมาสำเร็จแล้วจึงถูก
      // ทิ้งไปด้วย ปฏิทินเลยว่างสนิทไม่มีแม้แต่วันหยุด + ขึ้น error ใน console ทุก 30 วินาทีจาก polling
      // ✅ ตอบ 200 พร้อม array ว่างตามหลัก REST — ฝั่งจอจัดการเคสว่างได้อยู่แล้ว
      res.json({ userEvents: updatedUserEvents });
    } catch (err) {
      console.error("❌ Error fetching calendar events:", err);
      res.status(500).send("เกิดข้อผิดพลาดในการดึงข้อมูลปฏิทิน");
    }
  });

  router.get("/:id", verifyToken, async (req, res) => {
    try {
      const { id } = req.params;

      const event = await CalendarEvent.findById(id);

      if (!event) {
        return res.status(404).json({ message: "ไม่พบแผนงานที่ต้องการ" });
      }

      // ดึงข้อมูล user ที่สร้างแผนงานนี้ (ถ้ามี)
      const user = await User.findById(event.userId).select("-password"); // ตัด password ออก

      res.status(200).json({ event: { ...event._doc, user } });
    } catch (error) {
      console.error("❌ Error fetching event by ID:", error);
      res.status(500).json({ message: "เกิดข้อผิดพลาดในการดึงข้อมูลแผนงาน" });
    }
  });

  router.put("/:id", verifyToken, async (req, res) => {
    try {
      const id = req.params.id;
      const userId = req.userId;

      const existingEvent = await CalendarEvent.findById(id);
      if (!existingEvent) {
        return res.status(404).json({ message: "Event not found" });
      }

      // ✅ เงื่อนไข: admin แก้ไขได้ทุก event, ส่วนคนอื่นแก้ไขได้เฉพาะ event ที่ตัวเองเพิ่ม
      // หรือ event ที่ได้รับมอบหมาย (resPerson ตรงกับ ID ตัวเอง หรือ team ตรงกับชื่อตัวเอง — เผื่อ event เก่า)
      // หรือเป็น "ผู้รับผิดชอบ" ของงานนี้ (responsiblePersonId/responsiblePerson — คนละแนวคิดกับ team/
      // resPerson ด้านบน อาจไม่ได้เข้างานเองแต่ยังรับผิดชอบอยู่)
      // ⚠️ BUG ที่แก้: เดิมไม่เช็ค responsiblePerson เลย ทำให้คนที่ถูกตั้งเป็นผู้รับผิดชอบแต่ไม่ได้อยู่ใน
      // team/resPerson ของครั้งนี้ แก้ไขงานตัวเองไม่ได้เลย (403 ทุกครั้ง)
      const isOwner = existingEvent.userId.toString() === userId.toString();
      // ✅ นับ "ลูกทีม" (teamMembers) เป็นผู้ได้รับมอบหมายด้วย — ฝั่งจอเปิดให้ลูกทีมแก้สีบนปฏิทิน/
      // เลขที่อ้างอิงเอกสาร/รายละเอียดงานของงานตัวเองได้แล้ว (ดู canEditJobNotes ใน EditEvent.js)
      // ถ้าไม่นับตรงนี้ ลูกทีมจะกรอกได้แต่กดบันทึกแล้วเด้ง 403 ทุกครั้ง = ฟีเจอร์ที่ใช้งานจริงไม่ได้เลย
      // ⚠️ นี่เป็นแค่ด่าน "มีสิทธิ์แตะงานนี้ไหม" — ข้อจำกัดอื่นยังบังคับครบเหมือนเดิมทุกข้อ (งานปิดแล้ว
      // ห้ามช่างแก้ / งานรออนุมัติห้ามแตะ / ปิดงานเองไม่ได้ ฯลฯ ดูเงื่อนไขถัดจากนี้ไป)
      const isTeamMemberOfEvent = (existingEvent.teamMembers || []).some(
        (m) => (m?.userId && m.userId === userId) || (m?.name && m.name === req.user.fname)
      );
      const isAssigned =
        (existingEvent.resPerson && existingEvent.resPerson === userId) ||
        (existingEvent.team && existingEvent.team === req.user.fname) ||
        (existingEvent.responsiblePersonId && existingEvent.responsiblePersonId === userId) ||
        (existingEvent.responsiblePerson && existingEvent.responsiblePerson === req.user.fname) ||
        isTeamMemberOfEvent;

      // ⚠️ BUG ที่แก้: เดิมเช็คแค่ req.user.role !== "admin" ตรงนี้ (manager ที่ไม่ใช่เจ้าของ/ไม่ได้รับ
      // มอบหมายจะโดน 403 ทั้งที่ทุก route อื่นในไฟล์นี้ให้สิทธิ์ admin/manager เท่ากันหมด) — แก้ให้ตรง
      // กับทุกจุดอื่น เทียบ pattern เดียวกับ isAdminOrManager ด้านล่าง (ย้ายมาคำนวณก่อนใช้ตรงนี้เลย)
      const isAdminOrManager = can(req.user, "editAnyJob");
      if (!isAdminOrManager && !isOwner && !isAssigned) {
        return res.status(403).json({ message: "คุณไม่มีสิทธิ์แก้ไข Event นี้" });
      }

      // ✅ งานที่ปิดแล้ว (ดำเนินการเสร็จสิ้น) ห้ามช่างแก้ไขอีก มีแค่ admin/manager เท่านั้นที่ทำได้
      // ยกเว้น: comment (คุยโต้ตอบกัน), activityLog (แค่ log ไม่กระทบข้อมูลงานจริง), และฟิลด์ระบบ
      // ติดตามใบเสนอราคาทั้งชุด — เพราะการติดตามใบเสนอราคามักเกิด "หลัง" งานถูกปิดแล้ว (ช่างปิดงาน
      // หน้างานก่อน ค่อยตามเรื่องเอกสาร/ใบเสนอราคากับลูกค้าทีหลัง) ถ้าล็อกไว้เหมือนข้อมูลงานอื่นจะทำให้
      // ช่างอัปเดตสถานะใบเสนอราคาของงานตัวเองไม่ได้เลยทั้งที่เป็นกรณีปกติ ไม่ใช่ข้อยกเว้น
      const NON_BLOCKING_FIELDS = [
        "comments", "activityLog",
        "quotationStatus", "quotationSentAt", "quotationDecisionAt", "quotationDecisionBy",
        "quotationAmount", "quotationFollowUpNote",
      ];
      // ✅ งานที่ปิดแล้ว — ช่างที่เกี่ยวข้องยังแก้ได้ 3 อย่าง ตามที่ผู้ใช้ระบุ:
      //   • เลขที่อ้างอิงเอกสาร (docNo) และรายละเอียดงาน (description) — เรื่องเอกสารมักตามมาทีหลัง
      //     งานปิดเสมอ (ได้เลขจริงตอนวางบิล / เติมรายละเอียดหน้างานทีหลัง) ถ้าล็อกตายต้องรบกวนแอดมินทุกครั้ง
      //   • สีบนปฏิทิน (backgroundColor/textColor/fontSize) — เป็นแค่การแสดงผล ไม่กระทบข้อมูลงาน/รายงาน/
      //     ยอดเงินใดๆ เลย
      // ⚠️ ตรวจแบบ "ทุกคีย์ที่ส่งมาต้องอยู่ในรายการนี้" ไม่ใช่ค่อยๆ คัดทีหลัง — เป็นด่านที่การันตีว่าวันที่/
      // ทีม/สถานะ/ครั้งที่ ของงานที่ปิดไปแล้วจะไม่ถูกแก้ได้เลยไม่ว่าฝั่งจอจะส่งอะไรมา (ฝั่งจอตัดให้แล้ว
      // ชั้นหนึ่ง ดู trimForClosedJob ใน EditEvent.js — แต่ห้ามเชื่อ client เป็นด่านสุดท้าย)
      const CLOSED_JOB_TECH_FIELDS = [
        ...NON_BLOCKING_FIELDS,
        "docNo", "description", "backgroundColor", "textColor", "fontSize",
      ];
      const isClosedJobAllowedUpdate = Object.keys(req.body).every((k) => CLOSED_JOB_TECH_FIELDS.includes(k));
      if (existingEvent.status === "ดำเนินการเสร็จสิ้น" && !isAdminOrManager && !isClosedJobAllowedUpdate) {
        return res.status(403).json({
          message: "งานนี้ปิดแล้ว แก้ได้เฉพาะเลขที่อ้างอิงเอกสาร รายละเอียดงาน และสีบนปฏิทิน",
        });
      }

      // ✅ งานที่ยัง "รออนุมัติ" (pending) — ช่าง/ผู้รับผิดชอบเปิดดูได้อย่างเดียว ทำอะไรไม่ได้เลยจนกว่า
      // แอดมิน/manager จะตัดสินใจก่อน (ตามที่ผู้ใช้ยืนยัน) บล็อกทุกฟิลด์แบบเข้ม ไม่ใช่แค่ปิดงานเหมือนเดิม
      // — ⚠️ เดิมมีคอมเมนต์เตือนว่าตัวจับเวลาอัตโนมัติที่เปลี่ยนสถานะเป็น "กำลังดำเนินการ" ทุก 30 วินาที
      // (ฝั่ง EventCalendar/index.js) ต้องไม่โดนบล็อกตรงนี้ ไม่งั้นจะ retry ค้างวนไม่จบ — ปัจจุบันไม่ใช่ปัญหา
      // แล้ว เพราะจุดนั้นกรองงานที่ยังไม่ approved ออกไปตั้งแต่ต้นแล้ว (ดู getApprovalState(event) ===
      // "approved" ที่นั่น) จึงไม่มีทางยิง PUT มาโดนบล็อกตรงนี้ซ้ำๆ อีกต่อไป
      const approvalState = existingEvent.approvalStatus || "approved";
      if (approvalState === "pending" && !isAdminOrManager) {
        return res.status(403).json({ message: "งานนี้ยังไม่ได้รับการอนุมัติ ดูข้อมูลได้อย่างเดียว แก้ไขไม่ได้จนกว่าจะอนุมัติหรือไม่อนุมัติก่อน" });
      }
      // ✅ งานที่ "ถูกปฏิเสธ" (rejected) ยังแก้ไขต่อได้ตามปกติ เพื่อส่งขออนุมัติใหม่ (ดู shouldResubmit
      // ด้านล่าง) — คนละเคสกับ pending ด้านบน แต่ยังห้าม "ขอปิดงาน"/ปิดงานจนกว่าจะได้รับการอนุมัติก่อน
      if (approvalState === "rejected" && !isAdminOrManager) {
        if (req.body.closeRequested === true) {
          return res.status(403).json({ message: "งานนี้ยังไม่ได้รับการอนุมัติ ยังขอปิดงานไม่ได้" });
        }
        if (req.body.status === "ดำเนินการเสร็จสิ้น") {
          return res.status(403).json({ message: "งานนี้ยังไม่ได้รับการอนุมัติ ยังปิดงานไม่ได้" });
        }
      }

      // ✅ แก้ไขงานที่ถูกปฏิเสธไปแล้ว (approvalStatus:"rejected") ถือเป็นการ "ส่งขออนุมัติใหม่"
      // โดยอัตโนมัติ ถ้าแก้ไข "เนื้อหางานจริง" (ไม่ใช่แค่ comment/log/สถานะเอกสารซึ่งไม่เกี่ยวกับสิ่งที่
      // แอดมินเคยปฏิเสธไป) — เจ้าของ/ผู้ถูกมอบหมายแก้ไขแล้วส่งกลับเข้าคิวรออนุมัติได้เองโดยไม่ต้องรอแอดมิน
      // สร้างงานใหม่ทั้งอัน — เก็บ approvalRejectReason เดิมไว้ให้เห็นเป็นประวัติ (จะถูกล้างทิ้งเองตอน
      // ตัดสินใจครั้งถัดไปที่ PUT /:id/approval)
      const APPROVAL_RESUBMIT_FIELDS = [
        "company", "site", "title", "system", "time", "team", "resPerson", "teamMembers",
        "date", "start", "end", "startTime", "endTime", "subject", "description", "docNo", "jobValue",
      ];
      const touchesResubmitField = APPROVAL_RESUBMIT_FIELDS.some((f) => req.body[f] !== undefined);
      const shouldResubmit = approvalState === "rejected" && !isAdminOrManager && touchesResubmitField;
      const resubmitterName = [req.user?.fname, req.user?.lname].filter(Boolean).join(" ") || req.user?.username || "ผู้ดูแลระบบ";

      const {
        docNo,
        company,
        site,
        title,
        system,
        time,
        team,
        date,
        backgroundColor,
        textColor,
        fontSize,
        start,
        end,
        allDay,
        status,
        status_two,
        status_three,
        isAutoUpdated,
        manualStatus,
        subject,
        description,
        startTime,
        endTime,
        documentSentQuotation,
        documentSentReport,
        documentSentInvoice,
        documentSentCompletion,
        quotationApplicable,
        invoiceApplicable,
        completionApplicable,
        documentSent,
        documentFile, // ✅ เพิ่มตรงนี้
        resPerson, // ✅ เพิ่มตรงนี้
        teamMembers, // ✅ ลูกทีมเพิ่มเติม (แสดงผลอย่างเดียว ไม่กระทบสิทธิ์/แจ้งเตือน)

        // ✅ ฟิลด์สำหรับ flow ของช่าง (เช็คอิน/เช็คเอาท์/สรุปงาน/ประวัติกิจกรรม)
        // และ flow ขอปิดงาน → รออนุมัติจากแอดมิน (เดิมไม่ได้ whitelist ไว้ ทำให้ไม่เคยถูกบันทึกจริง)
        checkedInAt,
        checkedOutAt,
        workNote,
        activityLog,
        closeRequested,
        closeRequestedAt,
        closeRequestedBy,
        closeRequestedByUserId,
        closeApprovedAt,
        closeApprovedBy,
        closeRejectedAt,
        closeRejectedBy,
        closeRejectReason,
        comments,
        jobGroupId, // ✅ ใช้ตอนแก้ไข event เดี่ยวแล้วเพิ่มวันที่อื่นให้กลายเป็นงานเดียวกันภายหลัง

        // ✅ ระบบติดตามใบเสนอราคา (ดูหน้า /quotations)
        quotationStatus,
        quotationSentAt,
        quotationDecisionAt,
        quotationDecisionBy,
        quotationAmount,
        quotationFollowUpNote,

        // ✅ ข้อมูลสัญญา — แก้ทีละ record ผ่านตรงนี้ได้ (เช่นแก้แค่ครั้งเดียว) แต่ถ้าต้องการแก้พร้อมกัน
        // ทุกครั้งในสัญญาเดียวกันให้ใช้ PUT /contract/:contractGroupId แทน (กันข้อมูลเพี้ยนไม่ตรงกัน)
        contractGroupId,
        contractNo,
        quotationNo,
        contractStart,
        contractEnd,
        visitCount,
        // 🐛 BUG ที่แก้ (แก้ "เข้าทุกกี่เดือน" จากหน้าปฏิทินแล้วหายเงียบ): route นี้ไม่เคยรับ intervalMonths
        // เลยแม้แต่ครั้งเดียว ทั้งที่ฟอร์มแก้ไขงาน (EditEvent.js) มีช่องนี้ให้กรอกและส่งค่ามาทุกครั้งที่บันทึก
        // — ผู้ใช้แก้แล้วกดบันทึก ได้ข้อความ "สำเร็จ" แต่ค่าไม่เคยถูกเก็บ ต้องไปแก้ที่หน้า "ภาพรวมงาน"
        // (PUT /contract/:contractGroupId ซึ่งรับฟิลด์นี้อยู่แล้ว) เท่านั้นถึงจะได้ผลจริง
        intervalMonths,
        jobValue,
      } = req.body;

      // ✅ ตรวจข้อมูลสัญญาให้ตรงกับ PUT /contract/:contractGroupId และ POST /draft เป๊ะๆ — เดิม route นี้
      // ไม่ตรวจอะไรเลย ทำให้ "ฟิลด์เดียวกันของสัญญาเดียวกัน" มีกติกาคนละชุดขึ้นกับว่าแก้จากหน้าไหน:
      // แก้จากหน้า "ภาพรวมงาน" ติดเพดาน 12 ครั้ง แต่แก้จากฟอร์มในปฏิทินใส่เท่าไหร่ก็ได้ — ตั้งเกิน 12 ไป
      // แล้วตารางภาพรวมงานจะเรนเดอร์ได้แค่ 12 คอลัมน์ (ดู maxVisitCount) ครั้งที่เกินมามองไม่เห็น/เข้าไม่ถึง
      // และแก้กลับจากหน้านั้นก็ไม่ได้อีก (โดนเพดานบล็อก) กลายเป็นสัญญาที่ค้างอยู่ในสถานะที่ซ่อมได้ทางเดียว
      if (intervalMonths !== undefined && intervalMonths !== "" && intervalMonths !== null) {
        const n = Number(intervalMonths);
        if (!n || n < 1 || n > 24) {
          return res.status(400).json({ message: "ระยะห่างระหว่างรอบต้องอยู่ระหว่าง 1-24 เดือน" });
        }
      }
      if (visitCount !== undefined && visitCount !== "" && visitCount !== null) {
        const n = Number(visitCount);
        if (!n || n < 1 || n > 12) {
          return res.status(400).json({ message: "จำนวนครั้งทั้งหมดต้องอยู่ระหว่าง 1-12 ครั้ง" });
        }
      }

      // ⚠️ ตัดออกตามที่ผู้ใช้ขอ: เดิมเช็คช่างชนกัน (double-booking) ทุกครั้งที่ resPerson/ช่วงวันที่
      // เปลี่ยนไปจากเดิม ทำให้ลากงานย้ายวันบนปฏิทิน (eventDrop → PUT /:id) พังบ่อยเพราะช่างคนเดิมมีงาน
      // อื่นอยู่แล้ววันนั้น ทั้งที่ในทางปฏิบัติ 1 ทีมรับงานหลายงานในวันเดียวกันได้ตามปกติ ไม่ควรบล็อก
      const newEvent = {
        docNo,
        company,
        site,
        title,
        system,
        time,
        team,
        date,
        backgroundColor,
        textColor,
        fontSize,
        start,
        end,
        allDay,
        status,
        status_two,
        status_three,
        isAutoUpdated,
        manualStatus,
        subject,
        description,
        startTime,
        endTime,
        documentSentQuotation,
        documentSentReport,
        documentSentInvoice,
        documentSentCompletion,
        quotationApplicable,
        invoiceApplicable,
        completionApplicable,
        documentSent,
        documentFile, // ✅ เพิ่มตรงนี้
        resPerson, // ✅ เพิ่มตรงนี้
        teamMembers,

        checkedInAt,
        checkedOutAt,
        workNote,
        activityLog,
        closeRequested,
        closeRequestedAt,
        closeRequestedBy,
        closeRequestedByUserId,
        closeApprovedAt,
        closeApprovedBy,
        closeRejectedAt,
        closeRejectedBy,
        closeRejectReason,
        comments,
        jobGroupId,

        quotationStatus,
        quotationSentAt,
        quotationDecisionAt,
        quotationDecisionBy,
        quotationAmount,
        quotationFollowUpNote,

        contractGroupId,
        contractNo,
        quotationNo,
        contractStart,
        contractEnd,
        visitCount,
        intervalMonths, // ✅ เดิมตกหล่นไป ทำให้ค่าที่แก้จากฟอร์มในปฏิทินไม่เคยถูกบันทึก (ดูคอมเมนต์ด้านบน)
        jobValue,

        // ✅ ส่งขออนุมัติใหม่อัตโนมัติ (ดู shouldResubmit ด้านบน) — ไม่เข้าเงื่อนไขก็ไม่ใส่ key พวกนี้เลย
        // (ไม่ใช่ใส่เป็น undefined) ปล่อยให้ approvalStatus เดิมในฐานข้อมูลไม่ถูกแตะต้อง
        ...(shouldResubmit ? {
          approvalStatus: "pending",
          approvalRequestedAt: new Date(),
          approvalRequestedBy: resubmitterName,
          approvalRequestedByUserId: userId,
          approvalDecidedAt: null,
          approvalDecidedBy: "",
        } : {}),

        userId: existingEvent.userId, // ❌ ไม่เปลี่ยนเจ้าของเดิม
        // lastModifiedBy: req.userId, // ✅ บันทึกคนที่แก้ไขล่าสุด
      };

      // ✅ สิทธิ์ตรวจสอบไปแล้วด้านบน (isOwner / isAssigned / admin) จึงใช้แค่ _id พอ
      const updatedEvent = await CalendarEvent.findOneAndUpdate({ _id: id }, newEvent, {
        new: true,
      }).exec();

      if (!updatedEvent) {
        return res.status(404).json("Event not found");
      }

      // ✅ แจ้งเตือนตามการเปลี่ยนแปลงสำคัญ (ไม่ await เพื่อไม่ให้ response ช้าลง)
      // เทียบค่าก่อน (existingEvent) กับค่าที่ส่งมาใหม่ เพื่อดูว่า "เพิ่งเกิดการเปลี่ยนแปลง" จริงๆ ไม่ใช่แค่ค่าเดิม
      const jobLabel = `${updatedEvent.company || "-"}${updatedEvent.site ? " - " + updatedEvent.site : ""}`;

      if (shouldResubmit) {
        sendPushToRoles(SUPERVISOR_ROLES, {
          title: `🔄 ${resubmitterName} แก้ไขงานที่ถูกตีกลับ ส่งขออนุมัติใหม่`,
          body: `${updatedEvent.title || "งาน"} · ${jobLabel}`,
          url: `/operation/${updatedEvent._id}`,
          tag: `approval-resubmit-${updatedEvent.jobGroupId || updatedEvent._id}`,
          renotify: true,
        }).catch((err) => console.error("❌ Push notify error (approval-resubmit):", err));
      }

      // ✅ งานที่เข้าหลายวันไม่ติดกัน (ผูกด้วย jobGroupId เดียวกัน) ตอนนี้ action อย่าง "ขอปิดงาน"/
      // "อนุมัติ"/"ไม่อนุมัติ" ฝั่ง frontend อัปเดตทุกวันในกลุ่มพร้อมกันด้วย Promise.all ยิง PUT
      // มาทีละวัน — ถ้า tag อิงแค่ _id ของแต่ละวัน (ไม่ซ้ำกัน) จะได้ push แจ้งเตือนซ้อนกันหลายอันสำหรับ
      // งานเดียวกัน ใช้ jobGroupId เป็น tag แทนเมื่อมี ให้เบราว์เซอร์ยุบเหลือแจ้งเตือนเดียวต่องาน
      const notifyTag = `event-${updatedEvent.jobGroupId || updatedEvent._id}`;

      if (resPerson && resPerson !== existingEvent.resPerson && resPerson !== userId) {
        // ✅ ใส่วันที่/เวลาให้เหมือนแจ้งเตือน "งานใหม่" ตอนเพิ่ม event — คนที่เพิ่งถูกมอบหมายงานควรรู้
        // ตั้งแต่แจ้งเตือนแรกเลยว่างานนัดไว้เมื่อไหร่ ไม่ต้องเปิดแอพเข้าไปดูเอง
        const reassignDateLabel = thaiDate(updatedEvent.start || updatedEvent.date);
        const reassignTimeLabel = (updatedEvent.startTime || updatedEvent.endTime)
          ? `${updatedEvent.startTime || "-"}-${updatedEvent.endTime || "-"}`
          : "ทั้งวัน";
        // ✅ ใส่ชื่อคนมอบหมายไว้ในหัวข้อ เหมือนแจ้งเตือน "งานใหม่" ตอนสร้าง event
        const reassignerName = [req.user?.fname, req.user?.lname].filter(Boolean).join(" ") || req.user?.username || "ผู้ดูแลระบบ";
        sendPushToUsers(resPerson, {
          title: `📋 ${reassignerName} มอบหมายงานให้คุณ`,
          body: `📅 ${reassignDateLabel} 🕐 ${reassignTimeLabel} · ${updatedEvent.title || "งาน"} · ${jobLabel}`,
          url: `/operation/${updatedEvent._id}`,
          tag: notifyTag,
          renotify: true,
        }).catch((err) => console.error("❌ Push notify error (reassign):", err));
      }

      if (closeRequested === true && !existingEvent.closeRequested) {
        sendPushToRoles(SUPERVISOR_ROLES, {
          title: "⏳ มีคำขอปิดงานใหม่",
          body: `${closeRequestedBy || "ช่าง"} ขอปิดงาน: ${jobLabel}`,
          url: `/operation/${updatedEvent._id}`,
          tag: notifyTag,
          renotify: true,
        }).catch((err) => console.error("❌ Push notify error (close-requested):", err));
      }

      // ✅ ใช้ closeRequestedByUserId (userId จริงของคนกดขอปิดงาน) เป็นหลัก เพราะ resPerson/userId
      // ของ event อาจไม่ตรงกับคนที่กดขอปิดงานจริง (เช่น มอบหมายผ่านชื่อทีมแบบเก่า ไม่มี resPerson)
      // ถ้าไม่มี (event เก่าก่อนมีฟิลด์นี้) ค่อย fallback ไปที่ resPerson/userId ของ event ตามเดิม
      const closeRequesterId = updatedEvent.closeRequestedByUserId || updatedEvent.resPerson || updatedEvent.userId;

      // ⚠️ เดิมเช็คแค่ "!existingEvent.closeApprovedAt / closeRejectedAt" ซึ่งตรวจจับได้แค่ครั้งแรกที่ set
      // เท่านั้น ถ้างานเดิมเคยถูกอนุมัติ/ไม่อนุมัติมาก่อนแล้ว (เช่น ขอปิดงานใหม่แล้วโดนปฏิเสธซ้ำ)
      // ค่าเก่าที่ไม่ใช่ null จะทำให้เงื่อนไขเป็นเท็จเสมอ แจ้งเตือนซ้ำจึงไม่ถูกส่งอีกเลย
      // แก้เป็นเทียบเวลาว่า "เพิ่งเปลี่ยนเป็นค่าใหม่จริงๆ" แทน
      const isNewTimestamp = (incoming, previous) =>
        incoming && new Date(incoming).getTime() !== new Date(previous || 0).getTime();

      if (isNewTimestamp(closeApprovedAt, existingEvent.closeApprovedAt)) {
        sendPushToUsers([closeRequesterId, updatedEvent.resPerson, updatedEvent.userId], {
          title: "✅ แอดมินอนุมัติปิดงานแล้ว",
          body: jobLabel,
          url: `/operation/${updatedEvent._id}`,
          tag: notifyTag,
          renotify: true,
        }).catch((err) => console.error("❌ Push notify error (approved):", err));
      }

      if (isNewTimestamp(closeRejectedAt, existingEvent.closeRejectedAt)) {
        sendPushToUsers([closeRequesterId, updatedEvent.resPerson, updatedEvent.userId], {
          title: "❌ แอดมินไม่อนุมัติปิดงาน",
          body: closeRejectReason ? `${jobLabel}: ${closeRejectReason}` : jobLabel,
          tag: notifyTag,
          renotify: true,
          url: `/operation/${updatedEvent._id}`,
        }).catch((err) => console.error("❌ Push notify error (rejected):", err));
      }

      // ✅ แจ้งเตือนเมื่อมีข้อความคอมเมนต์ใหม่ — comments ถูกส่งมาทั้งชุดเสมอ (เหมือน activityLog)
      // จึงเทียบจำนวนข้อความเดิม/ใหม่แทนการเช็ค timestamp เดี่ยวๆ
      if (Array.isArray(comments) && comments.length > (existingEvent.comments || []).length) {
        const lastComment = comments[comments.length - 1];
        if (lastComment) {
          const isFromAdmin = isSupervisorRole(lastComment);
          const notifyPromise = isFromAdmin
            ? sendPushToUsers([closeRequesterId, updatedEvent.resPerson, updatedEvent.userId], {
                title: `💬 ${lastComment.userName || "แอดมิน"} ตอบกลับ`,
                body: `${jobLabel}: ${lastComment.message}`,
                url: `/operation/${updatedEvent._id}`,
                tag: notifyTag,
                renotify: true,
              })
            : sendPushToRoles(SUPERVISOR_ROLES, {
                title: `💬 ${lastComment.userName || "ช่าง"} คอมเมนต์ใหม่`,
                body: `${jobLabel}: ${lastComment.message}`,
                url: `/operation/${updatedEvent._id}`,
                tag: notifyTag,
                renotify: true,
              });
          notifyPromise.catch((err) => console.error("❌ Push notify error (comment):", err));
        }
      }

      res.status(200).json({ updatedEvent: updatedEvent }); // ส่งข้อมูลของเหตุการณ์ที่ถูกอัปเดตกลับไป
    } catch (err) {
      res.status(500).json(err.message);
    }
  });

  router.delete("/:id", verifyToken, async (req, res) => {
    try {
    const id = req.params.id;
      const userId = req.userId;

      const existingEvent = await CalendarEvent.findById(id);
      if (!existingEvent) {
        return res.status(404).json({ message: "Event not found" });
      }

      // ✅ เงื่อนไข: admin/manager ลบได้ทุก event, user คนอื่นลบได้เฉพาะของตัวเอง — เดิมเช็คแค่ "admin"
      // เท่านั้น (manager ลบของคนอื่นไม่ได้เลย) ทั้งที่ทุก route ที่เกี่ยวกับสัญญาในไฟล์นี้ให้สิทธิ์
      // admin/manager เท่ากันหมด และหน้า "ภาพรวมสัญญา" ที่เรียก route นี้ก็เปิดให้แค่ admin/manager อยู่แล้ว
      const isAdminOrManager = can(req.user, "editAnyJob");
      if (
        !isAdminOrManager &&
        existingEvent.userId.toString() !== userId.toString()
      ) {
        return res.status(403).json({ message: "คุณไม่มีสิทธิ์ลบ Event นี้" });
      }

      // ✅ งานที่ปิดแล้ว (ดำเนินการเสร็จสิ้น) ห้ามช่างลบอีก มีแค่ admin/manager เท่านั้นที่ทำได้
      if (existingEvent.status === "ดำเนินการเสร็จสิ้น" && !isAdminOrManager) {
        return res.status(403).json({ message: "งานนี้ปิดแล้ว ไม่สามารถลบได้" });
      }

      // ❌ งานที่ยังรออนุมัติ ช่างทำอะไรไม่ได้เลย รวมถึงลบด้วย (เทียบ pattern เดียวกับ PUT /:id) —
      // เปิดดูได้อย่างเดียว
      if ((existingEvent.approvalStatus || "approved") === "pending" && !isAdminOrManager) {
        return res.status(403).json({ message: "งานนี้ยังไม่ได้รับการอนุมัติ ดูข้อมูลได้อย่างเดียว แก้ไขไม่ได้จนกว่าจะอนุมัติหรือไม่อนุมัติก่อน" });
      }

      // Delete file from database
      await CalendarEvent.findByIdAndDelete(id);

      res.status(200).send("Event deleted successfully");
    } catch (err) {
      console.error("Error deleting Event:", err);
      res.status(500).send(err.message);
    }
  });
};
