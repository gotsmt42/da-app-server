/**
 * ตรวจว่าตัวแปร env ที่จำเป็นมาครบไหม "ตั้งแต่วินาทีแรกที่บูต" แล้วบอกให้ชัดว่าขาดตัวไหน
 *
 * 🐛 ปัญหาที่แก้ (เจอตอน deploy จริงบน Render): ถ้า VAPID_* ไม่ถูกตั้ง เซิร์ฟเวอร์จะตายด้วย
 *
 *     Error: No subject set in vapidDetails.subject.
 *       at Object.validateSubject (node_modules/web-push/src/vapid-helper.js:70:11)
 *       at Object.<anonymous> (src/services/PushNotify.js:5:9)
 *
 * ซึ่งอ่านแล้วไม่มีทางรู้เลยว่า "ต้องไปตั้งตัวแปรชื่ออะไรที่ไหน" — ต้องไล่เปิดโค้ดของ web-push
 * แล้วยิ่งไปเจอตอน deploy บน production ที่ restart วนซ้ำๆ ยิ่งเสียเวลา
 *
 * ตอนนี้จะได้ข้อความที่บอกครบว่าขาดอะไรบ้าง และไปตั้งที่ไหน ก่อนที่โมดูลอื่นจะถูกโหลดด้วยซ้ำ
 *
 * ⚠️ ตั้งใจให้ "ล้มตั้งแต่บูต" ไม่ใช่ปล่อยให้รันแบบพิการ — ถ้าปล่อยผ่าน ระบบจะขึ้นปกติแต่แจ้งเตือน
 * ไม่ทำงานโดยไม่มีใครรู้ ซึ่งแย่กว่าการที่ deploy ไม่ผ่านแล้วรีบไปแก้
 */

// ตัวที่ขาดไม่ได้ — ระบบทำงานไม่ได้จริงถ้าไม่มี
const REQUIRED = {
  APP_DATABASE: "connection string ของ MongoDB",
  APP_SECRET: "กุญแจเซ็น JWT (ถ้าไม่มี = ล็อกอินไม่ได้)",
  VAPID_SUBJECT: "อีเมลเจ้าของระบบสำหรับ Web Push เช่น mailto:you@example.com",
  VAPID_PUBLIC_KEY: "กุญแจสาธารณะ Web Push (ต้องตรงกับ REACT_APP_VAPID_PUBLIC_KEY ฝั่งหน้าเว็บ)",
  VAPID_PRIVATE_KEY: "กุญแจส่วนตัว Web Push",
  CLOUDINARY_CLOUD_NAME: "ชื่อ cloud ของ Cloudinary",
  CLOUDINARY_API_KEY: "API key ของ Cloudinary",
  CLOUDINARY_API_SECRET: "API secret ของ Cloudinary",
};

// ตัวที่ไม่มีก็ได้ — แค่ปิดฟีเจอร์นั้นไป ระบบส่วนอื่นทำงานปกติ
const OPTIONAL = {
  ANTHROPIC_API_KEY: 'ฟีเจอร์ "สแกนใบวางบิลอัตโนมัติ" (ไม่มีก็ได้ แค่ปุ่มไม่โผล่)',
};

function assertRequiredEnv() {
  const missing = Object.keys(REQUIRED).filter((k) => !process.env[k] || !String(process.env[k]).trim());

  if (missing.length > 0) {
    const lines = [
      "",
      "❌ เซิร์ฟเวอร์เริ่มไม่ได้ — ตัวแปร env ที่จำเป็นขาดไป " + missing.length + " ตัว:",
      "",
      ...missing.map((k) => `   • ${k}\n     ${REQUIRED[k]}`),
      "",
      "   ตั้งค่าที่ไหน:",
      "     • บนเครื่อง — ไฟล์ .env ที่รากโปรเจกต์",
      "     • บน Render — Environment → Secret Files (ชื่อไฟล์ .env) หรือ Environment Variables",
      "",
      "   ดูรายละเอียดทั้งหมดที่หัวข้อ \"ตัวแปร env ที่ต้องมี\" ใน README.md",
      "",
    ];
    console.error(lines.join("\n"));
    // ⚠️ ออกด้วย exit code 1 เพื่อให้ Render/CI รู้ว่า deploy ไม่สำเร็จ ไม่ใช่แค่ปิดตัวเงียบๆ
    process.exit(1);
  }

  // 🐛 ดักเคสที่เคยเกิดจริง: อัปไฟล์ .env ของเครื่อง dev ขึ้น production ทั้งไฟล์ โดยลืมสลับ
  // คอมเมนต์บรรทัด APP_DATABASE — ค่าที่ active อยู่เลยเป็น mongodb://127.0.0.1:27017/...
  // ซึ่งบนเซิร์ฟเวอร์คือ "ตัวมันเอง" ที่ไม่มี MongoDB อยู่
  //
  // อาการที่ได้คือหลอกมาก: เซิร์ฟเวอร์บูตขึ้นปกติ ทุก endpoint ที่ไม่แตะ DB ตอบ 200 ล็อกอินค้างอยู่ได้
  // แต่ทุก API ที่อ่านข้อมูลตอบ 500 หมด (mongoose รอ buffer 10 วิ แล้วโยน error) — ไล่หาสาเหตุนาน
  // เพราะดูเผินๆ เหมือนโค้ดพัง ทั้งที่จริงคือชี้ฐานข้อมูลผิดที่
  const isProd = process.env.NODE_ENV === "production";
  const db = process.env.APP_DATABASE || "";
  if (isProd && /(localhost|127\.0\.0\.1|::1)/.test(db)) {
    console.error("");
    console.error("❌ APP_DATABASE ชี้ไปที่เครื่องตัวเอง (localhost) ทั้งที่รันบน production");
    console.error(`   ค่าที่ตั้งอยู่: ${db.replace(/\/\/[^@]*@/, "//***:***@")}`);
    console.error("");
    console.error("   มักเกิดจากอัปไฟล์ .env ของเครื่อง dev ขึ้นไปทั้งไฟล์ แล้วลืมสลับคอมเมนต์");
    console.error("   บรรทัด APP_DATABASE ให้เป็นตัวของ production (mongodb+srv://...)");
    console.error("");
    process.exit(1);
  }

  const missingOptional = Object.keys(OPTIONAL).filter((k) => !process.env[k]);
  missingOptional.forEach((k) => console.warn(`⚠️  ไม่ได้ตั้ง ${k} — ${OPTIONAL[k]}`));
}

module.exports = { assertRequiredEnv, REQUIRED, OPTIONAL };
