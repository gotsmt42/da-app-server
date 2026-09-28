/**
 * แปลง "ลิงก์ที่แชร์จาก Google Maps" เป็นตำแหน่งที่ฝังเป็นแผนที่ในหน้าจอได้
 *
 * ✅ ผู้ใช้สั่ง (28 ก.ย. 2569): "อยากให้ตำแหน่งหน้างานแสดงเป็นแผนที่ google map เลย ไว้แถวบนสุด"
 * ⚠️ ลิงก์ที่ผู้ใช้วางส่วนใหญ่เป็นลิงก์ย่อ (maps.app.goo.gl/xxxx) ซึ่งฝังใน iframe ตรงๆ ไม่ได้
 *    และหน้าเว็บเปิดตามไปดูปลายทางเองไม่ได้ (CORS) — ต้องให้ server ตามลิงก์ไปจนเจอ URL เต็ม
 *    แล้วแกะพิกัด/ชื่อสถานที่ออกมา
 * 🔒 ตามลิงก์ได้เฉพาะโดเมน Google เท่านั้น — กันใช้ server เป็นทางยิงไปที่อื่น (SSRF)
 * ⚠️ แกะไม่ได้ = คืน null (หน้าจอจะแสดงแผนที่ค้นหาจากชื่อโครงการแทน ไม่ใช่พัง)
 */
const ALLOWED = /(^|\.)(google\.[a-z.]+|goo\.gl|app\.goo\.gl|maps\.app\.goo\.gl|g\.co)$/i;
const CACHE = new Map(); // url → { lat, lng, q } | null  (ลิงก์เดิมให้ผลเดิมเสมอ ไม่ต้องตามซ้ำ)

const isAllowed = (u) => {
  try {
    const x = new URL(u);
    return ["http:", "https:"].includes(x.protocol) && ALLOWED.test(x.hostname);
  } catch {
    return false;
  }
};

/** แกะตำแหน่งจาก URL เต็มของ Google Maps (รองรับรูปแบบที่พบบ่อย) */
function parse(u) {
  let s;
  try { s = decodeURIComponent(u); } catch { s = u; }
  // 1) หมุดจริงของสถานที่: ...!3d13.85!4d100.64...  (แม่นกว่า @ ซึ่งเป็นจุดกึ่งกลางกล้อง)
  let m = s.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
  if (m) return { lat: +m[1], lng: +m[2] };
  // 2) ?q=13.85,100.64 · ?query=... · ?ll=... · /search/13.85,+100.64
  m = s.match(/[?&](?:q|query|ll|destination|daddr)=(-?\d+\.\d+)\s*,\s*\+?(-?\d+\.\d+)/) || s.match(/\/(?:search|place|dir)\/(-?\d+\.\d+),\s*\+?(-?\d+\.\d+)/);
  if (m) return { lat: +m[1], lng: +m[2] };
  // 3) /place/ชื่อสถานที่/...
  m = s.match(/\/place\/([^/@?]+)/);
  const place = m ? m[1].replace(/\+/g, " ").trim() : "";
  // 4) @13.85,100.64,17z — จุดกึ่งกลางกล้อง
  m = s.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (m) return { lat: +m[1], lng: +m[2], q: place || undefined };
  if (place) return { q: place };
  // 5) ?q=ข้อความ
  m = s.match(/[?&](?:q|query)=([^&]+)/);
  if (m) return { q: m[1].replace(/\+/g, " ").trim() };
  return null;
}

/** ตามลิงก์ย่อทีละขั้น (สูงสุด 5 ครั้ง) โดยตรวจโดเมนทุกขั้น */
async function resolveMapUrl(url) {
  const raw = String(url || "").trim();
  if (!raw || !isAllowed(raw)) return null;
  if (CACHE.has(raw)) return CACHE.get(raw);
  let cur = raw;
  let result = parse(cur);
  for (let hop = 0; !result && hop < 5; hop += 1) {
    const res = await fetch(cur, { redirect: "manual", signal: AbortSignal.timeout(8000), headers: { "user-agent": "Mozilla/5.0" } });
    const next = res.headers.get("location");
    if (!next) break;
    cur = new URL(next, cur).toString();
    if (!isAllowed(cur)) break;
    result = parse(cur);
  }
  if (CACHE.size > 500) CACHE.clear();
  CACHE.set(raw, result || null);
  return result || null;
}

module.exports = { resolveMapUrl, parse };
