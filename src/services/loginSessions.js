/**
 * loginSessions — บันทึก/ตรวจ "อุปกรณ์ที่เข้าสู่ระบบ" (ดู models/LoginSession.js)
 *
 * ⚠️ ทุกอย่างในไฟล์นี้ต้อง "พังแล้วไม่ล้มระบบ" — บันทึกอุปกรณ์ไม่สำเร็จต้องไม่ทำให้ใช้งานไม่ได้
 *    ยกเว้นอย่างเดียว: อุปกรณ์ที่ถูกสั่งออกจากระบบแล้ว (revokedAt) ต้องเข้าไม่ได้จริง
 */
const crypto = require("crypto");
const LoginSession = require("../models/LoginSession");

const TOUCH_EVERY_MS = 3 * 60 * 1000;   // อัปเดตเวลาใช้งานล่าสุดไม่ถี่กว่านี้
const CACHE_MS = 60 * 1000;             // จำผลตรวจ revoked ในหน่วยความจำ ลดการอ่านฐานข้อมูลทุกคำขอ

/** sid ของ token — รุ่นใหม่มีใน payload · รุ่นเก่าใช้ hash ของ token */
const sidOf = (decoded, token) => decoded?.sid || `t_${crypto.createHash("sha256").update(String(token || "")).digest("hex").slice(0, 32)}`;
const newSid = () => crypto.randomBytes(16).toString("hex");

/** IP ของผู้ใช้ — Render อยู่หลัง proxy จึงต้องอ่าน x-forwarded-for ตัวแรก */
const clientIp = (req) => {
  const xff = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  const ip = xff || req.socket?.remoteAddress || req.ip || "";
  return ip.replace(/^::ffff:/, "");
};

const isPrivateIp = (ip) => !ip || ip === "::1" || /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|fc|fd|fe80)/i.test(ip);

/** อ่าน User-Agent แบบพอใช้ (ไม่ต้องลงไลบรารีเพิ่ม) + ข้อมูลรุ่นเครื่องที่เบราว์เซอร์ส่งมา (Client Hints) */
const parseUA = (ua = "", hints = {}) => {
  const s = String(ua);
  let os = "", osVersion = "", browser = "", browserVersion = "", deviceType = "desktop", vendor = "", model = "";
  const m = (re) => s.match(re);
  let x;
  if ((x = m(/Windows NT ([\d.]+)/))) { os = "Windows"; osVersion = { "10.0": "10/11", "6.3": "8.1", "6.2": "8", "6.1": "7" }[x[1]] || x[1]; }
  else if ((x = m(/(iPhone|iPad|iPod).*?OS ([\d_]+)/))) { os = "iOS"; osVersion = x[2].replace(/_/g, "."); vendor = "Apple"; model = x[1]; deviceType = x[1] === "iPad" ? "tablet" : "mobile"; }
  else if ((x = m(/Android ([\d.]+)/))) {
    os = "Android"; osVersion = x[1];
    deviceType = /Mobile/.test(s) ? "mobile" : "tablet";
    const mm = s.match(/Android [\d.]+;(?: [a-z]{2}-[a-z]{2};)? ([^;)]+?)(?: Build|\))/i);
    if (mm && !/^K$/.test(mm[1].trim())) model = mm[1].trim();
  }
  else if ((x = m(/Mac OS X ([\d_]+)/))) { os = "macOS"; osVersion = x[1].replace(/_/g, "."); vendor = "Apple"; }
  else if (/CrOS/.test(s)) os = "ChromeOS";
  else if (/Linux/.test(s)) os = "Linux";

  if ((x = m(/EdgA?\/([\d.]+)/))) { browser = "Edge"; browserVersion = x[1]; }
  else if ((x = m(/Line\/([\d.]+)/))) { browser = "LINE (เบราว์เซอร์ในแอป)"; browserVersion = x[1]; }
  else if ((x = m(/FBAV\/([\d.]+)/))) { browser = "Facebook (เบราว์เซอร์ในแอป)"; browserVersion = x[1]; }
  else if ((x = m(/SamsungBrowser\/([\d.]+)/))) { browser = "Samsung Internet"; browserVersion = x[1]; }
  else if ((x = m(/OPR\/([\d.]+)/))) { browser = "Opera"; browserVersion = x[1]; }
  else if ((x = m(/(?:Firefox|FxiOS)\/([\d.]+)/))) { browser = "Firefox"; browserVersion = x[1]; }
  else if ((x = m(/(?:Chrome|CriOS)\/([\d.]+)/))) { browser = "Chrome"; browserVersion = x[1]; }
  else if ((x = m(/Version\/([\d.]+).*Safari/))) { browser = "Safari"; browserVersion = x[1]; }

  // Client Hints จากเบราว์เซอร์ (Chrome/Edge บน Android ส่งรุ่นเครื่องจริงมาได้ เช่น SM-S918B)
  if (hints.model) model = String(hints.model).slice(0, 60);
  if (hints.platformVersion && os === "Windows") osVersion = Number(String(hints.platformVersion).split(".")[0]) >= 13 ? "11" : "10";
  if (hints.platformVersion && os === "macOS") osVersion = String(hints.platformVersion).slice(0, 12);
  if (hints.mobile === true && deviceType === "desktop") deviceType = "mobile";
  if (/^SM-|^Galaxy/i.test(model)) vendor = "Samsung";
  else if (/^Pixel/i.test(model)) vendor = "Google";
  else if (/^(CPH|RMX)/i.test(model)) vendor = /^CPH/i.test(model) ? "OPPO" : "realme";
  else if (/^(V\d{4}|vivo)/i.test(model)) vendor = "vivo";
  else if (/^(M\d{4}|Redmi|POCO|Mi )/i.test(model) || /^\d{4,}[A-Z]{1,3}\d*[A-Z]?$/i.test(model)) vendor = vendor || "Xiaomi";
  else if (/^(TECNO|Infinix)/i.test(model)) vendor = model.split(" ")[0];
  else if (/^(HUAWEI|[A-Z]{3}-L)/i.test(model)) vendor = "Huawei";

  return {
    os, osVersion, browser, browserVersion, deviceType: os ? deviceType : "unknown",
    deviceVendor: vendor, deviceModel: model,
  };
};

