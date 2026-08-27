/**
 * งานสัญญา — รวม/ผูก/ถอด/ย้ายครั้ง และแก้ไขข้อมูลระดับสัญญา
 *
 * แยกออกมาจาก routes/calendarEvent.js เดิมที่ยาว 2,708 บรรทัดในไฟล์เดียว (29 route)
 * ⚠️ ลำดับการประกาศ route ภายในไฟล์นี้ = ลำดับเดิม ห้ามสลับ (ดูเหตุผลที่ index.js)
 */
const {
  CalendarEvent,
  verifyToken,
  can,
  crypto,
  MAX_VISIT_COUNT,
  findDuplicateContractNo,
  diffContractFields,
} = require("./shared");

module.exports = (router) => {
  // ✅ รวมงานเก่าที่ยังไม่มี contractGroupId (สร้างก่อนมีฟีเจอร์สัญญา) เข้าเป็นสัญญาเดียวกัน — เลือก
  // event ที่มีอยู่แล้วมาผูก contractGroupId ใหม่ให้ พร้อมเรียง "ครั้งที่" ใหม่ตามวันที่จริง (ค่า time
  // เดิมของงานเก่าไม่น่าเชื่อถือ อาจว่าง/ซ้ำ/มั่วมาก่อน) — เฉพาะ admin/manager เพราะเป็นการแก้ไขข้อมูล
  // ย้อนหลังเป็นชุด ไม่ผูกกับสิทธิ์ความเป็นเจ้าของ/ผู้ถูกมอบหมายของ event เดี่ยวๆ แบบ PUT /:id
  //
  // ⚠️ ต้องประกาศ "ก่อน" PUT /contract/:contractGroupId ด้านล่าง — ทั้งคู่เป็น path 2 segment
  // เหมือนกัน ("contract/merge" กับ "contract/:contractGroupId") ถ้าสลับลำดับ Express จะจับ "merge"
  // เป็นค่า :contractGroupId ไปแทน route นี้จะไม่มีทางถูกเรียกถึงเลย
  router.put("/contract/merge", verifyToken, async (req, res) => {
    try {
      if (!can(req.user, "editContracts")) {
        return res.status(403).json({ message: "เฉพาะแอดมิน/manager เท่านั้นที่จัดกลุ่มสัญญาได้" });
      }

      // ⚠️ BUG ที่แก้: เดิมรับ eventIds (array แบนๆ) แล้วให้แต่ละ document กลายเป็นคนละ "ครั้งที่" เสมอ
      // (idx+1 ต่อ document) — แต่ "งานทั่วไป" ที่เข้าหลายวันไม่ติดกัน (ผูกกันด้วย jobGroupId เดียวกัน)
      // 1 แถวในตารางอาจมีหลาย document ที่ควรรวมเป็น "ครั้งเดียวกัน" ไม่ใช่แยกคนละครั้ง — เปลี่ยนมารับ
      // rounds เป็น array ของ array (แต่ละกลุ่มย่อย = document ทั้งหมดที่ควรอยู่ครั้งเดียวกัน) แทน
      const { rounds, contractNo, quotationNo, contractStart, contractEnd, visitCount, intervalMonths, jobValue } = req.body;
      if (!Array.isArray(rounds) || rounds.length === 0 || rounds.some((r) => !Array.isArray(r) || r.length === 0)) {
        return res.status(400).json({ message: "กรุณาเลือกงานอย่างน้อย 1 รายการ" });
      }
      // ✅ ห้ามใส่จำนวนครั้งทั้งหมดเกิน 12 — เทียบ pattern เดียวกับ PUT /contract/:contractGroupId
      if (Number(visitCount) > 12) {
        return res.status(400).json({ message: "จำนวนครั้งทั้งหมดต้องไม่เกิน 12 ครั้ง" });
      }

      const allEventIds = rounds.flat();
      const events = await CalendarEvent.find({ _id: { $in: allEventIds } });
      if (events.length !== allEventIds.length) {
        return res.status(404).json({ message: "ไม่พบบางรายการที่เลือก อาจถูกลบหรือแก้ไขไปแล้ว" });
      }
      const eventsById = new Map(events.map((e) => [String(e._id), e]));

      // ✅ ห้ามเลขที่สัญญาซ้ำกับสัญญาอื่น — งานเก่าที่กำลังจะรวมนี้ยังไม่มี contractGroupId เลย
      // (ไม่ต้อง exclude อะไร) เจอที่ไหนก็ถือว่าซ้ำหมด
      if (contractNo) {
        const dupContractNo = await findDuplicateContractNo(contractNo);
        if (dupContractNo) {
          return res.status(409).json({ message: `เลขที่สัญญา "${contractNo}" ถูกใช้ไปแล้ว กรุณาตรวจสอบ` });
        }
      }

      const contractGroupId = crypto.randomUUID();
      // ✅ เรียง "ครั้งที่" ตามวันที่เริ่มเร็วสุดของแต่ละกลุ่ม (ไม่ใช่ตามลำดับที่เลือกในหน้าจอ)
      const sortedRounds = rounds.slice().sort((a, b) => {
        const aStart = Math.min(...a.map((id) => new Date(eventsById.get(String(id)).start).getTime()));
        const bStart = Math.min(...b.map((id) => new Date(eventsById.get(String(id)).start).getTime()));
        return aStart - bStart;
      });
      const resolvedVisitCount = Number(visitCount) > 0 ? Number(visitCount) : sortedRounds.length;

      const updated = (
        await Promise.all(
          sortedRounds.map(async (docIds, idx) => {
            const time = String(idx + 1);
            // ✅ กลุ่มที่มีมากกว่า 1 document (งานเข้าหลายวันไม่ติดกัน) ต้องผูก jobGroupId เดียวกันไว้
            // ด้วย — ใช้ตัวที่มีอยู่แล้วก่อน (เผื่อมีมาจากตอนสร้างเป็นงานทั่วไป) ไม่มีค่อยสุ่มใหม่
            let jobGroupId;
            if (docIds.length > 1) {
              const existingJobGroupId = docIds.map((id) => eventsById.get(String(id)).jobGroupId).find(Boolean);
              jobGroupId = existingJobGroupId || crypto.randomUUID();
            }
            return Promise.all(
              docIds.map((id) =>
                CalendarEvent.findByIdAndUpdate(
                  id,
                  {
                    $set: {
                      contractGroupId,
                      contractNo: contractNo || "",
                      quotationNo: quotationNo || "",
                      contractStart: contractStart || undefined,
                      contractEnd: contractEnd || undefined,
                      intervalMonths: Number(intervalMonths) > 0 ? Number(intervalMonths) : undefined,
                      visitCount: resolvedVisitCount,
                      jobValue: jobValue != null && jobValue !== "" ? Number(jobValue) : undefined,
                      time,
                      ...(jobGroupId ? { jobGroupId } : {}),
                    },
                  },
                  { new: true }
                )
              )
            );
          })
        )
      ).flat();

      res.json({ events: updated, contractGroupId });
    } catch (error) {
      console.error("❌ Error merging events into contract:", error);
      res.status(500).send("Internal Server Error");
    }
  });

  // ✅ ย้าย "งานทั่วไป" (event ที่ยังไม่มี contractGroupId) เข้าไปเป็นครั้งที่ N ของสัญญาที่มีอยู่แล้ว —
  // ต่างจาก PUT /contract/merge ตรงที่ merge สร้าง contractGroupId ใหม่เสมอ ส่วนตัวนี้ผูกเข้ากับสัญญา
  // เดิมที่เลือกไว้ ใช้แก้ไขกรณีจัดกลุ่มผิด (สร้างเป็นงานเดี่ยวทั้งที่จริงควรอยู่ในสัญญานี้)
  // (path มี "attach" คั่นเป็น segment ที่ 3 จึงไม่ชนกับ PUT /contract/:contractGroupId 2 segment ด้านล่าง)
  router.put("/contract/:contractGroupId/attach", verifyToken, async (req, res) => {
    try {
      if (!can(req.user, "editContracts")) {
        return res.status(403).json({ message: "เฉพาะแอดมิน/manager เท่านั้นที่ย้ายงานเข้าสัญญาได้" });
      }
      const { contractGroupId } = req.params;
      // ⚠️ BUG ที่แก้: เดิมรับ eventId เดี่ยวๆ — แต่ "งานทั่วไป" ที่เข้าหลายวันไม่ติดกัน (ผูกกันด้วย
      // jobGroupId เดียวกัน) 1 แถวในตารางอาจมีหลาย document ต้องย้ายเข้าสัญญาพร้อมกันทั้งหมด ไม่งั้น
      // วันอื่นๆ ของงานเดียวกันจะค้างเป็นงานทั่วไปแยกจากสัญญาที่เพิ่งย้ายไป
      const { eventIds, time } = req.body;
      if (!Array.isArray(eventIds) || eventIds.length === 0 || time === undefined || time === null || time === "") {
        return res.status(400).json({ message: "กรุณาระบุงานและครั้งที่ที่ต้องการย้ายเข้า" });
      }

      const targets = await CalendarEvent.find({ _id: { $in: eventIds } });
      if (targets.length !== eventIds.length) {
        return res.status(404).json({ message: "ไม่พบงานที่ต้องการย้ายบางรายการ" });
      }

      // ✅ ดึงข้อมูลสัญญาปลายทางจาก record ใดก็ได้ที่ผูก contractGroupId นี้อยู่แล้ว มาคัดลอกฟิลด์
      // ที่ต้องเหมือนกันทุกครั้ง (contractNo/quotationNo/visitCount/jobValue ฯลฯ) ลงงานที่ย้ายเข้ามาด้วย
      const contractHead = await CalendarEvent.findOne({ contractGroupId });
      if (!contractHead) {
        return res.status(404).json({ message: "ไม่พบสัญญานี้" });
      }

      // ✅ ครั้งที่เลือกอาจ "ลงตารางแล้ว" อยู่ก่อน — เดิมถือว่าซ้ำแล้วปฏิเสธเสมอ แต่จริงๆ ควรต่อเป็น
      // งานเดียวกัน (ผูก jobGroupId เดียวกัน) เหมือนปุ่ม "เพิ่มวันที่ต่อเนื่อง" ในตารางเอง — ไม่กินโควตา
      // ครั้งใหม่เพิ่ม เพราะครั้งนี้ถูกนับไปแล้ว ส่วนครั้งที่เป็นแค่ "แผนงานล่วงหน้า" (unscheduled จอง
      // ไว้แต่ยังไม่มีวันที่จริง) ห้ามต่อด้วย เพราะจะไปชนกับแผนงานล่วงหน้านั้นตอนแปลงเป็นของจริงทีหลัง
      const existingRoundDocs = await CalendarEvent.find({ contractGroupId, time: String(time) });
      const scheduledRoundDocs = existingRoundDocs.filter((v) => !v.unscheduled);
      const pendingRoundDoc = existingRoundDocs.find((v) => v.unscheduled);

      // ✅ งานที่กำลังย้ายเองอาจมีอยู่แล้วหลาย document ผูกกันด้วย jobGroupId เดิม (เข้าหลายวันไม่ต่อเนื่อง
      // มาก่อนตั้งแต่ตอนยังเป็นงานทั่วไป) — ถ้าครั้งปลายทางมีคนครองอยู่ก่อนด้วย ต้องรวมเป็น jobGroupId
      // เดียวกันทั้งฝั่งเดิมและฝั่งใหม่ ไม่ให้กลายเป็นสอง jobGroupId ปนกันในครั้งเดียวกัน
      const ownJobGroupId = targets.map((t) => t.jobGroupId).find(Boolean);

      let jobGroupId;
      if (scheduledRoundDocs.length > 0) {
        const holder = scheduledRoundDocs.find((v) => v.jobGroupId) || scheduledRoundDocs[0];
        jobGroupId = holder.jobGroupId || ownJobGroupId || crypto.randomUUID();
        if (!holder.jobGroupId) {
          await CalendarEvent.updateOne({ _id: holder._id }, { $set: { jobGroupId } });
        }
      } else if (pendingRoundDoc) {
        return res.status(409).json({
          message: `ครั้งที่ ${time} มีแผนงานล่วงหน้าจองไว้อยู่แล้ว กรุณาเลือกครั้งอื่น หรือไปลงวันที่จริงที่แผนงานล่วงหน้าแทน`,
        });
      } else {
        // ✅ ครั้งใหม่ล้วนๆ (ยังไม่มีใครจับจองอยู่) — กินโควตาครั้งใหม่จริง ต้องเช็คเพดานจำนวนครั้ง
        // นับ "จำนวนครั้งที่ไม่ซ้ำกัน" (ไม่ใช่จำนวน record ดิบ) เทียบ pattern เดียวกับที่แก้ไว้ใน
        // PUT /contract/:contractGroupId — กันนับเกินจริงตอนบางครั้งเข้างานไม่ต่อเนื่องมีหลาย record
        if (Number(contractHead.visitCount) > 0) {
          const scheduledEvents = await CalendarEvent.find({ contractGroupId, unscheduled: { $ne: true } })
            .select("time")
            .lean();
          const usedRounds = new Set(
            scheduledEvents.map((e) => e.time).filter((t) => t !== undefined && t !== null && t !== "").map(String)
          );
          if (usedRounds.size >= Number(contractHead.visitCount)) {
            return res.status(409).json({ message: "สัญญานี้ครบตามจำนวนครั้งที่กำหนดไว้แล้ว" });
          }
        }
        // ✅ เก็บ jobGroupId เดิมของกลุ่มไว้ถ้ามี (งานทั่วไปที่เข้าหลายวันไม่ติดกันมาก่อนแล้ว) ไม่ต้อง
        // สุ่มใหม่ถ้ามีแค่ document เดียว (undefined ก็ปล่อยว่างไว้ตามเดิม ไม่ผูก jobGroupId ให้เปล่าๆ)
        jobGroupId = ownJobGroupId;
      }

      await CalendarEvent.updateMany(
        { _id: { $in: eventIds } },
        {
          $set: {
            contractGroupId,
            contractNo: contractHead.contractNo,
            quotationNo: contractHead.quotationNo,
            contractStart: contractHead.contractStart,
            contractEnd: contractHead.contractEnd,
            visitCount: contractHead.visitCount,
            jobValue: contractHead.jobValue,
            time: String(time),
            ...(jobGroupId ? { jobGroupId } : {}),
          },
        }
      );
      const updated = await CalendarEvent.find({ _id: { $in: eventIds } });

      res.json({ events: updated });
    } catch (error) {
      console.error("❌ Error attaching event to contract:", error);
      res.status(500).send("Internal Server Error");
    }
  });

  // ✅ แยกครั้งที่ N ออกจากสัญญา กลับไปเป็น "งานทั่วไป" เดี่ยวๆ (ใช้แก้ไขกรณีจัดกลุ่มผิด — สร้าง/ต่อเป็น
  // ครั้งหนึ่งของสัญญาไปแล้วทั้งที่จริงไม่ควรผูกกับสัญญานี้) — ทำงานกับ "ทั้งครั้ง" (ทุก record ที่แชร์
  // contractGroupId+time เดียวกัน) ไม่ใช่แค่ record เดียว เพราะครั้งที่เข้างานไม่ต่อเนื่องมีได้หลาย record
  // ต่อ 1 ครั้ง — jobGroupId (ตัวผูกวันที่ไม่ต่อเนื่องของงานเดียวกัน) ไม่ถูกแตะ ยังกลุ่มเดียวกันเหมือนเดิม
  router.put("/contract/:contractGroupId/detach", verifyToken, async (req, res) => {
    try {
      if (!can(req.user, "editContracts")) {
        return res.status(403).json({ message: "เฉพาะแอดมิน/manager เท่านั้นที่แยกงานออกจากสัญญาได้" });
      }
      const { contractGroupId } = req.params;
      const { time } = req.body;
      if (time === undefined || time === null || time === "") {
        return res.status(400).json({ message: "กรุณาระบุครั้งที่ที่ต้องการแยกออก" });
      }

      const result = await CalendarEvent.updateMany(
        { contractGroupId, time: String(time) },
        {
          $unset: {
            contractGroupId: "",
            contractNo: "",
            quotationNo: "",
            contractStart: "",
            contractEnd: "",
            visitCount: "",
            jobValue: "",
          },
        }
      );
      if (result.matchedCount === 0) {
        return res.status(404).json({ message: "ไม่พบครั้งที่นี้ในสัญญา" });
      }

      res.json({ success: true, modifiedCount: result.modifiedCount });
    } catch (error) {
      console.error("❌ Error detaching round from contract:", error);
      res.status(500).send("Internal Server Error");
    }
  });

  // ✅ ย้าย "ครั้งที่ N" ไปเป็นครั้งที่อื่นในสัญญาเดียวกัน — ย้ายยกทั้งครั้ง (ทุก document ของครั้งนั้น
  // พร้อมกัน: วันที่/สถานะ/ทีม/ประวัติงานทั้งหมดติดไปด้วยครบ ไม่ได้ย้ายแค่ตัวเลข) ใช้แก้กรณีลงครั้งผิดลำดับ
  // หรืองานเลื่อน/สลับรอบกัน ซึ่งเกิดขึ้นประจำในงานจริง
  // ⚠️ ถ้าปลายทางมีครั้งอยู่แล้ว = "สลับที่กัน" (swap) ไม่ใช่เขียนทับ — ข้อมูลของทั้งสองครั้งต้องอยู่ครบ
  // เสมอ ห้ามมีทางที่กดผิดแล้วข้อมูลหายถาวรโดยไม่มีอะไรเตือน
  router.put("/contract/:contractGroupId/move-round", verifyToken, async (req, res) => {
    try {
      const { contractGroupId } = req.params;
      const { fromTime, toTime } = req.body;
      if (fromTime === undefined || fromTime === null || fromTime === "" ||
          toTime === undefined || toTime === null || toTime === "") {
        return res.status(400).json({ message: "กรุณาระบุครั้งที่ต้นทางและปลายทาง" });
      }
      const from = Number(fromTime);
      const to = Number(toTime);
      if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < 1 || to > MAX_VISIT_COUNT) {
        return res.status(400).json({ message: `ครั้งที่ต้องเป็นจำนวนเต็มระหว่าง 1-${MAX_VISIT_COUNT}` });
      }
      if (from === to) {
        return res.status(400).json({ message: "ครั้งที่ต้นทางและปลายทางเป็นครั้งเดียวกัน" });
      }

      // ✅ นอกจาก admin/manager แล้ว "ผู้รับผิดชอบที่ได้รับมอบหมาย" ของสัญญานี้ย้ายครั้งที่เองได้ด้วย
      // (ตามสโคปที่ผู้ใช้ระบุ: หน้าภาพรวมงาน งานสัญญา → เฉพาะผู้รับผิดชอบที่ได้รับมอบหมายเห็นและแก้
      // ในส่วนครั้งที่ได้) เดิมเฉพาะ admin/manager ทำให้ช่างที่ดูแลสัญญาอยู่เองแก้กรณีลงครั้งผิดลำดับ
      // ไม่ได้เลย ต้องรอแอดมินทุกครั้ง ทั้งที่เป็นงานที่ตัวเองรับผิดชอบ
      // ⚠️ ต้องเป็นผู้รับผิดชอบของ "ทุก document ในสัญญา" ไม่ใช่แค่ครั้งที่กำลังย้าย — การย้ายครั้งจะไป
      // สลับที่กับครั้งปลายทางด้วย จึงกระทบโครงสร้างทั้งสัญญา
      // ⚠️ ไม่รับ "ทีมที่เข้างาน" (team/resPerson/teamMembers) โดยตั้งใจ — ต้องถูกมอบหมายเป็น
      // ผู้รับผิดชอบไว้ชัดเจนก่อนเท่านั้น ตรงกับตัวกรองการมองเห็นของหน้านั้น (strictResponsibleOrClauses)
      if (!can(req.user, "editContracts")) {
        const contractDocs = await CalendarEvent.find({ contractGroupId })
          .select("responsiblePerson responsiblePersonId").lean();
        if (contractDocs.length === 0) {
          return res.status(404).json({ message: "ไม่พบสัญญานี้" });
        }
        const uid = String(req.userId);
        const isContractResponsible = contractDocs.every(
          (d) => (d.responsiblePersonId && d.responsiblePersonId === uid) ||
                 (d.responsiblePerson && d.responsiblePerson === req.user.fname)
        );
        if (!isContractResponsible) {
          return res.status(403).json({ message: "ย้ายครั้งที่ได้เฉพาะแอดมิน/manager หรือผู้รับผิดชอบสัญญานี้เท่านั้น" });
        }
      }

      // ✅ เก็บ _id ไว้ล่วงหน้าทั้งสองฝั่งก่อนเริ่มแก้ไข — สำคัญมาก เพราะหลังอัปเดตขั้นแรก ค่า time จะซ้ำกัน
      // ชั่วขณะ (ทั้งต้นทางและปลายทางเป็นเลขเดียวกัน) ถ้าขั้นที่สองไปค้นด้วย time อีกทีจะจับได้ทั้งสองก้อน
      // ปนกันจนสลับผิด — อ้างอิงด้วย _id ที่จับไว้ตั้งแต่ต้นเท่านั้นจึงจะแม่นยำเสมอ
      const [sourceDocs, targetDocs] = await Promise.all([
        CalendarEvent.find({ contractGroupId, time: String(from) }).select("_id").lean(),
        CalendarEvent.find({ contractGroupId, time: String(to) }).select("_id").lean(),
      ]);
      if (sourceDocs.length === 0) {
        return res.status(404).json({ message: `ไม่พบครั้งที่ ${from} ในสัญญานี้` });
      }
      const sourceIds = sourceDocs.map((d) => d._id);
      const targetIds = targetDocs.map((d) => d._id);

      await CalendarEvent.updateMany({ _id: { $in: sourceIds } }, { $set: { time: String(to) } });
      if (targetIds.length > 0) {
        await CalendarEvent.updateMany({ _id: { $in: targetIds } }, { $set: { time: String(from) } });
      }

      res.json({
        success: true,
        swapped: targetIds.length > 0,
        movedCount: sourceIds.length,
        swappedCount: targetIds.length,
      });
    } catch (error) {
      console.error("❌ Error moving contract round:", error);
      res.status(500).send("Internal Server Error");
    }
  });

  // ✅ แก้ไขข้อมูลสัญญา (contractNo/quotationNo/contractStart/contractEnd/visitCount/jobValue) พร้อมกัน
  // ทุก "ครั้ง" ที่อยู่ในสัญญาเดียวกัน (ผูกด้วย contractGroupId) — กันข้อมูลสัญญาเพี้ยนไม่ตรงกันระหว่าง
  // ครั้งที่ 1-4 ถ้าแก้ทีละ record ผ่าน PUT /:id ธรรมดาซึ่งกระทบแค่ record เดียว
  // (path มี "contract" คั่นเป็นอีก segment จึงไม่ชนกับ "/:id" แม้จะประกาศก่อนหรือหลังก็ได้)
  router.put("/contract/:contractGroupId", verifyToken, async (req, res) => {
    try {
      const { contractGroupId } = req.params;
      const events = await CalendarEvent.find({ contractGroupId });
      if (events.length === 0) {
        return res.status(404).json({ message: "ไม่พบสัญญานี้" });
      }

      // ✅ ข้อมูลสัญญา (เลขที่สัญญา/ใบเสนอราคา/วันที่/จำนวนครั้ง/มูลค่างาน) เป็นข้อมูลเชิงบริหาร/การเงิน
      // เฉพาะแอดมิน/manager เท่านั้นที่แก้ได้ — ไม่ใช้เกณฑ์เจ้าของ/ผู้ได้รับมอบหมายเหมือน route อื่นๆ ใน
      // ไฟล์นี้ เพราะที่นี่แก้ "ทั้งสัญญา" พร้อมกันทุกครั้ง (updateMany ด้านล่าง) ผิดพลาดแล้วกระทบทุกครั้ง
      // ที่ผูกสัญญาเดียวกันทันที ต่างจากแก้ไขงานรายครั้งปกติที่กระทบแค่ record เดียว (ดู EditEvent.js
      // ที่ตอนนี้แสดงข้อมูลสัญญาแบบดูอย่างเดียว/disabled ให้ช่างแล้วเช่นกัน)
      const isAdminOrManager = can(req.user, "editContracts");
      if (!isAdminOrManager) {
        return res.status(403).json({ message: "คุณไม่มีสิทธิ์แก้ไขข้อมูลสัญญานี้" });
      }

      // ✅ team/resPerson (ทีมที่เข้างาน) และ responsiblePerson/responsiblePersonId (ผู้รับผิดชอบ —
      // คนละแนวคิดกัน ดูคอมเมนต์ที่ schema) เพิ่มเข้ามาให้แก้ผ่านทั้งสัญญาพร้อมกันทุกครั้งเหมือนฟิลด์
      // สัญญาอื่นๆ ด้านล่าง (เดิม route นี้แก้ได้แค่ข้อมูลสัญญา ไม่รวมสองอย่างนี้ ซึ่งจริงๆ ก็ควรผูกกับ
      // สัญญาทั้งก้อนเหมือนกัน ไม่ใช่รายครั้ง — ดูหน้า "ภาพรวมสัญญา" ที่แก้ inline ผ่านตารางได้เลย)
      const {
        contractNo, quotationNo, contractStart, contractEnd, visitCount, intervalMonths, jobValue, commission,
        team, resPerson, responsiblePerson, responsiblePersonId,
      } = req.body;

      // ✅ ห้ามเลขที่สัญญาซ้ำกับสัญญาอื่น — excludeContractGroupId เป็นตัวเอง เพราะทุกครั้งในสัญญานี้
      // มี contractNo เดิมอยู่แล้วโดยตั้งใจ (ไม่ถือว่าซ้ำ)
      if (contractNo !== undefined) {
        const dupContractNo = await findDuplicateContractNo(contractNo, contractGroupId);
        if (dupContractNo) {
          return res.status(409).json({ message: `เลขที่สัญญา "${contractNo}" ถูกใช้ไปแล้ว กรุณาตรวจสอบ` });
        }
      }

      if (intervalMonths !== undefined && intervalMonths !== "" && intervalMonths !== null) {
        const n = Number(intervalMonths);
        if (!n || n < 1 || n > 24) {
          return res.status(400).json({ message: "ระยะห่างระหว่างรอบต้องอยู่ระหว่าง 1-24 เดือน" });
        }
      }

      const update = {};
      if (contractNo !== undefined) update.contractNo = contractNo;
      if (quotationNo !== undefined) update.quotationNo = quotationNo;
      if (contractStart !== undefined) update.contractStart = contractStart;
      if (contractEnd !== undefined) update.contractEnd = contractEnd;
      // ✅ ระยะห่างระหว่างรอบ — ใช้เป็นข้อมูลอ้างอิงสำหรับเตือน "เกินกำหนดรอบถัดไป" เท่านั้น (ดู
      // checkAndNotifyOverdueContracts/nextVisitOverdueInfo) ไม่ผูก/คำนวณทับ visitCount ให้เอง เพราะ
      // งานจริงเลื่อน/ชนกันได้เสมอ จำนวนครั้งจริงต้องให้ผู้ใช้เป็นคนกำหนดเองเท่านั้น
      if (intervalMonths !== undefined) update.intervalMonths = intervalMonths;
      if (visitCount !== undefined) {
        // ✅ ห้ามใส่จำนวนครั้งทั้งหมดเกิน 12 — ป้องกันไม่ให้ตาราง "ภาพรวมงาน" ต้องเรนเดอร์คอลัมน์
        // "ครั้งที่ N" เกินจำเป็น (maxVisitCount ในหน้านั้นคำนวณจากค่าสูงสุดของทุกแถวที่กรองอยู่ ถ้ามี
        // สัญญาไหนตั้งไว้สูงมากๆ ตารางทั้งหน้าจะกว้างจนพังไปด้วย) เทียบ pattern เดียวกับ intervalMonths
        // ด้านบนที่ backend เช็คซ้ำอีกชั้นเสมอ ไม่พึ่งฝั่งจอเช็คอย่างเดียว
        if (Number(visitCount) > 12) {
          return res.status(400).json({ message: "จำนวนครั้งทั้งหมดต้องไม่เกิน 12 ครั้ง" });
        }
        // ✅ ห้ามลดจำนวนครั้งต่ำกว่าที่ลงตารางจริงไปแล้ว — ไม่งั้นครั้งที่เกินจะโดนคอลัมน์ "ครั้งที่ N"
        // ในหน้าภาพรวมสัญญาตัดทิ้งจากที่แสดงผลไปเลยทั้งที่ข้อมูลยังอยู่จริงในฐานข้อมูล (ข้อมูลไม่ตรงจอ)
        // ⚠️ BUG ที่แก้: เดิมนับด้วย countDocuments (จำนวน record ดิบ) — ครั้งที่เข้างานไม่ต่อเนื่อง (เว้น
        // ช่วงแล้วกลับมาเข้าอีก) มีหลาย record ต่อ 1 "ครั้งที่" ทำให้นับเกินจริงมาก (เช่น 3 ครั้งจริง แต่มี
        // 7 record เพราะบางครั้งเข้าหลายวันไม่ติดกัน) ทำให้ปฏิเสธการบันทึกทั้งที่ visitCount ไม่ได้ลดจริง
        // เลย (แค่แก้ไขงานอื่นในสัญญาแล้ว EditEvent.js ส่ง visitCount เดิมกลับมาด้วยทุกครั้ง) — ต้องนับ
        // "จำนวนครั้งที่ไม่ซ้ำกัน" (distinct time) เหมือน countUsedRounds ฝั่ง frontend แทน
        const scheduledEvents = await CalendarEvent.find({ contractGroupId, unscheduled: { $ne: true } })
          .select("time")
          .lean();
        const usedRounds = new Set(
          scheduledEvents
            .map((e) => e.time)
            .filter((t) => t !== undefined && t !== null && t !== "")
            .map(String)
        );
        const realCount = usedRounds.size;
        if (Number(visitCount) < realCount) {
          return res.status(409).json({
            message: `ลดจำนวนครั้งต่ำกว่า ${realCount} ไม่ได้ เพราะมีงานลงตารางแล้ว ${realCount} ครั้ง`,
          });
        }
        update.visitCount = visitCount;
      }
      if (jobValue !== undefined) update.jobValue = jobValue;
      // ⚠️ ห้ามติดลบ — ค่าคอมติดลบไม่มีความหมาย และจะไปทำให้ยอดรวมท้ายตารางเพี้ยนแบบหาสาเหตุยาก
      if (commission !== undefined) {
        if (commission !== "" && commission !== null && Number(commission) < 0) {
          return res.status(400).json({ message: "ค่าคอมมิชชั่นต้องไม่ติดลบ" });
        }
        update.commission = commission;
      }
      if (team !== undefined) update.team = team;
      if (resPerson !== undefined) update.resPerson = resPerson;
      if (responsiblePerson !== undefined) update.responsiblePerson = responsiblePerson;
      if (responsiblePersonId !== undefined) update.responsiblePersonId = responsiblePersonId;

      // ✅ บันทึกร่องรอยการแก้ไขข้อมูลสัญญา (ใคร แก้อะไร จากค่าอะไรเป็นค่าอะไร เมื่อไหร่)
      // ⚠️ route นี้ updateMany ทับ "ทุกครั้งในสัญญา" พร้อมกัน และหน้าภาพรวมงานแก้ inline ได้จากตาราง
      // โดยตรง — คลิกพลาดช่องเดียวก็เปลี่ยนมูลค่างาน/เลขที่สัญญา/วันหมดอายุทั้งสัญญาทันที เดิมไม่มีทาง
      // ตามกลับได้เลยว่าใครแก้หรือค่าเดิมคืออะไร ต้องเดาจากความจำล้วนๆ
      // ⚠️ ต้องเทียบค่า "ก่อน" อัปเดตเท่านั้น — อ่านหลัง updateMany จะได้ค่าใหม่ทั้งคู่แล้วเทียบไม่เจอ
      // อะไรเลย เอกสารตัวแทนใช้ events[0] ได้เพราะทุกครั้งในสัญญาถือค่าฟิลด์สัญญาชุดเดียวกันเสมอ
      const changes = diffContractFields(events[0], update);
      const logEntry = changes.length > 0
        ? {
          action: "contract_updated",
          // เก็บเป็นข้อความอ่านออกเลย ไม่ต้องแปลรหัสฟิลด์ตอนแสดงผล และไม่ผูกกับโครงสร้างฝั่งจอ
          detail: changes.map((c) => `${c.label}: ${c.from} → ${c.to}`).join(" · "),
          userId: String(req.user?._id || req.userId || ""),
          userName: req.user?.username || req.user?.name || "ไม่ทราบชื่อ",
          timestamp: new Date(),
        }
        : null;

      // ⚠️ ไม่มีอะไรเปลี่ยนจริงก็ไม่ต้อง log — หน้าภาพรวมงานส่งค่าทั้งชุดกลับมาทุกครั้งที่กดบันทึก
      // (แม้แก้ช่องเดียว) ถ้า log ทุกครั้งที่เรียก ไทม์ไลน์จะเต็มไปด้วยรายการ "ไม่ได้แก้อะไร" จนใช้ไม่ได้
      await CalendarEvent.updateMany(
        { contractGroupId },
        logEntry ? { $set: update, $push: { activityLog: logEntry } } : { $set: update },
      );
      const updatedEvents = await CalendarEvent.find({ contractGroupId }).lean();
      res.json({ events: updatedEvents });
    } catch (error) {
      console.error("❌ Error updating contract fields:", error);
      res.status(500).send("Internal Server Error");
    }
  });

  // ✅ ลบสัญญาทั้งก้อน (ทุกครั้งที่ผูก contractGroupId เดียวกัน) ในคำสั่งเดียว — เดิมมีแค่ DELETE /:id
  // ที่ลบได้ทีละ event เท่านั้น ไม่มีทางลบสัญญาทั้งสัญญาได้จากหน้า "ภาพรวมสัญญา" เลย ต้องไล่ลบทีละครั้ง
  // path นี้ยาว 2 segment ("contract" + id) ต่างจาก DELETE /:id (1 segment) จึงไม่ชนกันไม่ว่าจะประกาศ
  // ก่อน/หลัง (ไม่เหมือนกรณี PUT /contract/merge vs PUT /contract/:contractGroupId ที่ต้องระวังลำดับ)
  router.delete("/contract/:contractGroupId", verifyToken, async (req, res) => {
    try {
      if (!can(req.user, "editContracts")) {
        return res.status(403).json({ message: "เฉพาะแอดมิน/manager เท่านั้นที่ลบสัญญาได้" });
      }
      const { contractGroupId } = req.params;
      const result = await CalendarEvent.deleteMany({ contractGroupId });
      if (result.deletedCount === 0) {
        return res.status(404).json({ message: "ไม่พบสัญญานี้" });
      }
      res.json({ deletedCount: result.deletedCount });
    } catch (error) {
      console.error("❌ Error deleting contract:", error);
      res.status(500).send("Internal Server Error");
    }
  });
};
