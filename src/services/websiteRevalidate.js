/**
 * สั่งเว็บไซต์บริษัท (da-web) ดึงเนื้อหาใหม่ทันที — ยิงแล้วไม่รอ (ไม่ให้การบันทึกช้าเพราะรอเว็บ)
 *
 * ⚠️ ต้องเรียกทุกครั้งที่ข้อมูลที่เว็บใช้เปลี่ยน:
 *    • เนื้อหาเว็บ (routes/web.js — สินค้า ผลงาน บทความ ยี่ห้อ การแสดงผล)
 *    (ช่องทางติดต่อของเว็บย้ายมาอยู่ใน "ตั้งค่าเว็บไซต์" แล้ว — ตั้งค่าองค์กรของแอปไม่เกี่ยวกับเว็บอีก)
 * ⚠️ ไม่ตั้ง WEB_REVALIDATE_URL = เว็บจะอัปเดตเองตามรอบเวลา (ดู da-web/src/lib/cms.ts)
 */
function revalidateWebsite() {
  const url = process.env.WEB_REVALIDATE_URL;
  const secret = process.env.WEB_REVALIDATE_SECRET;
  if (!url || !secret) return;
  fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-revalidate-secret": secret },
    body: JSON.stringify({ tags: ["web-content"] }),
    signal: AbortSignal.timeout(10_000),
  }).catch((err) => console.error("⚠️ สั่งเว็บไซต์อัปเดตไม่สำเร็จ:", err.message));
}

module.exports = { revalidateWebsite };
