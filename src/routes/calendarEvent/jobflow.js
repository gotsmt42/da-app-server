/**
 * ขั้นตอนทำงานมาตรฐาน (9 ต.ค. 2569) — ส่วนที่ระบบเดิมยังขาด
 *   ขั้น 2  เปิด Job: ความเร่งด่วน · วันครบกำหนด · รอข้อมูล · อุปกรณ์   → pickJobInfo (ใช้ใน POST/PUT ของ core.js)
 *   ขั้น 4  ช่างกด "รับทราบงาน" (ไม่เปลี่ยนสถานะ — คำว่า "รับงาน" ใช้กับการรับงานจากลูกค้า)                    → PUT /:id/ack
 *   ขั้น 5  งานไม่เสร็จ: สาเหตุ · ผู้รับผิดชอบต่อ · วันนัดที่เสนอ             → PUT /:id/follow-up
 *          แอดมินลงตารางเองแล้วกด "จัดการแล้ว"                              → PUT /:id/follow-up/resolve
 * ⚠️ ทุกอย่างเป็นของ "ทั้งงาน" — งานหลายวัน (jobGroupId เดียวกัน) อัปเดตทุกวันพร้อมกัน
 */
const { CalendarEvent, verifyToken, can, sendPushToUsers, sendPushToRoles, SUPERVISOR_ROLES } = require("./shared");
const { effectiveCapabilities } = require("../../config/roles");

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
      if (!isParticipant(ev, req.user, req.userId) && !can(req.user, "editAnyJob")) {
        return res.status(403).json({ message: "รับทราบงานได้เฉพาะช่างที่ได้รับมอบหมาย" });
      }
      const uid = String(req.userId);
      const name = personName(req.user);
      const docs = await CalendarEvent.find(groupFilter(ev));
      await Promise.all(docs.map((d) => {
        if ((d.acks || []).some((a) => String(a.userId) === uid)) return null;
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
