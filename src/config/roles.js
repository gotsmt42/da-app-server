/**
 * roles.js — แหล่งความจริงเดียวเรื่อง "ใครทำอะไรได้" ของทั้งระบบ
 *
 * 🐛 ปัญหาที่แก้: เดิม `role` เป็น String อิสระ (models/User.js) ไม่มีรายการค่าที่ถูกต้องอยู่ที่ไหนเลย
 * และการเช็คสิทธิ์เขียนสดกระจายอยู่ ~40 จุดทั้งสองฝั่ง เช่น `["admin","manager"].includes(role)`
 * ผลคือ role ใหม่ที่ไม่ได้ถูกเติมเข้าไปในลิสต์ไหน จะ "ถูกปฏิเสธเงียบๆ" — ไม่มี error ให้เห็น
 * มีแค่เมนูที่หายไปหรือหน้าที่เด้งกลับ dashboard ซึ่งไล่หาสาเหตุยากมากเพราะไม่รู้ว่าต้องไปดูจุดไหนบ้าง
 *
 * ✅ วิธีคิดใหม่: โค้ดที่ไหนก็ตาม "ห้ามถามว่าเป็น role อะไร" ให้ถามว่า "ทำสิ่งนี้ได้ไหม" (capability)
 * แทน — เพิ่มแผนกใหม่ในอนาคตจึงแก้ที่ไฟล์นี้ไฟล์เดียว ไม่ต้องไล่ทั้ง codebase อีก
 *
 * ⚠️ ไฟล์นี้มีคู่แฝดฝั่งหน้าจอที่ src/shared/utils/roles.js (da-app) — ตารางสิทธิ์ต้องตรงกันเป๊ะ
 * ถ้าแก้ที่นี่ต้องแก้อีกฝั่งด้วยเสมอ (ทำตามแบบแผนเดิมของโปรเจกต์ที่ contractRounds/contractVisits
 * และ OverdueReminder ใช้อยู่: ตรรกะเล็กๆ ที่ต้องใช้ทั้งสองฝั่ง ก๊อปได้ แต่ห้ามให้ต่างกัน)
 * ⚠️ ฝั่งหน้าจอใช้ "ซ่อนเมนู/ปุ่ม" เท่านั้น ขอบเขตความปลอดภัยจริงอยู่ที่ฝั่ง server เสมอ
 */

const ROLES = {
  ADMIN: "admin",
  MANAGER: "manager",
  TECHNICIAN: "technician",
  SALE: "sale",
  USER: "user",
};

const ALL_ROLES = Object.values(ROLES);

/** ชื่อภาษาไทยสำหรับแสดงผล — ทั้งแอปเป็นภาษาไทย ห้ามโชว์ค่าดิบอย่าง "technician" ให้ผู้ใช้เห็น */
const ROLE_LABEL = {
  [ROLES.ADMIN]: "แอดมิน",
  [ROLES.MANAGER]: "ผู้จัดการ",
  [ROLES.TECHNICIAN]: "ช่าง",
  [ROLES.SALE]: "เซล",
  [ROLES.USER]: "ผู้ใช้ทั่วไป",
};

/**
 * แผนก — คนละแนวคิดกับ role
 * role = "ระดับสิทธิ์" · department = "สายงานที่สังกัด"
 * ✅ มีไว้เพื่อให้ระบบใบมอบหมายงาน (Dispatch) ขยายไปแผนกอื่นได้โดยไม่ต้องแก้โครงสร้าง —
 * เพิ่มแผนกใหม่ = เพิ่มค่าตรงนี้ + ผูก role ใหม่เข้ากับแผนกนั้น
 */
const DEPARTMENT = {
  SERVICE: "service", // ช่าง/บริการหน้างาน
  SALES: "sales",     // ฝ่ายขาย
};

const DEPARTMENT_LABEL = {
  [DEPARTMENT.SERVICE]: "ฝ่ายบริการ",
  [DEPARTMENT.SALES]: "ฝ่ายขาย",
};