/** ตำแหน่งโดยประมาณจาก IP (ระดับเมือง) — บริการฟรี ipwho.is · ไม่ได้ = เว้นว่าง */
const lookupGeo = async (ip) => {
  if (isPrivateIp(ip) || typeof fetch !== "function") return null;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 3000);
    const res = await fetch(`https://ipwho.is/${encodeURIComponent(ip)}?lang=th&fields=success,city,region,country,country_code,connection`, { signal: ctrl.signal });
    clearTimeout(t);
    const j = await res.json();
    if (!j?.success) return null;
    return { city: j.city || "", region: j.region || "", country: j.country || "", countryCode: j.country_code || "", isp: j.connection?.isp || j.connection?.org || "", ip };
  } catch {
    return null;
  }
};

const cache = new Map(); // sid → { revoked, at, touchedAt }

const refreshGeo = (sid, ip, known) => {
  if (!ip || known?.ip === ip) return;
  lookupGeo(ip).then((geo) => {
    if (geo) LoginSession.updateOne({ sid }, { $set: { location: geo } }).catch(() => {});
  });
};

/** สร้างแถวตอนเข้าสู่ระบบ — เรียกแบบไม่ต้อง await */
const recordLogin = async ({ sid, userId, req, hints = {} }) => {
  try {
    const ua = String(req.headers["user-agent"] || "").slice(0, 500);
    const ip = clientIp(req);
    await LoginSession.create({
      sid, userId, userAgent: ua, ip, standalone: Boolean(hints.standalone), lastSeenAt: new Date(),
      ...parseUA(ua, hints),
    });
    refreshGeo(sid, ip, null);
  } catch (err) {
    console.warn("⚠️ บันทึกอุปกรณ์ที่เข้าสู่ระบบไม่สำเร็จ:", err.message);
  }
};

/**
 * ตรวจ+อัปเดตอุปกรณ์ในทุกคำขอ (เรียกจาก middleware/auth.js)
 * @returns {Promise<{ ok: boolean, sid: string }>} ok=false เมื่อถูกสั่งออกจากระบบแล้วเท่านั้น
 */
const touch = async ({ decoded, token, req }) => {
  const sid = sidOf(decoded, token);
  const now = Date.now();
  const c = cache.get(sid);
  if (c && now - c.at < CACHE_MS) {
    if (c.revoked) return { ok: false, sid };
    if (now - c.touchedAt < TOUCH_EVERY_MS) return { ok: true, sid };
  }
  try {
    const doc = await LoginSession.findOne({ sid }, { revokedAt: 1, location: 1, userId: 1 }).lean();
    if (doc?.revokedAt) { cache.set(sid, { revoked: true, at: now, touchedAt: now }); return { ok: false, sid }; }
    const ip = clientIp(req);
    if (!doc) {
      // token รุ่นเก่า หรือแถวถูกลบไปแล้ว → สร้างใหม่จากคำขอนี้ (ไม่มีข้อมูลรุ่นเครื่องจาก Client Hints)
      const ua = String(req.headers["user-agent"] || "").slice(0, 500);
      await LoginSession.updateOne(
        { sid },
        { $setOnInsert: { sid, userId: decoded.userId, legacy: !decoded.sid, userAgent: ua, ...parseUA(ua, {}) }, $set: { ip, lastSeenAt: new Date() } },
        { upsert: true },
      );
      refreshGeo(sid, ip, null);
    } else {
      await LoginSession.updateOne({ sid }, { $set: { ip, lastSeenAt: new Date() } });
      refreshGeo(sid, ip, doc.location);
    }
    cache.set(sid, { revoked: false, at: now, touchedAt: now });
  } catch {
    // ฐานข้อมูลสะดุด — ปล่อยผ่าน (การล็อกอินยังตรวจด้วย JWT + sessionVersion อยู่แล้ว)
  }
  return { ok: true, sid };
};

const revoke = async (filter, by = "") => {
  const docs = await LoginSession.find({ ...filter, revokedAt: null }, { sid: 1 }).lean();
  if (!docs.length) return 0;
  await LoginSession.updateMany({ sid: { $in: docs.map((d) => d.sid) } }, { $set: { revokedAt: new Date(), revokedBy: by } });
  const now = Date.now();
  docs.forEach((d) => cache.set(d.sid, { revoked: true, at: now, touchedAt: now }));
  return docs.length;
};

module.exports = { sidOf, newSid, clientIp, parseUA, recordLogin, touch, revoke };
