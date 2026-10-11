/**
 * ขั้นตอนทำงานมาตรฐาน (9 ต.ค. 2569) — ส่วนที่ระบบเดิมยังขาด
 *   ขั้น 2  เปิด Job: ความเร่งด่วน · วันครบกำหนด · รอข้อมูล · อุปกรณ์   → pickJobInfo (ใช้ใน POST/PUT ของ core.js)
 *   ขั้น 4  ช่างกด "รับทราบงาน" (ไม่เปลี่ยนสถานะ — คำว่า "รับงาน" ใช้กับการรับงานจากลูกค้า)                    → PUT /:id/ack
 *          หรือ "ปฏิเสธงาน" พร้อมเหตุผล (11 ต.ค. 2569) → แจ้งผู้จัดคิว/ผู้รับผิดชอบ ให้มอบหมายใหม่          → PUT /:id/ack-decline
 *   ขั้น 5  งานไม่เสร็จ: สาเหตุ · ผู้รับผิดชอบต่อ · วันนัดที่เสนอ             → PUT /:id/follow-up
 *          แอดมินลงตารางเองแล้วกด "จัดการแล้ว"                              → PUT /:id/follow-up/resolve
 * ⚠️ ทุกอย่างเป็นของ "ทั้งงาน" — งานหลายวัน (jobGroupId เดียวกัน) อัปเดตทุกวันพร้อมกัน
 */
const { CalendarEvent, verifyToken, can, sendPushToUsers, sendPushToRoles, SUPERVISOR_ROLES } = require("./shared");
const { effectiveCapabilities } = require("../../config/roles");

/** ✅ การ "รับทราบงาน" เริ่มใช้ 9 ต.ค. 2569 — งานที่สร้างก่อนหน้านี้ไม่ถูกนับว่า "ยังไม่รับทราบ" */
const ACK_TRACK_SINCE = new Date("2026-10-08T17:00:00.000Z");

const FOLLOW_UP_REASONS = ["รออะไหล่", "รอลูกค้าอนุมัติ", "เข้าซ่อมไม่สำเร็จ", "ลูกค้าไม่สะดวก", "อื่นๆ"];

const toDate = (v) => {
  if (v === null || v === "") return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d;
};

/** คัดเฉพาะฟิลด์ข้อมูลงานที่ส่งมา + ตรวจค่า — ไม่ได้ส่งมา = ไม่แตะ */
function pickJobInfo(body = {}) {
  const out = {};
  if (body.priority !== undefined) out.priority = body.priority === "urgent" ? "urgent" : "normal";
  if (body.dueDate !== undefined) {
    const d = toDate(body.dueDate);
    if (d !== undefined) out.dueDate = d;
  }
  if (body.infoPending !== undefined) out.infoPending = Boolean(body.infoPending);
  if (body.infoPendingNote !== undefined) out.infoPendingNote = String(body.infoPendingNote || "").slice(0, 500);
  if (body.equipment !== undefined) out.equipment = String(body.equipment || "").slice(0, 2000);
  return out;
}

const personName = (u) => [u?.fname, u?.lname].filter(Boolean).join(" ") || u?.username || "ผู้ใช้";
const groupFilter = (ev) => (ev.jobGroupId ? { jobGroupId: ev.jobGroupId } : { _id: ev._id });

const isParticipant = (ev, user, userId) => {
  const uid = String(userId || "");
  const fname = user?.fname || "";
  return (
    (ev.resPerson && String(ev.resPerson) === uid) ||
    (ev.responsiblePersonId && String(ev.responsiblePersonId) === uid) ||
    (fname && (ev.team === fname || ev.responsiblePerson === fname)) ||
    (ev.teamMembers || []).some((m) => (m?.userId && String(m.userId) === uid) || (fname && m?.name === fname))
  );
};

/**
 * ✅ (11 ต.ค. 2569 ผู้ใช้ — ขั้นตอนใหม่)
 *    "แอดมินลงงาน → มอบหมายผู้รับผิดชอบ → ขึ้นในหน้างานของฉัน กดรับทราบงาน → ยืนยันนัดหมาย
 *     หัวหน้าทีมช่าง หลังจากผู้รับผิดชอบยืนยันนัดหมาย กดบันทึกเข้างาน
 *     ขั้นตอนอื่นๆ ผู้รับผิดชอบ และหัวหน้าทีม หรือแอดมิน ดำเนินต่อได้"
 *    รับทราบ/ปฏิเสธ/ยืนยันนัดหมาย = ผู้รับผิดชอบงาน (ถ้ายังไม่มอบหมายผู้รับผิดชอบ → หัวหน้าทีมเข้างานแทน)
 */