// admin/manager/user ไม่สังกัดแผนกไหนโดยเฉพาะ (คุมภาพรวมทั้งหมด) จึงเป็น null
const ROLE_DEPARTMENT = {
  [ROLES.TECHNICIAN]: DEPARTMENT.SERVICE,
  [ROLES.SALE]: DEPARTMENT.SALES,
};

/**
 * ── ตารางสิทธิ์ ────────────────────────────────────────────────────────────
 * ⚠️ ค่าที่เขียนไว้ตรงนี้ "ต้องตรงกับพฤติกรรมเดิมของระบบเป๊ะๆ" สำหรับ 4 role เดิม —
 * งานนี้คือการรวมศูนย์การเช็คสิทธิ์ ไม่ใช่การเปลี่ยนสิทธิ์ใคร ส่วน SALE เป็นของใหม่ล้วน
 * (ถ้าเผลอเปลี่ยนสิทธิ์เดิมไปด้วย จะกลายเป็นบั๊กที่โทษไม่ถูกว่ามาจากการรวมศูนย์หรือจาก role ใหม่)
 * ตรวจด้วย `npm run check:perms` ซึ่งเทียบกับ snapshot ที่คาดไว้
 */
const CAPABILITIES = {
  /** จัดการระบบทั้งหมด (ทะเบียนสินค้า/ประเภทงาน/ผู้ใช้) — เดิมคือ AdminRoute */
  manageAll: [ROLES.ADMIN],

  /** อนุมัติงาน / อนุมัติคำขอปิดงาน */
  approveJobs: [ROLES.ADMIN, ROLES.MANAGER],

  /** เห็นงานทุกงานในระบบ (ไม่ถูกกรองเหลือแค่งานตัวเอง) */
  viewAllJobs: [ROLES.ADMIN, ROLES.MANAGER],

  /**
   * แก้/ลบงานของคนอื่น และแก้งานที่ปิดไปแล้ว — "สิทธิ์หัวหน้า" ที่ข้ามข้อจำกัดความเป็นเจ้าของ
   * ⚠️ แยกจาก viewAllJobs โดยตั้งใจ: "เห็นทุกงาน" กับ "แก้ทุกงาน" เป็นคนละเรื่อง และมีโอกาสสูงที่
   * แผนกใหม่ในอนาคต (เช่น หัวหน้าเซล) จะได้อย่างแรกแต่ไม่ได้อย่างหลัง
   */
  editAnyJob: [ROLES.ADMIN, ROLES.MANAGER],

  /**
   * แก้ข้อมูลในหน้า "การดำเนินงาน" (สถานะเอกสาร/ไฟล์แนบ ฯลฯ)
   * ⚠️ ชุด role แปลกกว่าตัวอื่นโดยตั้งใจ: มี user แต่ "ไม่มี technician" — เป็นพฤติกรรมเดิมของ
   * OperationBoard.js ที่คงไว้เป๊ะ ไม่ได้แก้ไปพร้อมกับการรวมศูนย์สิทธิ์ครั้งนี้
   * (ถ้าจะแก้ให้ช่างแก้ได้ ต้องเป็นการตัดสินใจแยกต่างหากที่ตั้งใจ ไม่ใช่ผลข้างเคียง)
   */
  editOperation: [ROLES.ADMIN, ROLES.MANAGER, ROLES.USER],

  /** เข้าหน้าติดตามใบเสนอราคา — ⚠️ ไม่รวม user ตามพฤติกรรมเดิมของ QuotationTracking.js */
  // ⚠️ ฝ่ายขายถูกตัดออกตามที่ผู้ใช้สั่ง — การติดตามใบเสนอราคาในระบบนี้ผูกกับ "งานของช่าง"
  // (ใบเสนอราคาของงานที่ลงตารางแล้ว) ไม่ใช่ดีลที่เซลกำลังปิด เซลเปิดเข้าไปก็ไม่มีของตัวเอง
  viewQuotations: [ROLES.ADMIN, ROLES.MANAGER, ROLES.TECHNICIAN],

  /** แก้/ลบทะเบียนเอกสารที่ระบบออก (ใบส่งของ ฯลฯ) */
  editDocuments: [ROLES.ADMIN, ROLES.MANAGER],

  /** เข้าหน้าการเงิน/ใบเสนอราคาได้ (ขอบเขตข้อมูลกรองที่ server อีกชั้น) */
  // ⚠️ ฝ่ายขายถูกตัดออก — หน้าการเงินคือการวางบิล/รับเงินของงานช่าง ไม่ใช่ยอดขายของเซล
  viewFinance: [ROLES.ADMIN, ROLES.MANAGER, ROLES.TECHNICIAN, ROLES.USER],

  /** แก้ข้อมูลการเงินระดับสัญญา (มูลค่างาน/จำนวนครั้ง) */
  editFinance: [ROLES.ADMIN, ROLES.MANAGER],

  /** เข้าหน้า "ภาพรวมงาน" (/contracts) */
  viewContracts: [ROLES.ADMIN, ROLES.MANAGER, ROLES.TECHNICIAN],

  /** แก้ข้อมูลสัญญาในหน้าภาพรวมงาน */
  editContracts: [ROLES.ADMIN, ROLES.MANAGER],

  /** จัดการข้อมูลหลัก (ลูกค้า/พนักงาน) */
  manageMasterData: [ROLES.ADMIN, ROLES.MANAGER],

  // ── ฝ่ายขาย ───────────────────────────────────────────────────────────
  /** สร้าง/แก้ ดีลและนัดหมายของฝ่ายขาย */
  createSalesPlan: [ROLES.ADMIN, ROLES.MANAGER, ROLES.SALE],

  /** เห็นท่อขายของทุกคน (เซลเห็นเฉพาะของตัวเอง — กรองที่ server) */
  viewAllSales: [ROLES.ADMIN, ROLES.MANAGER],

  // ── ใบมอบหมายงานข้ามแผนก ─────────────────────────────────────────────
  /** ส่งคำขอมอบหมายงานให้แผนกอื่น */
  requestDispatch: [ROLES.ADMIN, ROLES.MANAGER, ROLES.SALE],

  /** มอบหมายใบสั่งงานให้คน = จ่ายงาน */
  assignDispatch: [ROLES.ADMIN, ROLES.MANAGER],

  /** เป็นผู้รับงานได้ (ขยายเพิ่มเมื่อมีแผนกใหม่) */
  receiveDispatch: [ROLES.TECHNICIAN],

  /**
   * เปิดดู "ตารางงานช่าง" ได้ทั้งแผนก แม้ตัวเองไม่ได้อยู่ในงานเลย — อ่านอย่างเดียวเท่านั้น
   *
   * ✅ เซลต้องรู้ว่าช่างว่างวันไหน/ไปที่ไหนอยู่ ก่อนจะไปรับปากลูกค้าเรื่องวันเข้างาน
   * ⚠️ นี่คือสิทธิ์ "ดู" ล้วนๆ ไม่ได้ให้สิทธิ์เขียนใดๆ ตามมา — การแก้งานยังผ่านด่านเดิมทุกประการ
   * (PUT /:id ต้องเป็น editAnyJob / เจ้าของงาน / ผู้ถูกมอบหมาย ไม่งั้น 403) เซลไม่เข้าเงื่อนไขไหนเลย
   * ⚠️ admin/manager มีอยู่แล้วโดยปริยาย (เห็นฝ่ายบริการเป็นค่าเริ่มต้น) ใส่ไว้เพื่อให้ตารางอ่านแล้ว
   * ตอบคำถาม "ใครดูตารางช่างได้บ้าง" ได้ครบในบรรทัดเดียว
   */
  viewServiceCalendar: [ROLES.ADMIN, ROLES.MANAGER, ROLES.SALE],
};

