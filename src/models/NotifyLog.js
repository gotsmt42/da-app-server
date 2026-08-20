const mongoose = require("../db");

/**
 * NotifyLog — บันทึกว่า "แจ้งเตือนเรื่องนี้ ให้คนนี้ ในวันนี้ ไปแล้ว"
 *
 * 🐛 ปัญหาที่แก้: ตัวแจ้งเตือนเป็นระยะ (services/OverdueReminder.js) ถูกตั้งเวลาไว้ด้วย
 * setTimeout(2 นาที) + setInterval(24 ชม.) ใน index.js ซึ่งนับจาก "เวลาที่โปรเซสเริ่มทำงาน" —
 * ทุกครั้งที่ deploy/รีสตาร์ทเซิร์ฟเวอร์ นาฬิกาจึงเริ่มนับใหม่และยิงแจ้งเตือนรอบใหม่ทันทีใน 2 นาที
 * ไม่ว่าเพิ่งแจ้งไปเมื่อ 10 นาทีที่แล้วหรือไม่ ผลคือวันที่แก้โค้ดหลายรอบ ผู้ใช้โดนเด้งเรื่องเดิมซ้ำๆ
 * ทั้งวัน จนเริ่มเมินการแจ้งเตือนไปเลย (ซึ่งอันตรายกว่าไม่แจ้งเสียอีก)
 *
 * ✅ วิธีแก้: กันซ้ำที่ "ชั้นส่ง" ด้วยกุญแจที่ผูกกับวันจริง ไม่ใช่ผูกกับเวลาที่โปรเซสเริ่ม —
 * key = `<ชนิดการแจ้ง>:<เรื่องที่แจ้ง>:<ผู้รับ>:<YYYY-MM-DD>` ตั้ง unique index ไว้
 * ⚠️ ต้องกันที่ฐานข้อมูล ไม่ใช่ตัวแปรในหน่วยความจำ — ตัวแปรหายทุกครั้งที่รีสตาร์ท ซึ่งเป็นต้นเหตุเดิมเป๊ะ
 * ⚠️ ใช้ "สร้างแถวแล้วดูว่าชนไหม" (unique index + E11000) เป็นตัวตัดสิน ไม่ใช่ find-แล้วค่อย-create
 * เพราะแบบหลังมีช่องว่างให้ 2 โปรเซส (หรือ 2 รอบที่ยิงพร้อมกัน) อ่านเจอ "ยังไม่เคยส่ง" พร้อมกันแล้ว
 * ส่งซ้ำทั้งคู่ ส่วน unique index ฐานข้อมูลการันตีให้ว่ามีผู้ชนะแค่รายเดียวเสมอ
 */
const notifyLogSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, index: true },
    kind: { type: String, default: "" },
    sentAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

// ✅ ลบทิ้งอัตโนมัติหลัง 45 วัน — ตารางนี้เป็นแค่ "กันซ้ำรายวัน" ไม่ใช่ประวัติที่ต้องเก็บถาวร
// ถ้าไม่ตั้ง TTL แถวจะสะสมไปเรื่อยๆ ทุกวันตลอดอายุระบบโดยไม่มีใครได้ใช้ข้อมูลเก่าเลย
notifyLogSchema.index({ sentAt: 1 }, { expireAfterSeconds: 45 * 24 * 60 * 60 });

const NotifyLog = mongoose.model("NotifyLog", notifyLogSchema);

/**
 * ✅ ตัวช่วยเดียวที่ทุกจุดควรเรียกก่อนส่งแจ้งเตือนเป็นระยะ
 * @returns {Promise<boolean>} true = ยังไม่เคยส่งวันนี้ (ส่งได้เลย) · false = ส่งไปแล้ว ให้ข้าม
 */
NotifyLog.claimOncePerDay = async function claimOncePerDay(kind, subject, recipient) {
  // ⚠️ ใช้วันตามเวลาไทย (UTC+7) ไม่ใช่ UTC — ไม่งั้น "หนึ่งวัน" ของระบบจะตัดตอน 7 โมงเช้าบ้านเรา
  // ผู้ใช้จะโดนแจ้งซ้ำเรื่องเดิมช่วงเช้าทุกวันโดยไม่มีเหตุผลที่อธิบายได้
  const day = new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const key = `${kind}:${subject}:${recipient}:${day}`;
  try {
    await NotifyLog.create({ key, kind });
    return true;
  } catch (err) {
    if (err?.code === 11000) return false; // มีคนคว้าคีย์นี้ไปแล้ววันนี้
    // ⚠️ ฐานข้อมูลมีปัญหาอื่น — ยอมให้ส่ง ดีกว่าเงียบหายไปทั้งระบบแจ้งเตือนโดยไม่มีใครรู้
    console.error("❌ NotifyLog claim error:", err);
    return true;
  }
};

module.exports = NotifyLog;
