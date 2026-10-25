const mongoose = require("mongoose");

/**
 * ServiceReportSummary — สรุป Service Report ของงาน (AI อ่านจากไฟล์ที่ช่างแนบ แล้วคนตรวจ/แก้/ยืนยัน)
 *
 * ✅ (25 ต.ค. 2569 ผู้ใช้: "ทำระบบให้อ่าน Service Report ของช่าง แล้วกดสร้างสรุปออกมาเป็น PDF ให้สมบูรณ์ที่สุด")
 * ⚠️ แยกคอลเลกชันจาก Events โดยตั้งใจ — ข้อมูลสรุปหลาย KB ต่องาน ถ้าเก็บในงานจะติดไปกับ /event-op
 *    (โหลดงานทั้งชุดทุกหน้า) ทำให้ทั้งแอปช้า · ในงานเก็บแค่ป้ายสถานะเล็กๆ (Events.serviceReportAi)
 * 1 งาน = 1 เอกสาร (jobKey = jobGroupId ถ้าเป็นงานหลายวัน ไม่งั้น _id ของงาน)
 */
const ServiceReportSummarySchema = new mongoose.Schema(
  {
    jobKey: { type: String, required: true, unique: true, index: true },
    eventIds: { type: [String], default: [] },
    status: { type: String, enum: ["draft", "confirmed"], default: "draft" },
    // ผลที่ AI อ่านได้ครั้งล่าสุด (ไม่แก้) — ไว้เทียบกับที่คนแก้ และอ่านใหม่ได้
    aiData: { type: mongoose.Schema.Types.Mixed, default: null },
    // ข้อมูลที่ใช้จริง (เริ่มจากผล AI แล้วคนแก้ได้) — ใช้สร้าง PDF
    data: { type: mongoose.Schema.Types.Mixed, default: null },
    files: { type: [{ fileName: String, fileUrl: String }], default: [] },
    model: { type: String, default: "" },
    scannedAt: Date,
    scannedBy: { type: String, default: "" },
    editedAt: Date,
    editedBy: { type: String, default: "" },
    confirmedAt: Date,
    confirmedBy: { type: String, default: "" },
  },
  { timestamps: true },
);

module.exports = mongoose.model("ServiceReportSummary", ServiceReportSummarySchema);