const ALL_CAPABILITIES = Object.keys(CAPABILITIES);

/**
 * รายชื่อ role ที่เป็น "หัวหน้า" — ใช้เป็น **ผู้รับแจ้งเตือน** (sendPushToRoles) เท่านั้น
 * ⚠️ คนละเรื่องกับ CAPABILITIES โดยตั้งใจ: อันนั้นตอบว่า "ทำได้ไหม" อันนี้ตอบว่า "ส่งหาใคร"
 * ถ้าเอามาปนกันจะเกิดกรณีที่เพิ่มสิทธิ์ให้ role ใหม่แล้วมันได้รับแจ้งเตือนพ่วงไปด้วยโดยไม่ตั้งใจ
 */
const SUPERVISOR_ROLES = [ROLES.ADMIN, ROLES.MANAGER];

/**
 * รับได้ทั้ง user object ({ role }), req.user, หรือสตริง role ตรงๆ
 * ⚠️ ต้อง toLowerCase เสมอ — ข้อมูลเดิมในฐานข้อมูลถูกกรอกด้วยมือผ่านหน้าจัดการผู้ใช้
 * (โค้ดเดิมทั่วแอปก็ทำ .toLowerCase() ทุกจุดด้วยเหตุผลเดียวกัน)
 */
const normalizeRole = (who) => {
  const raw = typeof who === "string" ? who : who?.role;
  return String(raw || "").trim().toLowerCase();
};