const isResponsibleOf = (ev, user, userId) => {
  const uid = String(userId || "");
  const fname = user?.fname || "";
  return Boolean((ev.responsiblePersonId && String(ev.responsiblePersonId) === uid) || (fname && ev.responsiblePerson === fname));
};
const isHeadOf = (ev, user, userId) => {
  const uid = String(userId || "");
  const fname = user?.fname || "";
  return Boolean((ev.resPerson && String(ev.resPerson) === uid) || (fname && ev.team === fname));
};
const hasResponsible = (ev) => Boolean(ev.responsiblePersonId || ev.responsiblePerson);
/** คนที่กดรับทราบ/ปฏิเสธ/ยืนยันนัดหมายได้ */
const isHeadOrResponsible = (ev, user, userId) =>
  hasResponsible(ev) ? isResponsibleOf(ev, user, userId) : isHeadOf(ev, user, userId);

/** ปิดเรื่อง "งานไม่เสร็จ" ที่ค้างอยู่ทั้งงาน */
async function resolveFollowUps(ev, byName, resolution) {
  const docs = await CalendarEvent.find(groupFilter(ev));
  await Promise.all(docs.map((d) => {
    let touched = false;
    (d.followUps || []).forEach((f) => {
      if (!f.resolvedAt) { f.resolvedAt = new Date(); f.resolvedBy = byName; f.resolution = resolution || ""; touched = true; }
    });
    if (!touched && !d.followUpOpen) return null;
    d.followUpOpen = false;
    return d.save();
  }));
}

const jobLabelOf = (ev) => `${ev.title || "งาน"} · ${ev.site || ev.company || "-"}${ev.jobNo ? ` (${ev.jobNo})` : ""}`;

