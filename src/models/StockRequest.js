const mongoose = require("../db");

/**
 * StockRequest — ใบเบิกสต๊อก/ยืมทรัพย์สินของแผนก (SR-00001/2569)
 *
 * วงจร: pending (รออนุมัติ · จองยอดไว้แล้ว) → issued (อนุมัติ + จ่ายของแล้ว · ตัดยอด)
 *       → returned (ทรัพย์สินที่ยืมคืนครบ) · pending → rejected / cancelled (คืนยอดที่จองไว้)
 * ⚠️ บังคับอิงงานทุกใบ (eventId) — ดูได้ว่างานไหนใช้ของอะไรไปเท่าไร
 */
const personSchema = { userId: { type: String, default: "" }, name: { type: String, default: "" } };

const lineSchema = new mongoose.Schema(
  {
    item: { type: mongoose.Schema.Types.ObjectId, ref: "StockItem", required: true },
    code: { type: String, default: "" },
    name: { type: String, default: "" },
    unit: { type: String, default: "" },
    kind: { type: String, enum: ["consumable", "asset"], default: "consumable" },
    qty: { type: Number, required: true, min: 1 },
    /** ทรัพย์สินที่รับคืนแล้ว */
    returnedQty: { type: Number, default: 0, min: 0 },
  },
  { _id: true }
);

const stockRequestSchema = new mongoose.Schema(
  {
    docNo: { type: String, unique: true, sparse: true, index: true },
    dept: { type: String, required: true, index: true },
    status: { type: String, enum: ["pending", "issued", "returned", "rejected", "cancelled"], default: "pending", index: true },
    requester: { userId: { type: String, index: true, default: "" }, name: { type: String, default: "" }, position: { type: String, default: "" } },
    eventId: { type: String, required: true, index: true },
    jobTitle: { type: String, default: "" },
    jobType: { type: String, default: "" },
    jobColor: { type: String, default: "" },
    lines: { type: [lineSchema], default: [] },
    note: { type: String, default: "", trim: true },
    /** คืนทรัพย์สินภายในวันที่ (ไม่บังคับ) */
    dueReturnAt: { type: Date, default: null },
    issuedBy: personSchema,
    issuedAt: { type: Date, default: null },
    rejectedBy: personSchema,
    rejectedAt: { type: Date, default: null },
    rejectReason: { type: String, default: "" },
    cancelledBy: personSchema,
    cancelledAt: { type: Date, default: null },
    activityLog: [{ action: String, detail: String, userId: String, userName: String, timestamp: { type: Date, default: Date.now } }],
  },
  { timestamps: true }
);
stockRequestSchema.index({ dept: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model("StockRequest", stockRequestSchema);
