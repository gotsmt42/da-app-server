const mongoose = require("../db");

/**
 * StockReturn — ใบคืนของ (RT-00001/2569)
 *
 * ✅ (27 ต.ค. 2569 ผู้ใช้: "มีวิธีจัดการยังไงไม่ให้ผิดพลาดในการจัดการของ ของหาย หรือต้องมีใบคืนสินค้าด้วย"
 *    → เลือก "ใบคืนของ + สภาพของ")
 *   คืนได้ทั้งวัสดุที่เหลือใช้และทรัพย์สินที่ยืม — ทุกใบอ้างใบเบิก (requestId) ที่จ่ายของแล้ว
 *   สภาพต่อรายการ:
 *     good    ปกติ    → เข้าคลัง (qty +)
 *     damaged ชำรุด   → แยกไปยอด "รอซ่อม" (StockItem.damaged) เบิกไม่ได้จนกว่าจะซ่อมเสร็จ/ตัดจำหน่าย
 *     lost    สูญหาย  → ตัดจำหน่าย บันทึกผู้รับผิดชอบ (เฉพาะทรัพย์สิน)
 *   วงจร: pending (รอตรวจรับ) → received (ผู้ดูแลคลังตรวจรับ · ยอดเปลี่ยนตอนนี้) · pending → rejected / cancelled
 */
const personSchema = { userId: { type: String, default: "" }, name: { type: String, default: "" } };

const lineSchema = new mongoose.Schema(
  {
    /** _id ของรายการในใบเบิก */
    lineId: { type: String, required: true },
    item: { type: mongoose.Schema.Types.ObjectId, ref: "StockItem", required: true },
    code: { type: String, default: "" },
    name: { type: String, default: "" },
    unit: { type: String, default: "" },
    kind: { type: String, enum: ["consumable", "asset"], default: "consumable" },
    qty: { type: Number, required: true, min: 1 },
    condition: { type: String, enum: ["good", "damaged", "lost"], default: "good" },
    note: { type: String, default: "" },
  },
  { _id: true }
);

const stockReturnSchema = new mongoose.Schema(
  {
    docNo: { type: String, unique: true, sparse: true, index: true },
    dept: { type: String, required: true, index: true },
    status: { type: String, enum: ["pending", "received", "rejected", "cancelled"], default: "pending", index: true },
    requestId: { type: String, required: true, index: true },
    requestDocNo: { type: String, default: "" },
    requester: { userId: { type: String, index: true, default: "" }, name: { type: String, default: "" }, position: { type: String, default: "" } },
    /** ผู้ยื่นใบคืน (อาจเป็นผู้ดูแลคลังยื่นแทน) */
    createdBy: personSchema,
    eventId: { type: String, default: "" },
    jobTitle: { type: String, default: "" },
    jobType: { type: String, default: "" },
    jobColor: { type: String, default: "" },
    lines: { type: [lineSchema], default: [] },
    /** ไฟล์แนบ (รูป/เอกสาร) — ชื่อเดิม photos คงไว้ · type = mime */
    photos: [{ url: String, publicId: String, name: String, type: String }],
    note: { type: String, default: "", trim: true },
    receivedBy: personSchema,
    receivedAt: { type: Date, default: null },
    rejectedBy: personSchema,
    rejectedAt: { type: Date, default: null },
    rejectReason: { type: String, default: "" },
    cancelledBy: personSchema,
    cancelledAt: { type: Date, default: null },
    activityLog: [{ action: String, detail: String, userId: String, userName: String, timestamp: { type: Date, default: Date.now } }],
  },
  { timestamps: true }
);
stockReturnSchema.index({ dept: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model("StockReturn", stockReturnSchema);
