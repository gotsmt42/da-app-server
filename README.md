# da-app-server

API server ของ DA-APP (ระบบจัดการงานบริการภาคสนาม) — Node.js + Express + MongoDB (Mongoose)

## เริ่มใช้งาน

```bash
npm install        # ใช้ได้เลย ไม่ต้องใส่ flag (มี .npmrc จัดการให้ — ดูหัวข้อด้านล่าง)
npm run dev        # dev — auto-reload ด้วย nodemon
npm start          # production — node ล้วน ไม่มี nodemon
npm run lint       # ESLint (มี warning แม้แต่ตัวเดียวก็ไม่ผ่าน)
npm test           # lint + ตรวจตาราง route (ไม่ต้องใช้ฐานข้อมูล)
```

> ⚠️ **`npm start` เปลี่ยนความหมายแล้ว** — เดิมมันคือ `nodemon index.js` ซึ่งแปลว่า production
> รันเครื่องมือ dev ตอนนี้ `start` = `node index.js` ตามมาตรฐาน **ถ้าจะพัฒนาให้ใช้ `npm run dev`**

ต้องมีไฟล์ `.env` ที่รากโปรเจกต์ — ดูรายชื่อตัวแปรทั้งหมดที่หัวข้อ
[ตัวแปร env ที่ต้องมี](#ตัวแปร-env-ที่ต้องมี) ⚠️ ไฟล์นี้ **ห้าม commit ขึ้น git**

## โครงสร้าง

ซอร์สทั้งหมดอยู่ใน `src/` แยกออกจาก config, สคริปต์, และไฟล์อัปโหลดที่ราก project

ภายใน `src/` จัดแบบ **layer-based** ซึ่งเป็นมาตรฐานของ Express API — ต่างจากฝั่ง frontend ที่จัดแบบ
feature-based โดยตั้งใจ เพราะที่นี่ `models/` ถูกใช้ข้ามโดเมนกันหนักมาก (โดยเฉพาะ `Events`)
การแยกตาม feature จะทำให้ต้อง require ข้ามโฟลเดอร์ไปมามากกว่าเดิม

```
index.js              จุดรัน — dotenv → listen → ตั้งเวลางานประจำวัน (บางที่สุด)
                      ⚠️ ห้ามย้าย/เปลี่ยนชื่อ — เป็นปลายทางของ "main" ใน package.json
                         และของ Start Command บน Render (npm start → node index.js)
src/
├── app.js            ประกอบ Express app แล้ว export (ไม่ listen — เอาไปเทสต์ได้)
├── scheduler.js      งานแจ้งเตือนประจำวัน (12:00 น. ทุกวัน)
├── config/
│   ├── paths.js      ⭐ ที่เดียวที่รู้ว่าโฟลเดอร์ asset อยู่ตรงไหน
│   ├── cloudinary.js ตั้งค่า Cloudinary + storage ของ multer
│   └── bootTime.js
├── db/               การเชื่อมต่อ MongoDB (models ทุกตัว require ตัวนี้)
├── models/           Mongoose schema (14 ตัว)
├── routes/
│   ├── index.js      ⭐ รวมการ mount router ทั้งหมดไว้ที่เดียว
│   ├── calendarEvent/  ⭐ /api/events (29 route) แตกจากไฟล์เดียว 2,708 บรรทัด
│   │   ├── index.js      ประกอบ router — ⚠️ core ต้อง register ท้ายสุด
│   │   ├── shared.js     require + helper ที่ทุกหมวดใช้ร่วมกัน
│   │   ├── core.js       CRUD หลักของงาน
│   │   ├── files.js      แนบ/ลบไฟล์ของงาน
│   │   ├── drafts.js     แผนงานล่วงหน้า ↔ งานจริงบนปฏิทิน
│   │   ├── queries.js    มุมมองเฉพาะ + แก้ข้อมูลพื้นฐานหลายงานพร้อมกัน
│   │   ├── workflow.js   ติดตามใบเสนอราคา / จัดหมวด / อนุมัติปิดงาน
│   │   ├── contracts.js  งานสัญญา
│   │   └── billing.js    วางบิล / สแกนใบวางบิล / รับชำระ
│   └── *.js          HTTP endpoint อื่นๆ
├── controllers/      ใช้เฉพาะฝั่ง workOrder
├── middleware/       auth (verifyToken), checkFile, checkInternetConnection, อัปโหลดรูป
├── services/         งานเบื้องหลัง — แจ้งเตือน, push, สแกนใบวางบิล, ตัวตั้งเวลา
└── utils/            ฟังก์ชันบริสุทธิ์ที่ใช้ร่วมกัน

scripts/              คำสั่ง maintenance (รันมือ ไม่ใช่ส่วนของ server)
data/                 ข้อมูลนิ่ง (วันหยุดไทย)
asset/                ไฟล์อัปโหลดที่เก็บบนดิสก์ + รูป default
```

## กติกาที่ควรรักษาไว้

1. **สิทธิ์ตัดสินที่นี่เสมอ** — การซ่อนเมนู/ปุ่มฝั่ง frontend เป็นแค่ UX ไม่ใช่การป้องกัน
   ทุก route ที่แตะข้อมูลต้องเช็คสิทธิ์ของตัวเอง ไม่เชื่อสิ่งที่ client ส่งมา

2. **ตรรกะที่ทั้งสองฝั่งต้องเห็นตรงกัน ต้องเขียนเกณฑ์เดียวกันเป๊ะ**
   เช่น เกณฑ์ "งานค้าง" / "สัญญาเลยกำหนดรอบ" ถูกคำนวณทั้งที่ `services/OverdueReminder.js`
   และที่ `shared/utils/` ฝั่ง frontend — แก้ที่เดียวแล้วไม่แก้อีกที่ ตัวเลขบนหน้าจอกับในแจ้งเตือน
   จะไม่ตรงกัน (มีคอมเมนต์ ⚠️ กำกับไว้ทุกจุดที่จับคู่กัน)

3. **ห้ามใส่ `index: true` ที่ฟิลด์ ถ้าประกาศ `schema.index()` ไว้ท้ายไฟล์แล้ว** — จะได้ index
   ซ้อนกัน 2 ชุดและ Mongoose เตือนทุกครั้งที่บูต

4. **ลำดับการประกาศ route มีผลจริงใน Express** — route ที่เจาะจง (`/contract/merge`,
   `/event-op`, `/drafts`, `/documents`) **ต้องอยู่ก่อน** route ที่เป็นพารามิเตอร์ (`/:id`,
   `/contract/:contractGroupId`) ไม่งั้นตัวหลังจะกลืนตัวแรกไปทั้งหมด

5. **พาธของไฟล์บนดิสก์ ให้ import จาก `src/config/paths.js` เสมอ** — ห้ามเขียน
   `path.join(__dirname, "../asset/...")` เอง (ย้ายไฟล์ทีเดียวก็เพี้ยน) และห้ามใช้พาธแบบ
   relative-to-cwd เช่น `"asset/uploads/images/"` (ขึ้นกับว่าสั่งรันจากโฟลเดอร์ไหน)
   ทั้งสองแบบเป็นบั๊กที่ `node --check` และ ESLint จับไม่ได้

## ตรวจว่า route ครบไหมหลังแก้โครงสร้าง

Express จับคู่ route ตามลำดับที่ mount และ "หายไปเงียบๆ" ได้ถ้า mount ผิด — เวลาแตะโครงสร้าง
route ให้ dump ตารางที่ลงทะเบียนจริงออกมาเทียบก่อน/หลัง:

```js
// __dump.tmp.js (วางที่ราก project แล้วลบทิ้งหลังใช้)
require("dotenv").config();
const app = require("./src/app");
const walk = (stack, p = "") => stack.forEach((l) => {
  if (l.route) Object.keys(l.route.methods).forEach((m) => console.log(m.toUpperCase(), p + l.route.path));
  else if (l.name === "router" && l.handle?.stack) {
    const m = l.regexp.toString().match(/^\/\^\\\/(.*?)\\\/\?\(\?=\\\/\|\$\)\/i?$/);
    walk(l.handle.stack, p + (m ? "/" + m[1].replace(/\\\//g, "/") : ""));
  }
});
walk(app._router.stack); process.exit(0);
```

ปัจจุบันต้องได้ **78 route** ครบทั้ง 13 prefix (`/api/events` มากสุดที่ 29)

แล้วเช็คต่อว่าไม่มี route ไหน "ถูกกลืน" — ตัวที่ประกาศก่อนถ้ารูปแบบครอบคลุม path ของตัวที่ประกาศ
ทีหลัง ตัวหลังจะไม่มีวันถูกเรียกและ **ไม่มี error ให้เห็นเลย**:

```js
const segs = (p) => p.split("/").filter(Boolean);
const shadows = (a, b) => {           // a ประกาศก่อน จะกลืน b ไหม
  const A = segs(a), B = segs(b);
  return A.length === B.length && A.every((s, i) => s.startsWith(":") || s === B[i]);
};
```

คู่ที่ต้องระวังจริงในระบบนี้:

| ตัวที่ต้องมาก่อน | ไม่งั้นจะถูกกลืนโดย |
|---|---|
| `GET /event-op` · `GET /drafts` · `GET /documents` | `GET /:id` |
| `PUT /basic-info` | `PUT /:id` |
| `PUT /contract/merge` | `PUT /contract/:contractGroupId` |

## หมายเหตุเรื่อง install

โปรเจกต์มี `.npmrc` ที่ตั้ง `legacy-peer-deps=true` ไว้ให้แล้ว จึงพิมพ์ `npm install` เปล่าๆ ได้เลย

เหตุผล: `multer-storage-cloudinary@4` ประกาศ peer เป็น `cloudinary@^1.21.0` แต่โปรเจกต์ใช้
`cloudinary@2` (ใช้งานได้จริง เพราะ API ส่วนที่มันเรียกไม่เปลี่ยน) — **ถ้าไม่มี `.npmrc` ทั้ง
`npm install` และ `npm ci` จะล้มด้วย ERESOLVE** ซึ่งแปลว่า build บน Render จะพังด้วย
ทางแก้ระยะยาวคือเลิกใช้ `multer-storage-cloudinary` (เลิกดูแลไปแล้ว) แล้วอัปโหลดผ่าน SDK ของ
Cloudinary ตรงๆ เหมือนที่ `routes/calendarEvent` ทำอยู่

## Deploy บน Render

Service นี้รันบน **Render** (ส่วนหน้าเว็บ `da-app` อยู่บน Vercel คนละที่กัน)

| ตั้งค่าใน Render | ค่าที่ถูกต้อง |
|---|---|
| Build Command | `npm install` |
| Start Command | `npm start` (= `node index.js`) |
| Node version | อ่านจาก `engines.node` ใน package.json (`>=20`) |
| Environment | อัปโหลด `.env` ทั้งไฟล์ผ่าน **Secret Files** (ชื่อไฟล์ `.env`) |

**ทำไมใช้ Secret Files:** โค้ดเรียก `require("dotenv").config()` เฉยๆ ไม่ได้ระบุ path
= อ่านไฟล์ `.env` ที่รากโปรเจกต์ ซึ่งเป็นตำแหน่งที่ Render วาง Secret File ให้พอดี
→ **ไม่ต้องแก้โค้ด และจัดการที่เดียวเหมือนตอนรันบนเครื่อง** ต่างจากเดิมแค่เก็บที่ Render ไม่ใช่ใน git

⚠️ **`.env` ไม่ได้อยู่ใน git อีกต่อไปแล้ว** (เคยอยู่ = connection string ฐานข้อมูลกับกุญแจ JWT
หลุดขึ้น GitHub) — ค่าทั้งหมดต้องมาจาก Render เท่านั้น

## ตัวแปร env ที่ต้องมี

ไม่มีไฟล์ `.env.example` โดยตั้งใจ (ใช้ `.env` ไฟล์เดียวจบ) — รายชื่อที่โค้ดอ่านจริงอยู่ที่นี่
ตรวจซ้ำได้เสมอด้วย:

```bash
grep -rhoE "process\.env\.[A-Z_0-9]+" src/ index.js scripts/ | sort -u
```

| ตัวแปร | จำเป็น | ขาดแล้วเกิดอะไร (ทดสอบจริง ไม่ได้เดา) |
|---|:---:|---|
| `VAPID_PUBLIC_KEY`<br>`VAPID_PRIVATE_KEY`<br>`VAPID_SUBJECT` | ✅ | 🔴 **crash ตั้งแต่บูต** — `No subject set in vapidDetails.subject`<br>(web-push ตรวจตอนโหลดโมดูล ไม่ใช่ตอนส่งแจ้งเตือน)<br>สร้างคู่ใหม่: `npx web-push generate-vapid-keys`<br>⚠️ public key ต้องตรงกับ `REACT_APP_VAPID_PUBLIC_KEY` ฝั่งหน้าเว็บ |
| `APP_SECRET` | ✅ | บูตขึ้นได้ แต่ **ล็อกอินไม่ได้เลย** (`jwt.sign` โยน error)<br>⚠️ เปลี่ยนค่านี้ = เตะผู้ใช้ทุกคนออกจากระบบทันที |
| `APP_DATABASE` | ✅ | บูตขึ้นได้ แต่ทุก request ที่แตะข้อมูลจะค้าง/พัง |
| `CLOUDINARY_CLOUD_NAME`<br>`CLOUDINARY_API_KEY`<br>`CLOUDINARY_API_SECRET` | ✅ | อัปโหลดรูป/ไฟล์ไม่ได้ |
| `ANTHROPIC_API_KEY` | — | ไม่เป็นไร — แค่ปุ่ม "สแกนใบวางบิล" ไม่โผล่ (ตั้งใจออกแบบไว้แบบนั้น) |
| `PORT` · `NODE_ENV` | — | Render กำหนดให้เอง ไม่ต้องตั้ง |

**เคยมีใน `.env` เดิมแต่ไม่มีโค้ดตรงไหนอ่านแล้ว — ลบทิ้งได้:**
`APP_API_URL` · `APP_API_KEY` · `HOLIDAY_API_KEY` (วันหยุดอ่านจาก `data/thai-holidays-2026-2028.json`
แล้ว ไม่ยิง API นอก) · `APP_URL_LINE_NOTIFY` · `APP_TOKEN_LINE_NOTIFY` (`services/LineNotify.js` ถูกลบไปแล้ว)

⚠️ **ชื่อตัวแปรต้องตรงทุกตัวอักษร** — สะกดผิดแล้ว `process.env.X` จะได้ `undefined` เงียบๆ
ไม่มี error บอกเลย

⚠️ **`vercel.json` ที่อยู่ในโปรเจกต์เป็นของเก่าที่ไม่ได้ใช้แล้ว** — Render ไม่อ่านไฟล์นี้เลย
ลบทิ้งได้ (เก็บไว้เฉยๆ ทำให้เข้าใจผิดว่า deploy ที่ Vercel)

⚠️ **ดิสก์ของ Render เป็นแบบชั่วคราว** — ไฟล์ที่ผู้ใช้อัปโหลดลง `asset/uploads/` ตอนรันจริง
**จะหายทุกครั้งที่ deploy ใหม่หรือ service restart** (ยกเว้นจะไปผูก Persistent Disk)
ไฟล์ที่ยังเปิดได้ทุกวันนี้คือ 52 ไฟล์ที่ถูก commit ลง git ไว้ ซึ่งกลับมาพร้อมโค้ดทุกครั้งที่ deploy
👉 ทางแก้ที่ถูกต้องคือให้ทุกการอัปโหลดไปที่ Cloudinary ให้หมด (ตอนนี้ทำแค่บางส่วน)

## คำสั่ง maintenance

```bash
npm run force-logout-all -- --yes     # เตะทุก session ออก (ต้องใส่ --yes ถึงจะทำงานจริง)
npm run backfill-responsible-person   # เติมผู้รับผิดชอบย้อนหลังให้งานเก่า
```
