/**
 * ESLint ของฝั่ง server — เดิมโปรเจกต์นี้ไม่มีอะไรตรวจโค้ดเลย (ฝั่ง frontend บังคับ 0 warning
 * ตอน build อยู่แล้ว ฝั่งนี้จึงตามมาให้เท่ากัน)
 *
 * รอบแรกที่เปิดใช้ เจอของจริง 3 อย่างที่ syntax check จับไม่ได้:
 *   • routes/product.js — catch (err) แต่ข้างในอ้าง `error` ที่ไม่มีอยู่ → โยน ReferenceError ซ้อน
 *     ทำให้ res.status(500) ไม่เคยถูกเรียก request ค้างจนหมดเวลา
 *   • middleware/auth.js + checkFile.js — `module.exports = ชื่อ = async (...)` สร้าง global
 *     โดยไม่ตั้งใจ
 *   • routes/file.js — โหลด archiver ทิ้งไว้ตอนบูตโดยไม่มีใครใช้ (แถมเป็น race condition)
 */
module.exports = {
  root: true,
  env: {
    node: true,
    es2022: true,
  },
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: "script", // CommonJS (require/module.exports) ทั้งโปรเจกต์
  },
  extends: "eslint:recommended",
  rules: {
    "no-unused-vars": [
      "warn",
      {
        args: "after-used",
        // middleware ของ Express ที่เป็น error handler ต้องรับ 4 พารามิเตอร์เสมอ (err, req, res, next)
        // ถึงจะไม่ได้เรียก next() ก็ตาม — ไม่งั้น Express จะไม่รู้ว่าเป็น error handler
        argsIgnorePattern: "^_|^next$",
        // ตัวแปรใน catch(...) ที่ไม่ได้ใช้ ไม่ต้องเตือน (บางที่ catch ไว้เพื่อกลืน error โดยตั้งใจ)
        caughtErrors: "none",
        // ✅ รองรับสำนวน `const { _id, password, ...safe } = user` ที่ destructure ออกมาเพื่อ
        // "ตัดฟิลด์ทิ้ง" ไม่ใช่เพื่อใช้งาน — เป็นวิธีที่ปลอดภัยที่สุดในการกันรหัสผ่านหลุดออก API
        // ถ้าไม่เปิดตัวนี้ ESLint จะเตือนโค้ดที่เขียนถูกอยู่แล้ว แล้วคนจะไปแก้ให้ผิดแทน
        ignoreRestSiblings: true,
      },
    ],
    // ฝั่ง server ใช้ console เป็น log จริง ไม่ใช่ของลืมทิ้ง
    "no-console": "off",
    "no-empty": ["warn", { allowEmptyCatch: true }],
  },
};