/**
 * ✅ ตัวเดียวที่โค้ดที่อื่นควรเรียก
 * @param {object|string} who   user object / req.user / สตริง role
 * @param {string} capability   ชื่อจาก CAPABILITIES
 */
const can = (who, capability) => {
  const allowed = CAPABILITIES[capability];
  // ⚠️ พิมพ์ชื่อสิทธิ์ผิด = ปฏิเสธเสมอ (ปลอดภัยไว้ก่อน) แต่ต้องส่งเสียงดังพอให้เห็นตอน dev
  // ไม่งั้นจะกลายเป็นบั๊กเงียบแบบเดียวกับที่ไฟล์นี้ตั้งใจจะกำจัด
  if (!allowed) {
    console.error(`❌ can(): ไม่รู้จักสิทธิ์ "${capability}" — ตรวจชื่อใน src/config/roles.js`);
    return false;
  }
  return allowed.includes(normalizeRole(who));
};

/** แผนกที่ role นี้สังกัด (null = ไม่ผูกแผนกใดเป็นพิเศษ) */
const departmentOf = (who) => ROLE_DEPARTMENT[normalizeRole(who)] || null;

const isRole = (who, ...roles) => roles.map((r) => String(r).toLowerCase()).includes(normalizeRole(who));

/** ทางลัดที่ใช้บ่อยที่สุดในระบบเดิม — มีไว้ให้การย้ายโค้ดเก่าอ่านง่ายขึ้น */
const isAdminOrManager = (who) => isRole(who, ROLES.ADMIN, ROLES.MANAGER);

/**
 * Express middleware — กันทั้ง route ด้วยสิทธิ์เดียว
 * ⚠️ ต้องวางหลัง verifyToken เสมอ (ต้องมี req.user ก่อน)
 */
const requireCap = (capability) => (req, res, next) => {
  if (!req.user) return res.status(401).json({ message: "ไม่ได้เข้าสู่ระบบ" });
  if (!can(req.user, capability)) {
    return res.status(403).json({ message: "คุณไม่มีสิทธิ์ใช้งานส่วนนี้" });
  }
  next();
};

module.exports = {
  ROLES,
  ALL_ROLES,
  ROLE_LABEL,
  DEPARTMENT,
  DEPARTMENT_LABEL,
  ROLE_DEPARTMENT,
  CAPABILITIES,
  ALL_CAPABILITIES,
  SUPERVISOR_ROLES,
  normalizeRole,
  can,
  departmentOf,
  isRole,
  isAdminOrManager,
  requireCap,
};