function registerJobflow(router) {
  // ── ขั้น 4: ช่างกด "รับทราบงาน" ─────────────────────────────────────────────
  router.put("/:id/ack", verifyToken, async (req, res) => {
    try {
      const ev = await CalendarEvent.findById(req.params.id);
      if (!ev) return res.status(404).json({ message: "ไม่พบงาน" });
      if (!isHeadOrResponsible(ev, req.user, req.userId)) {
        return res.status(403).json({ message: "รับทราบงานได้เฉพาะผู้รับผิดชอบงาน" });
      }
      const uid = String(req.userId);
      const name = personName(req.user);
      const docs = await CalendarEvent.find(groupFilter(ev));
      await Promise.all(docs.map((d) => {
        // รับทราบ = ล้างเรื่อง "ปฏิเสธงาน" ที่ค้างอยู่ (เช่น ปฏิเสธแล้วเปลี่ยนใจ หรือคนใหม่รับแทน)
        if (d.ackDeclined) d.ackDeclined = null;
        if ((d.acks || []).some((a) => String(a.userId) === uid)) return d.isModified() ? d.save() : null;
        d.acks.push({ userId: uid, name, at: new Date() });
        d.activityLog.push({ userId: uid, userName: name, action: "job_ack", timestamp: new Date(), detail: "รับทราบงานแล้ว" });
        return d.save();
      }));
      const events = await CalendarEvent.find(groupFilter(ev)).select("-activityLog").lean();
      res.json({ events });
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: "รับทราบงานไม่สำเร็จ" });
    }
  });

  // ── ขั้น 4 (ทางเลือก): ช่าง "ปฏิเสธงาน" พร้อมเหตุผล ─────────────────────────────
  // ✅ (11 ต.ค. 2569 ผู้ใช้: "การรับทราบงานของช่างให้กดปฏิเสธได้ โดยกรอกเหตุผลมาด้วย")
  //    ไม่เปลี่ยนสถานะ/ไม่ถอดชื่อออกเอง — แจ้งผู้จัดคิว + ผู้รับผิดชอบ ให้ตัดสินใจมอบหมายใหม่
  //    ป้าย "ปฏิเสธงาน" หายเองเมื่อมีคนรับทราบ หรือมอบหมายหัวหน้าทีม/ผู้รับผิดชอบคนใหม่ (ดู clearAckDecline)
  router.put("/:id/ack-decline", verifyToken, async (req, res) => {
    try {
      const ev = await CalendarEvent.findById(req.params.id);
      if (!ev) return res.status(404).json({ message: "ไม่พบงาน" });
      if (!isHeadOrResponsible(ev, req.user, req.userId)) {
        return res.status(403).json({ message: "ปฏิเสธงานได้เฉพาะผู้รับผิดชอบงาน" });
      }
      if (ev.status === "ดำเนินการเสร็จสิ้น" || ev.closeRequested) return res.status(400).json({ message: "งานนี้ขอปิด/ปิดแล้ว" });
      if (ev.checkedInAt) return res.status(400).json({ message: "งานนี้กดเข้างานแล้ว — แจ้งแอดมินทางคุยกับแอดมินแทน" });
      const reason = String(req.body.reason || "").trim().slice(0, 500);
      if (!reason) return res.status(400).json({ message: "กรุณาระบุเหตุผลที่ปฏิเสธงาน" });

      const uid = String(req.userId);
      const name = personName(req.user);
      const entry = { userId: uid, name, reason, at: new Date() };
      const docs = await CalendarEvent.find(groupFilter(ev));
      await Promise.all(docs.map((d) => {
        d.acks = (d.acks || []).filter((a) => String(a.userId) !== uid); // เคยกดรับทราบไว้ → ถอนออก
        d.ackDeclines.push(entry);
        d.ackDeclined = entry;
        d.activityLog.push({ userId: uid, userName: name, action: "job_declined", timestamp: entry.at, detail: `ปฏิเสธงาน: ${reason}` });
        return d.save();
      }));

      const ranks = effectiveCapabilities().assignDispatch || SUPERVISOR_ROLES;
      const push = {
        title: `🚫 ${name} ปฏิเสธงาน`,
        body: `${jobLabelOf(ev)} · เหตุผล: ${reason}`,
        url: `/operation/${ev._id}`,
        tag: `ack-decline-${ev.jobGroupId || ev._id}`,
        renotify: true,
      };
      sendPushToRoles(ranks, push).catch((e) => console.error("❌ push ack-decline:", e.message));
      const extra = [ev.responsiblePersonId, ev.userId].filter((x) => x && String(x) !== uid);
      if (extra.length) sendPushToUsers([...new Set(extra.map(String))], push).catch(() => {});

      const events = await CalendarEvent.find(groupFilter(ev)).select("-activityLog").lean();
      res.json({ events });
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: "บันทึกไม่สำเร็จ" });
    }
  });

  // ── ยืนยันนัดหมาย (ต่อจากรับทราบ) — ผู้รับผิดชอบงาน หรือแอดมินกดแทน ───────────────
  // ✅ (11 ต.ค. 2569) สถานะงาน → "ยืนยันแล้ว" (ตัวเดียวกับในปฏิทิน) ทั้งกลุ่ม · บันทึกผู้ดำเนินการ · แจ้งหัวหน้าทีมให้บันทึกเข้างาน
  router.put("/:id/confirm", verifyToken, async (req, res) => {
    try {
      const ev = await CalendarEvent.findById(req.params.id);
      if (!ev) return res.status(404).json({ message: "ไม่พบงาน" });
      if (!isHeadOrResponsible(ev, req.user, req.userId) && !can(req.user, "editAnyJob")) {
        return res.status(403).json({ message: "ยืนยันนัดหมายได้เฉพาะผู้รับผิดชอบงาน (หรือแอดมิน)" });
      }
      if (["pending", "rejected"].includes(ev.approvalStatus)) return res.status(400).json({ message: "งานนี้ยังไม่ได้รับอนุมัติ" });
      if (ev.status !== "กำลังรอยืนยัน") return res.status(400).json({ message: `งานนี้สถานะ "${ev.status}" แล้ว` });
      if (!(ev.acks || []).length) return res.status(400).json({ message: "ต้องกดรับทราบงานก่อน จึงยืนยันนัดหมายได้" });

      const uid = String(req.userId);
      const name = personName(req.user);
      const at = new Date();
      const docs = await CalendarEvent.find({ ...groupFilter(ev), status: "กำลังรอยืนยัน" });
      await Promise.all(docs.map((d) => {
        d.status = "ยืนยันแล้ว";
        d.manualStatus = true;
        d.confirmedAt = at;
        d.activityLog.push({ userId: uid, userName: name, action: "job_confirmed", timestamp: at, detail: "ยืนยันนัดหมายแล้ว" });
        return d.save();
      }));

      if (ev.resPerson && String(ev.resPerson) !== uid) {
        const day = ev.start ? new Date(ev.start).toLocaleDateString("th-TH", { timeZone: "Asia/Bangkok", day: "numeric", month: "short" }) : "-";
        sendPushToUsers(String(ev.resPerson), {
          title: `✅ ${name} ยืนยันนัดหมายแล้ว`,
          body: `${jobLabelOf(ev)} · เข้างาน ${day} — ถึงวันแล้วกด "บันทึกเข้างาน"`,
          url: await require("../../services/jobAudit").jobUrlFor(ev.resPerson, ev._id),
          tag: `confirm-${ev.jobGroupId || ev._id}`,
          renotify: true,
        }).catch(() => {});
      }
      const events = await CalendarEvent.find(groupFilter(ev)).select("-activityLog").lean();
      res.json({ events });
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: "ยืนยันนัดหมายไม่สำเร็จ" });
    }
  });

  // ── ขั้น 5: แจ้ง "งานไม่เสร็จ / ต้องนัดใหม่" ──────────────────────────────
  router.put("/:id/follow-up", verifyToken, async (req, res) => {
    try {
      const ev = await CalendarEvent.findById(req.params.id);
      if (!ev) return res.status(404).json({ message: "ไม่พบงาน" });
      if (!isParticipant(ev, req.user, req.userId) && !can(req.user, "editAnyJob")) {
        return res.status(403).json({ message: "แจ้งได้เฉพาะผู้ที่ได้รับมอบหมายงานนี้" });
      }
      if (ev.status === "ดำเนินการเสร็จสิ้น") return res.status(400).json({ message: "งานนี้ปิดแล้ว" });
      const reason = FOLLOW_UP_REASONS.includes(req.body.reason) ? req.body.reason : "";
      const note = String(req.body.note || "").trim().slice(0, 1000);
      const nextOwner = String(req.body.nextOwner || "").trim().slice(0, 100);
      if (!reason) return res.status(400).json({ message: "กรุณาเลือกสาเหตุ" });
      if (reason === "อื่นๆ" && !note) return res.status(400).json({ message: "กรุณาระบุรายละเอียด" });
      if (!nextOwner) return res.status(400).json({ message: "กรุณาเลือกผู้รับผิดชอบขั้นตอนถัดไป" });
      const proposedDate = toDate(req.body.proposedDate) || null;

      const uid = String(req.userId);
      const name = personName(req.user);
      const entry = { reason, note, nextOwner, proposedDate, reportedBy: name, reportedByUserId: uid, reportedAt: new Date() };
      const docs = await CalendarEvent.find(groupFilter(ev));
      await Promise.all(docs.map((d) => {
        // แจ้งใหม่ทับเรื่องเดิมที่ยังค้าง — เก็บของเดิมไว้เป็นประวัติ (ปิดว่า "แจ้งใหม่")
        (d.followUps || []).forEach((f) => { if (!f.resolvedAt) { f.resolvedAt = new Date(); f.resolvedBy = name; f.resolution = "แจ้งใหม่"; } });
        d.followUps.push(entry);
        d.followUpOpen = true;
        d.activityLog.push({
          userId: uid, userName: name, action: "follow_up", timestamp: new Date(),
          detail: `งานไม่เสร็จ: ${reason}${note ? ` — ${note}` : ""} · ต่อไป: ${nextOwner}`,
        });
        return d.save();
      }));

      // แจ้งผู้จัดคิว (สิทธิ์ assignDispatch) + ผู้รับผิดชอบงาน
      const ranks = effectiveCapabilities().assignDispatch || SUPERVISOR_ROLES;
      const push = {
        title: `⚠️ ${name} แจ้งงานไม่เสร็จ — ${reason}`,
        body: `${jobLabelOf(ev)}${proposedDate ? ` · เสนอนัดใหม่ ${proposedDate.toLocaleDateString("th-TH", { day: "numeric", month: "short" })}` : ""} · ต่อไป: ${nextOwner}`,
        url: `/operation/${ev._id}`,
        tag: `follow-up-${ev.jobGroupId || ev._id}`,
        renotify: true,
      };
      sendPushToRoles(ranks, push).catch((e) => console.error("❌ push follow-up:", e.message));
      if (ev.responsiblePersonId && String(ev.responsiblePersonId) !== uid) {
        sendPushToUsers(ev.responsiblePersonId, push).catch(() => {});
      }

      const events = await CalendarEvent.find(groupFilter(ev)).select("-activityLog").lean();
      res.json({ events });
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: "บันทึกไม่สำเร็จ" });
    }
  });

  // ── รับงาน: ยกเลิก / นำกลับมา (เฉพาะงานที่รับไว้แต่ยังไม่ลงตาราง) ─────────────────
  // ✅ (9 ต.ค. 2569 ผู้ใช้: "ให้กดยกเลิกงานได้ด้วย บางงานลงไว้ไม่ได้ลงก็มี") — บังคับเหตุผล · ไม่ลบทิ้ง
  router.put("/:id/cancel-intake", verifyToken, async (req, res) => {
    try {
      const ev = await CalendarEvent.findById(req.params.id);
      if (!ev || !ev.intakeAt) return res.status(404).json({ message: "ไม่พบงานที่รับไว้" });
      if (!ev.unscheduled) return res.status(400).json({ message: "งานนี้ลงตารางแล้ว — ยกเลิกจากหน้าตารางงานแทน" });
      const isOwner = String(ev.userId) === String(req.userId);
      if (!isOwner && !can(req.user, "editAnyJob") && !can(req.user, "assignDispatch")) {
        return res.status(403).json({ message: "ยกเลิกได้เฉพาะผู้รับงานหรือแอดมิน" });
      }
      const restore = req.body.restore === true;
      const reason = String(req.body.reason || "").trim().slice(0, 500);
      if (!restore && !reason) return res.status(400).json({ message: "กรุณาระบุเหตุผลที่ยกเลิก" });
      const name = personName(req.user);
      ev.cancelledAt = restore ? null : new Date();
      ev.cancelledBy = restore ? "" : name;
      ev.cancelReason = restore ? "" : reason;
      ev.activityLog.push({
        userId: String(req.userId), userName: name, timestamp: new Date(),
        action: restore ? "intake_restored" : "intake_cancelled",
        detail: restore ? "นำงานที่ยกเลิกกลับมา" : `ยกเลิกงาน: ${reason}`,
      });
      await ev.save();
      const out = ev.toObject();
      delete out.activityLog;
      res.json({ events: [out] });
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: "บันทึกไม่สำเร็จ" });
    }
  });

  // ── ขั้น 5 (ต่อ): แอดมินลงนัดใหม่แล้ว → จัดการแล้ว ───────────────────────────
  router.put("/:id/follow-up/resolve", verifyToken, async (req, res) => {
    try {
      if (!can(req.user, "editAnyJob") && !can(req.user, "assignDispatch")) {
        return res.status(403).json({ message: "เฉพาะแอดมิน/ผู้จัดคิว" });
      }
      const ev = await CalendarEvent.findById(req.params.id);
      if (!ev) return res.status(404).json({ message: "ไม่พบงาน" });
      const name = personName(req.user);
      const resolution = String(req.body.resolution || "ลงนัดใหม่แล้ว").slice(0, 300);
      await resolveFollowUps(ev, name, resolution);
      await CalendarEvent.updateMany(groupFilter(ev), {
        $push: { activityLog: { userId: String(req.userId), userName: name, action: "follow_up_resolved", timestamp: new Date(), detail: resolution } },
      });
      const reporter = [...(ev.followUps || [])].reverse().find((f) => f.reportedByUserId)?.reportedByUserId;
      if (reporter && reporter !== String(req.userId)) {
        sendPushToUsers(reporter, {
          title: `✅ ${name} จัดการงานที่แจ้งไม่เสร็จแล้ว`,
          body: `${jobLabelOf(ev)} · ${resolution}`,
          url: `/operation/${ev._id}`,
          tag: `follow-up-${ev.jobGroupId || ev._id}`,
        }).catch(() => {});
      }
      const events = await CalendarEvent.find(groupFilter(ev)).select("-activityLog").lean();
      res.json({ events });
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: "บันทึกไม่สำเร็จ" });
    }
  });
}

module.exports = registerJobflow;
module.exports.pickJobInfo = pickJobInfo;
module.exports.resolveFollowUps = resolveFollowUps;
module.exports.FOLLOW_UP_REASONS = FOLLOW_UP_REASONS;
module.exports.ACK_TRACK_SINCE = ACK_TRACK_SINCE;
