/**
 * การเงินของงาน — วางบิล สแกนใบวางบิล และบันทึกการรับชำระ
 *
 * แยกออกมาจาก routes/calendarEvent.js เดิมที่ยาว 2,708 บรรทัดในไฟล์เดียว (29 route)
 * ⚠️ ลำดับการประกาศ route ภายในไฟล์นี้ = ลำดับเดิม ห้ามสลับ (ดูเหตุผลที่ index.js)
 */
const {
  CalendarEvent,
  verifyToken,
  computeBillingAmounts,
  computeDueAt,
  InvoiceScan,
  isJobParticipant,
  // ✅ สำหรับแนบสลิป/ใบเสร็จตอนบันทึกรับเงิน
  upload,
  cloudinary,
  streamifier,
} = require("./shared");
const { thaiDate } = require("../../utils/thaiDate");

module.exports = (router) => {
  // ── การวางบิล / รับเงิน ────────────────────────────────────────────────────
  // ⚠️ เฉพาะแอดมิน/manager เท่านั้น — เป็นข้อมูลการเงินล้วนๆ ใช้เกณฑ์เดียวกับการแก้ข้อมูลสัญญา
  // ไม่ใช้เกณฑ์ "เจ้าของงาน" เหมือน route อื่นในไฟล์นี้
  /**
   * ✅ สิทธิ์จัดการข้อมูลการเงินของ "งานหนึ่งงาน" — แอดมิน/manager ทำได้ทุกงาน ส่วนคนอื่นทำได้เฉพาะ
   * งานที่ตัวเองมีชื่ออยู่ (ผู้ลงงาน/ผู้รับผิดชอบ/หัวหน้าทีม/ลูกทีม) ตามที่ผู้ใช้ระบุ
   *
   * 🐛 ที่แก้: เดิมเป็น requireFinanceRole ที่บล็อกทุกคนที่ไม่ใช่แอดมิน/manager แบบเหมารวม ทำให้ช่าง
   * อัปเดตสถานะวางบิล/บันทึกรับเงินของงานตัวเองไม่ได้เลย ทั้งที่เป็นคนติดตามเรื่องกับลูกค้าเอง
   * ⚠️ ต้องเช็ค "รายงาน" ไม่ใช่ "รายบทบาท" — จึงต้องโหลด event ก่อนแล้วค่อยเช็ค (ต่างจากเดิมที่เช็ค
   * ได้ตั้งแต่ยังไม่รู้ว่างานไหน) ทุก route ที่เรียกตัวนี้จึงต้องส่ง event ที่โหลดแล้วเข้ามาด้วย
   */
  const requireEventFinanceAccess = (req, res, event) => {
    if (["admin", "manager"].includes(req.user.role)) return true;
    if (isJobParticipant(event, req.userId, req.user.fname)) return true;
    res.status(403).json({ message: "จัดการข้อมูลการเงินได้เฉพาะงานที่คุณเกี่ยวข้องเท่านั้น" });
    return false;
  };

  const financeActor = (req) => ({
    id: String(req.user?._id || req.userId || ""),
    name: req.user?.username || req.user?.fname || "ไม่ทราบชื่อ",
  });

  /**
   * บันทึก/แก้ไข "ใบวางบิล" ของงานครั้งนี้
   * ⚠️ ยอด VAT / หัก ณ ที่จ่าย / ยอดสุทธิ คำนวณฝั่ง server เสมอ ห้ามรับจาก client — ไม่งั้นหน้าจอที่
   * คำนวณผิด (หรือถูกแก้) จะเขียนยอดผิดลงฐานข้อมูลได้โดยตรง และยอดในระบบจะไม่ตรงกับสูตรเดียวกันทั้งระบบ
   */
  router.put("/:id/billing", verifyToken, async (req, res) => {
    try {
      const { id } = req.params;
      const event = await CalendarEvent.findById(id);
      if (!event) return res.status(404).json({ message: "ไม่พบงานนี้" });
      if (!requireEventFinanceAccess(req, res, event)) return;

      const { invoiceNo, invoicedAt, creditTermDays, amountBeforeVat, vatRate, whtRate, note } = req.body;

      const base = Number(amountBeforeVat);
      if (!Number.isFinite(base) || base < 0) {
        return res.status(400).json({ message: "ยอดก่อนภาษีต้องเป็นตัวเลขที่ไม่ติดลบ" });
      }
      const term = creditTermDays === undefined || creditTermDays === "" ? 30 : Number(creditTermDays);
      if (!Number.isFinite(term) || term < 0 || term > 365) {
        return res.status(400).json({ message: "เครดิตเทอมต้องอยู่ระหว่าง 0-365 วัน" });
      }
      const billedAt = invoicedAt ? new Date(invoicedAt) : new Date();
      if (Number.isNaN(billedAt.getTime())) {
        return res.status(400).json({ message: "วันที่วางบิลไม่ถูกต้อง" });
      }

      const amounts = computeBillingAmounts({ amountBeforeVat: base, vatRate, whtRate });
      const prev = event.billing || {};

      // ⚠️ ต้องคง payments เดิมไว้เสมอ — route นี้แก้ "ข้อมูลใบวางบิล" อย่างเดียว การเขียนทับ
      // billing ทั้งก้อนจะลบประวัติการรับเงินที่บันทึกไว้แล้วทิ้งทั้งหมดโดยไม่มีอะไรเตือน
      event.billing = {
        ...prev.toObject?.() ?? prev,
        invoiceNo: invoiceNo === undefined ? (prev.invoiceNo || "") : String(invoiceNo).trim(),
        invoicedAt: billedAt,
        creditTermDays: term,
        dueAt: computeDueAt(billedAt, term),
        ...amounts,
        note: note === undefined ? (prev.note || "") : String(note),
        payments: prev.payments || [],
      };

      event.activityLog = event.activityLog || [];
      const actor = financeActor(req);
      event.activityLog.push({
        action: "billing_updated",
        detail: `วางบิล ${amounts.netAmount.toLocaleString("th-TH")} บาท (ก่อน VAT ${amounts.amountBeforeVat.toLocaleString("th-TH")}) ครบกำหนด ${thaiDate(computeDueAt(billedAt, term))}`,
        userId: actor.id,
        userName: actor.name,
        timestamp: new Date(),
      });

      await event.save();
      res.json({ event: event.toObject() });
    } catch (err) {
      console.error("❌ Error saving billing:", err);
      res.status(500).json({ message: "บันทึกข้อมูลการวางบิลไม่สำเร็จ" });
    }
  });

  /**
   * ให้ AI อ่านยอดจากรูปใบวางบิลที่ช่างแนบมา
   * ⚠️ ไม่บันทึกอะไรลงฐานข้อมูลเลย — คืนค่ากลับไปเติมในฟอร์มให้คนตรวจแล้วกดบันทึกเองเสมอ
   * (ข้อมูลการเงินที่ผิดแล้วตามแก้ยากมาก ใบกำกับภาษีออกไปแล้ว/แจ้งลูกค้าไปแล้ว)
   * ⚠️ รับเฉพาะ fileId ของไฟล์ที่แนบอยู่กับงานนี้จริง ไม่ใช่รับ URL อิสระจาก client — ไม่งั้นกลายเป็น
   * ช่องให้ยิง URL อะไรก็ได้เข้ามาให้เซิร์ฟเวอร์ไปดึง (SSRF) และเผาโควตา API ได้ไม่จำกัด
   */
  router.post("/:id/billing/scan", verifyToken, async (req, res) => {
    try {
      if (!InvoiceScan.isEnabled()) {
        return res.status(503).json({ message: "ยังไม่ได้เปิดใช้งานการอ่านใบวางบิลด้วย AI (ไม่พบ ANTHROPIC_API_KEY)" });
      }

      // ⚠️ ต้อง select ฟิลด์ที่ใช้เช็คสิทธิ์มาด้วย (userId/team/resPerson/responsible*/teamMembers) —
      // ไม่งั้น isJobParticipant จะได้ undefined ทุกช่องแล้วคืน false เสมอ = ช่างโดน 403 ทุกครั้ง
      // ทั้งที่เป็นงานตัวเอง (บั๊กแบบเงียบที่หาสาเหตุยากมาก เพราะโค้ดสิทธิ์ดูถูกต้องทุกบรรทัด)
      const event = await CalendarEvent.findById(req.params.id)
        .select("invoiceFiles userId team resPerson responsiblePerson responsiblePersonId teamMembers")
        .lean();
      if (!event) return res.status(404).json({ message: "ไม่พบงานนี้" });
      if (!requireEventFinanceAccess(req, res, event)) return;

      const file = (event.invoiceFiles || []).find((f) => String(f._id) === String(req.body.fileId));
      if (!file) return res.status(404).json({ message: "ไม่พบไฟล์ใบวางบิลนี้ในงานดังกล่าว" });

      const isImage = /^image\//.test(file.fileType || "") || /\.(png|jpe?g|webp|gif)$/i.test(file.fileName || "");
      if (!isImage) {
        return res.status(400).json({ message: "อ่านได้เฉพาะไฟล์รูปภาพเท่านั้น (ไฟล์ PDF ให้กรอกยอดเอง)" });
      }

      const result = await InvoiceScan.scanInvoiceImage(file.fileUrl);
      res.json({ result });
    } catch (err) {
      console.error("❌ Error scanning invoice:", err);
      // ⚠️ ไม่โยน error ดิบกลับไปหน้าจอ — ข้อความจาก SDK อาจมีรายละเอียดคำขอ/คีย์ปนมาได้
      res.status(502).json({ message: "อ่านรูปไม่สำเร็จ กรุณาลองใหม่หรือกรอกยอดเอง" });
    }
  });

  /** บอกหน้าจอว่าฟีเจอร์อ่านใบวางบิลด้วย AI เปิดใช้งานอยู่ไหม (ไม่เปิด = ซ่อนปุ่มไปเลย ไม่ต้องให้กดแล้ว error) */
  router.get("/billing/scan-availability", verifyToken, (req, res) => {
    res.json({ enabled: InvoiceScan.isEnabled(), model: InvoiceScan.MODEL });
  });

  /** บันทึกการรับเงิน 1 งวด (รับเงินแบ่งจ่ายได้ จึงเป็น push ไม่ใช่ set) */
  // ⚠️ upload.single("slip") ต้องมีเสมอแม้ไม่ได้แนบไฟล์ — multer เป็นตัวที่ parse multipart/form-data
  // ให้ req.body ด้วย ถ้าไม่ใส่ req.body จะว่างเปล่าทั้งก้อนเมื่อฝั่งจอส่งมาเป็น FormData
  // (ฝั่งจอส่ง FormData เสมอ ไม่ว่าจะแนบไฟล์หรือไม่ — เทียบ pattern เดียวกับ /:id/quotation-followup)
  router.post("/:id/billing/payment", verifyToken, upload.single("slip"), async (req, res) => {
    try {
      const { id } = req.params;
      const event = await CalendarEvent.findById(id);
      if (!event) return res.status(404).json({ message: "ไม่พบงานนี้" });
      if (!requireEventFinanceAccess(req, res, event)) return;
      // ⚠️ ห้ามบันทึกรับเงินก่อนวางบิล — ไม่มียอดให้เทียบว่าครบหรือยัง สถานะจะคำนวณไม่ได้
      if (!event.billing?.invoicedAt) {
        return res.status(409).json({ message: "ต้องบันทึกการวางบิลก่อนจึงจะบันทึกรับเงินได้" });
      }

      const amount = Number(req.body.amount);
      if (!Number.isFinite(amount) || amount <= 0) {
        return res.status(400).json({ message: "ยอดรับเงินต้องมากกว่า 0" });
      }

      // ✅ ห้ามรับเงินเกินยอดที่ค้างอยู่ — เดิมเช็คแค่ว่า > 0 พิมพ์ตกหล่นศูนย์เกินมาหนึ่งตัว
      // (104,000 → 1,040,000) ก็บันทึกเข้าไปเลย ทำให้ยอดรับรวมเกินยอดบิล สถานะกลายเป็น "ชำระครบ"
      // ทั้งที่ตัวเลขผิด แล้วรายงานการเงินทั้งระบบเพี้ยนตาม
      // ⚠️ กันที่นี่ด้วยเสมอ ไม่ใช่แค่ที่หน้าจอ — หน้าจอไม่ใช่ขอบเขตความปลอดภัย
      // ⚠️ เผื่อ 0.005 เพราะ netAmount ผ่านการปัดทศนิยมมาแล้ว ถ้าเทียบตรงๆ การจ่ายเต็มจำนวน
      // อาจถูกปฏิเสธเพราะความคลาดเคลื่อนของเลขทศนิยม
      const netAmount = Number(event.billing.netAmount) || 0;
      const paidSoFar = (event.billing.payments || []).reduce((s, p) => s + (Number(p.amount) || 0), 0);
      const outstanding = netAmount - paidSoFar;
      if (amount - outstanding > 0.005) {
        return res.status(409).json({
          message:
            `รับเงินเกินยอดที่ค้างอยู่ไม่ได้ — ยอดบิล ${netAmount.toLocaleString("th-TH")} บาท ` +
            `รับมาแล้ว ${paidSoFar.toLocaleString("th-TH")} บาท คงเหลือ ${outstanding.toLocaleString("th-TH")} บาท`,
        });
      }
      const paidAt = req.body.paidAt ? new Date(req.body.paidAt) : new Date();
      if (Number.isNaN(paidAt.getTime())) {
        return res.status(400).json({ message: "วันที่รับเงินไม่ถูกต้อง" });
      }

      const actor = financeActor(req);
      const payment = {
        amount, paidAt,
        method: String(req.body.method || "").trim(),
        note: String(req.body.note || "").trim(),
        receiptNo: String(req.body.receiptNo || "").trim(),
        recordedBy: actor.id,
        recordedByName: actor.name,
        recordedAt: new Date(),
      };

      // ✅ แนบสลิป/ใบเสร็จ (ถ้ามี) — ขึ้น Cloudinary เหมือนไฟล์อื่นในระบบ
      // ⚠️ รูปใช้ resource_type "image" ไม่ใช่ "raw" เพราะ "raw" ใช้ URL transformation ไม่ได้เลย
      // ตอนเปิดพรีวิวจะต้องโหลดไฟล์เต็มความละเอียดจากมือถือ (หลาย MB) ทุกครั้ง — เหตุผลเต็มที่ files.js
      if (req.file) {
        const originalName = Buffer.from(req.file.originalname, "latin1").toString("utf8");
        const sanitizedName = originalName.replace(/[^\w\-.]/g, "_");
        const isImage = ["image/jpeg", "image/png", "image/webp"].includes(req.file.mimetype);
        const result = await new Promise((resolve, reject) => {
          const stream = cloudinary.uploader.upload_stream(
            {
              resource_type: isImage ? "image" : "raw",
              folder: `events/${id}/payments`,
              // resource_type "image" เติมนามสกุลให้เองจากเนื้อไฟล์ ต้องตัดออกก่อนไม่งั้นได้ ".jpg.jpg"
              public_id: `${Date.now()}_${isImage ? sanitizedName.replace(/\.[^.]+$/, "") : sanitizedName}`,
              use_filename: false,
              unique_filename: false,
              overwrite: true,
            },
            (error, uploaded) => (error ? reject(error) : resolve(uploaded)),
          );
          streamifier.createReadStream(req.file.buffer).pipe(stream);
        });
        payment.slipFileName = originalName;
        payment.slipFileUrl = result.secure_url;
        payment.slipFileType = req.file.mimetype;
      }

      event.billing.payments.push(payment);
      event.activityLog = event.activityLog || [];
      event.activityLog.push({
        action: "payment_recorded",
        detail: `รับเงิน ${amount.toLocaleString("th-TH")} บาท (${thaiDate(paidAt)})`,
        userId: actor.id,
        userName: actor.name,
        timestamp: new Date(),
      });

      await event.save();
      res.json({ event: event.toObject() });
    } catch (err) {
      console.error("❌ Error recording payment:", err);
      res.status(500).json({ message: "บันทึกการรับเงินไม่สำเร็จ" });
    }
  });

  /** ลบรายการรับเงินที่บันทึกผิด */
  /**
   * แก้เลขที่ใบเสร็จ / แนบสลิปให้ "รายการรับเงินที่บันทึกไว้แล้ว"
   *
   * 🐛 ทำไมต้องมี: ตอนบันทึกรับเงินแนบไฟล์ได้อยู่แล้ว แต่ของจริงสลิปกับใบเสร็จมักมาทีหลัง —
   * เงินเข้าวันนี้ ใบเสร็จออกพรุ่งนี้ พอบิลนั้นรับครบแล้วจะบันทึกรายการใหม่ไม่ได้อีก (ติดกฎห้ามรับเกิน)
   * เท่ากับแนบหลักฐานย้อนหลังไม่ได้เลย ต้องแก้ที่รายการเดิมแทน
   *
   * ⚠️ แก้ได้แค่ "เลขที่ใบเสร็จ" กับ "ไฟล์แนบ" เท่านั้น — ยอดเงิน/วันที่รับ แก้ไม่ได้โดยตั้งใจ
   * เพราะเป็นตัวเลขที่กระทบยอดรวมและสถานะการชำระ ถ้าจะแก้ต้องลบรายการแล้วบันทึกใหม่ให้เห็นร่องรอย
   */
  router.patch("/:id/billing/payment/:paymentId", verifyToken, upload.single("slip"), async (req, res) => {
    try {
      const { id, paymentId } = req.params;
      const event = await CalendarEvent.findById(id);
      if (!event) return res.status(404).json({ message: "ไม่พบงานนี้" });
      if (!requireEventFinanceAccess(req, res, event)) return;

      const item = event.billing?.payments?.id(paymentId);
      if (!item) return res.status(404).json({ message: "ไม่พบรายการรับเงินนี้" });

      if (req.body.receiptNo !== undefined) {
        item.receiptNo = String(req.body.receiptNo || "").trim();
      }

      if (req.file) {
        const originalName = Buffer.from(req.file.originalname, "latin1").toString("utf8");
        const sanitizedName = originalName.replace(/[^\w\-.]/g, "_");
        const isImage = ["image/jpeg", "image/png", "image/webp"].includes(req.file.mimetype);
        const result = await new Promise((resolve, reject) => {
          const stream = cloudinary.uploader.upload_stream(
            {
              resource_type: isImage ? "image" : "raw",
              folder: `events/${id}/payments`,
              public_id: `${Date.now()}_${isImage ? sanitizedName.replace(/\.[^.]+$/, "") : sanitizedName}`,
              use_filename: false,
              unique_filename: false,
              overwrite: true,
            },
            (error, uploaded) => (error ? reject(error) : resolve(uploaded)),
          );
          streamifier.createReadStream(req.file.buffer).pipe(stream);
        });
        item.slipFileName = originalName;
        item.slipFileUrl = result.secure_url;
        item.slipFileType = req.file.mimetype;
      }

      const actor = financeActor(req);
      event.activityLog = event.activityLog || [];
      event.activityLog.push({
        action: "payment_updated",
        detail: `แก้ไขหลักฐานการรับเงิน ${Number(item.amount).toLocaleString("th-TH")} บาท` +
          `${item.receiptNo ? ` (ใบเสร็จ ${item.receiptNo})` : ""}${req.file ? " · แนบไฟล์" : ""}`,
        userId: actor.id,
        userName: actor.name,
        timestamp: new Date(),
      });

      await event.save();
      res.json({ event: event.toObject() });
    } catch (err) {
      console.error("❌ Error updating payment:", err);
      res.status(500).json({ message: "แก้ไขรายการรับเงินไม่สำเร็จ" });
    }
  });

  router.delete("/:id/billing/payment/:paymentId", verifyToken, async (req, res) => {
    try {
      const event = await CalendarEvent.findById(req.params.id);
      if (!event) return res.status(404).json({ message: "ไม่พบงานนี้" });
      if (!requireEventFinanceAccess(req, res, event)) return;
      const item = event.billing?.payments?.id(req.params.paymentId);
      if (!item) return res.status(404).json({ message: "ไม่พบรายการรับเงินนี้" });

      const actor = financeActor(req);
      const removedAmount = Number(item.amount) || 0;
      item.deleteOne();
      event.activityLog = event.activityLog || [];
      event.activityLog.push({
        action: "payment_removed",
        detail: `ลบรายการรับเงิน ${removedAmount.toLocaleString("th-TH")} บาท`,
        userId: actor.id,
        userName: actor.name,
        timestamp: new Date(),
      });
      await event.save();
      res.json({ event: event.toObject() });
    } catch (err) {
      console.error("❌ Error removing payment:", err);
      res.status(500).json({ message: "ลบรายการรับเงินไม่สำเร็จ" });
    }
  });
};
