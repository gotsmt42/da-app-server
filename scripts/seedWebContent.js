/**
 * ใส่เนื้อหาตั้งต้นของเว็บไซต์บริษัทลงฐานข้อมูล (ครั้งแรกครั้งเดียว)
 *
 *   node scripts/seedWebContent.js            ใส่เฉพาะหมวดที่ยังว่าง
 *   node scripts/seedWebContent.js --dry-run  ดูว่าจะใส่อะไรบ้าง โดยไม่เขียนจริง
 *
 * ⚠️ ไม่ทับข้อมูลเดิมเด็ดขาด — หมวดไหนมีข้อมูลแล้วแม้แต่รายการเดียว จะข้ามทั้งหมวด
 *    (รันซ้ำกี่ครั้งก็ปลอดภัย ไม่มีทางลบสิ่งที่ผู้ดูแลแก้ไว้แล้ว)
 * ⚠️ สินค้าลงเป็น "ฉบับร่าง" ทั้งหมด — ยังไม่มีรูป และบริษัทกำหนดว่าสินค้าต้องมีรูปก่อนเผยแพร่
 *    ผู้ดูแลเพิ่มรูปแล้วกดเผยแพร่ทีละรายการในแอป
 * ⚠️ ไม่มีผลงานตั้งต้น — ผลงานต้องเป็นของจริงที่บริษัททำเท่านั้น
 */
require("dotenv").config();
const path = require("path");
const fs = require("fs");

const mongoose = require("../src/db");
const WebProduct = require("../src/models/WebProduct");
const WebBrand = require("../src/models/WebBrand");
const WebArticle = require("../src/models/WebArticle");

const DRY = process.argv.includes("--dry-run");
const seed = JSON.parse(fs.readFileSync(path.join(__dirname, "../src/seed/web-defaults.json"), "utf8"));
const by = { userId: "", name: "ข้อมูลตั้งต้น" };

async function fill(Model, label, docs) {
  const existing = await Model.countDocuments();
  if (existing > 0) {
    console.log(`⏭️  ${label}: มีอยู่แล้ว ${existing} รายการ — ข้าม (ไม่ทับของเดิม)`);
    return;
  }
  if (DRY) {
    console.log(`🔍 ${label}: จะใส่ ${docs.length} รายการ`);
    return;
  }
  await Model.insertMany(docs, { ordered: true });
  console.log(`✅ ${label}: ใส่ ${docs.length} รายการ`);
}

(async () => {
  await mongoose.connection.asPromise();
  await fill(WebBrand, "ยี่ห้อ", seed.brands.map((b) => ({ ...b, status: "published", updatedBy: by })));
  await fill(WebArticle, "บทความ", seed.articles.map((a) => ({ ...a, publishedAt: new Date(a.publishedAt), status: "published", updatedBy: by })));
  await fill(WebProduct, "สินค้า (ฉบับร่าง รอเพิ่มรูป)", seed.products.map((p) => ({ ...p, status: "draft", updatedBy: by })));
  await mongoose.disconnect();
})().catch(async (err) => {
  console.error("❌ ใส่ข้อมูลตั้งต้นไม่สำเร็จ:", err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
