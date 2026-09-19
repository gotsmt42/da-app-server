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
 *
 * ── คำศัพท์สองคำที่ต้องแยกจากกันให้ขาด (✅ ผู้ใช้สั่ง: "Role คือตำแหน่งในระบบ Rank คือในองค์กร") ──
 *
 *   Role  = ตำแหน่ง "ในระบบ"  → Super Admin / Admin / Member
 *           เก็บที่ user.systemRole · ชื่อเป็นภาษาอังกฤษ เปลี่ยนชื่อไม่ได้ · ให้สิทธิ์ manageAll / manageSystem
 *   Rank  = ตำแหน่ง "ในองค์กร" → กรรมการผู้จัดการ / ผู้จัดการแผนกช่าง / แอดมินช่าง / ช่างเทคนิค ...
 *           เก็บที่ user.role (คีย์เดิม ห้ามเปลี่ยน) · "ชื่อ" เปลี่ยนได้จากหน้าตั้งค่า · ให้สิทธิ์งานทั้งหมดที่เหลือ
 *   ตำแหน่งเฉพาะบุคคล = user.jobTitle — ข้อความอิสระที่พิมพ์ใต้ชื่อในเอกสาร เว้นว่างแล้วใช้ชื่อ Rank
 *           (ห้ามสับสนกับ Rank — ฟิลด์เก่าชื่อ user.rank ยังอ่านได้เพื่อข้อมูลเก่า ดู titleOf)
 */

/**
 * Rank — ตำแหน่งในองค์กร
 * ⚠️ ลำดับในก้อนนี้คือ "มากไปน้อยตามสิทธิ์การใช้งาน" (✅ ผู้ใช้สั่ง) — ALL_ROLES ใช้ลำดับนี้
 * จึงมีผลกับลำดับคอลัมน์ในตารางสิทธิ์ ตัวเลือกตอนเพิ่ม/แก้ผู้ใช้ และรายงานทุกใบ — เพิ่มตำแหน่งใหม่ต้องใส่ให้ถูกที่
 */
const ROLES = {
  /** กรรมการผู้จัดการ — ✅ ผู้ใช้ขอเพิ่ม: ระดับสูงสุดของบริษัท มีทุกสิทธิ์ในระบบ */
  DIRECTOR: "director",
  MANAGER: "manager",
  ADMIN: "admin",
  /** หัวหน้าช่างเทคนิค — ✅ ผู้ใช้ขอเพิ่ม: ตอนนี้ให้สิทธิ์เท่าช่างเทคนิคทุกอย่างก่อน */
  TECH_LEAD: "techlead",
  TECHNICIAN: "technician",
  SALE: "sale",
  USER: "user",
};

const ALL_ROLES = Object.values(ROLES);

/** ชื่อภาษาไทยสำหรับแสดงผล — ทั้งแอปเป็นภาษาไทย ห้ามโชว์ค่าดิบอย่าง "technician" ให้ผู้ใช้เห็น */
const RANK_LABEL = {
  [ROLES.DIRECTOR]: "กรรมการผู้จัดการ",
  [ROLES.ADMIN]: "แอดมินช่าง",
  [ROLES.MANAGER]: "ผู้จัดการแผนกช่าง",
  [ROLES.TECH_LEAD]: "หัวหน้าช่างเทคนิค",
  [ROLES.TECHNICIAN]: "ช่างเทคนิค",
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
  [ROLES.TECH_LEAD]: DEPARTMENT.SERVICE,
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
  /**
   * ⚠️ "manageAll" กับ "manageSystem" ไม่ได้อยู่ในตารางนี้แล้ว — ย้ายไปเป็น "สิทธิ์ในระบบ" (SYSTEM_CAPABILITIES)
   * ✅ ผู้ใช้สั่งให้แยก "สิทธิ์ในระบบ" (ผู้ดูแลระบบ/ผู้ดูแลระบบสูงสุด) ออกจาก "ตำแหน่งในองค์กร"
   * (แอดมินช่าง/ผู้จัดการแผนกช่าง/ช่างเทคนิค ฯลฯ) — ตารางนี้เหลือเฉพาะ "สิ่งที่ตำแหน่งในองค์กรทำได้"
   */

  /** อนุมัติงาน / อนุมัติคำขอปิดงาน */
  approveJobs: [ROLES.ADMIN, ROLES.DIRECTOR, ROLES.MANAGER],

  /** เห็นงานทุกงานในระบบ (ไม่ถูกกรองเหลือแค่งานตัวเอง) */
  viewAllJobs: [ROLES.ADMIN, ROLES.DIRECTOR, ROLES.MANAGER],

  /**
   * แก้/ลบงานของคนอื่น และแก้งานที่ปิดไปแล้ว — "สิทธิ์หัวหน้า" ที่ข้ามข้อจำกัดความเป็นเจ้าของ
   * ⚠️ แยกจาก viewAllJobs โดยตั้งใจ: "เห็นทุกงาน" กับ "แก้ทุกงาน" เป็นคนละเรื่อง และมีโอกาสสูงที่
   * แผนกใหม่ในอนาคต (เช่น หัวหน้าเซล) จะได้อย่างแรกแต่ไม่ได้อย่างหลัง
   */
  editAnyJob: [ROLES.ADMIN, ROLES.DIRECTOR, ROLES.MANAGER],

  /**
   * แก้ข้อมูลในหน้า "การดำเนินงาน" (สถานะเอกสาร/ไฟล์แนบ ฯลฯ)
   * ⚠️ ชุด role แปลกกว่าตัวอื่นโดยตั้งใจ: มี user แต่ "ไม่มี technician" — เป็นพฤติกรรมเดิมของ
   * OperationBoard.js ที่คงไว้เป๊ะ ไม่ได้แก้ไปพร้อมกับการรวมศูนย์สิทธิ์ครั้งนี้
   * (ถ้าจะแก้ให้ช่างแก้ได้ ต้องเป็นการตัดสินใจแยกต่างหากที่ตั้งใจ ไม่ใช่ผลข้างเคียง)
   */
  editOperation: [ROLES.ADMIN, ROLES.DIRECTOR, ROLES.MANAGER, ROLES.USER],

  /** เข้าหน้าติดตามใบเสนอราคา — ⚠️ ไม่รวม user ตามพฤติกรรมเดิมของ QuotationTracking.js */
  // ⚠️ ฝ่ายขายถูกตัดออกตามที่ผู้ใช้สั่ง — การติดตามใบเสนอราคาในระบบนี้ผูกกับ "งานของช่าง"
  // (ใบเสนอราคาของงานที่ลงตารางแล้ว) ไม่ใช่ดีลที่เซลกำลังปิด เซลเปิดเข้าไปก็ไม่มีของตัวเอง
  viewQuotations: [ROLES.ADMIN, ROLES.DIRECTOR, ROLES.MANAGER, ROLES.TECHNICIAN, ROLES.TECH_LEAD],

  /**
   * เปิดเมนู "เอกสาร" ได้ (ไฟล์แนบของงาน + ทะเบียนเอกสารที่ออก)
   * 🐛 ที่แก้: เดิมหน้า DocumentsHub เช็คตรงๆว่า "เป็นเซลไหม" — ติ๊กในตารางสิทธิ์ก็ไม่มีผล
   * ทำให้ผู้ดูแลระบบตั้งค่าอย่างไรก็ไม่เกิดอะไรขึ้น — ย้ายมาเป็นสิทธิ์จริงที่ปรับได้
   */
  viewDocuments: [ROLES.ADMIN, ROLES.DIRECTOR, ROLES.MANAGER, ROLES.TECH_LEAD, ROLES.TECHNICIAN, ROLES.USER],

  /** แก้/ลบทะเบียนเอกสารที่ระบบออก (ใบส่งของ ฯลฯ) */
  editDocuments: [ROLES.ADMIN, ROLES.DIRECTOR, ROLES.MANAGER],

  /** เข้าหน้าการเงิน/ใบเสนอราคาได้ (ขอบเขตข้อมูลกรองที่ server อีกชั้น) */
  // ⚠️ ฝ่ายขายถูกตัดออก — หน้าการเงินคือการวางบิล/รับเงินของงานช่าง ไม่ใช่ยอดขายของเซล
  viewFinance: [ROLES.ADMIN, ROLES.DIRECTOR, ROLES.MANAGER, ROLES.TECHNICIAN, ROLES.TECH_LEAD, ROLES.USER],

  /** แก้ข้อมูลการเงินระดับสัญญา (มูลค่างาน/จำนวนครั้ง) */
  editFinance: [ROLES.ADMIN, ROLES.DIRECTOR, ROLES.MANAGER],

  /** เข้าหน้า "ภาพรวมงาน" (/contracts) */
  viewContracts: [ROLES.ADMIN, ROLES.DIRECTOR, ROLES.MANAGER, ROLES.TECHNICIAN, ROLES.TECH_LEAD],

  /** แก้ข้อมูลสัญญาในหน้าภาพรวมงาน */
  editContracts: [ROLES.ADMIN, ROLES.DIRECTOR, ROLES.MANAGER],

  /** จัดการข้อมูลหลัก (ลูกค้า/พนักงาน) */
  manageMasterData: [ROLES.ADMIN, ROLES.DIRECTOR, ROLES.MANAGER],

  // ── ฝ่ายขาย ───────────────────────────────────────────────────────────
  /** สร้าง/แก้ ดีลและนัดหมายของฝ่ายขาย */
  createSalesPlan: [ROLES.ADMIN, ROLES.DIRECTOR, ROLES.MANAGER, ROLES.SALE],

  /** เห็นท่อขายของทุกคน (เซลเห็นเฉพาะของตัวเอง — กรองที่ server) */
  viewAllSales: [ROLES.ADMIN, ROLES.DIRECTOR, ROLES.MANAGER],

  // ── ใบมอบหมายงานข้ามแผนก ─────────────────────────────────────────────
  /** ส่งคำขอมอบหมายงานให้แผนกอื่น */
  requestDispatch: [ROLES.ADMIN, ROLES.DIRECTOR, ROLES.MANAGER, ROLES.SALE],

  /** มอบหมายใบสั่งงานให้คน = จ่ายงาน */
  assignDispatch: [ROLES.ADMIN, ROLES.DIRECTOR, ROLES.MANAGER],

  /** เป็นผู้รับงานได้ (ขยายเพิ่มเมื่อมีแผนกใหม่) */
  receiveDispatch: [ROLES.TECHNICIAN, ROLES.TECH_LEAD],

  /**
   * เปิดดู "ตารางงานช่าง" ได้ทั้งแผนก แม้ตัวเองไม่ได้อยู่ในงานเลย — อ่านอย่างเดียวเท่านั้น
   *
   * ✅ เซลต้องรู้ว่าช่างว่างวันไหน/ไปที่ไหนอยู่ ก่อนจะไปรับปากลูกค้าเรื่องวันเข้างาน
   * ⚠️ นี่คือสิทธิ์ "ดู" ล้วนๆ ไม่ได้ให้สิทธิ์เขียนใดๆ ตามมา — การแก้งานยังผ่านด่านเดิมทุกประการ
   * (PUT /:id ต้องเป็น editAnyJob / เจ้าของงาน / ผู้ถูกมอบหมาย ไม่งั้น 403) เซลไม่เข้าเงื่อนไขไหนเลย
   * ⚠️ admin/manager มีอยู่แล้วโดยปริยาย (เห็นฝ่ายบริการเป็นค่าเริ่มต้น) ใส่ไว้เพื่อให้ตารางอ่านแล้ว
   * ตอบคำถาม "ใครดูตารางช่างได้บ้าง" ได้ครบในบรรทัดเดียว
   */
  viewServiceCalendar: [ROLES.ADMIN, ROLES.DIRECTOR, ROLES.MANAGER, ROLES.SALE],

  // ── เบิกเงินล่วงหน้า (Advance) / เคลียร์ค่าใช้จ่าย (Claim) ───────────────
  /** ออกใบ Advance / ใบเคลมของตัวเองได้ */
  requestExpense: [ROLES.ADMIN, ROLES.DIRECTOR, ROLES.MANAGER, ROLES.TECHNICIAN, ROLES.TECH_LEAD],

  /**
   * ── ลำดับการเบิกค่าใช้จ่าย 3 ส่วน (ใช้เหมือนกันทั้งใบ Advance / ใบเคลม / ใบสำรองจ่าย) ──
   * ✅ ผู้ใช้สั่ง "จัดการเรียงลำดับการจัดการการเบิกค่าใช้จ่ายใหม่":
   *
   *   ส่วนที่ 1  ส่งขอเบิก       ทุกสิทธิ์ที่เบิกได้ (รวมผู้จัดการ/กรรมการ)  ลายเซ็นช่อง "ผู้เบิกค่าใช้จ่าย"
   *   ส่วนที่ 2  ตรวจสอบ/อนุมัติ — สองมือ ลายเซ็น "ช่องรวม" ช่องเดียวบนเอกสาร (ผู้ใช้สั่งให้เหลือ 3 ช่อง):
   *              • ตรวจสอบ      reviewExpense    แอดมินช่าง · ผู้จัดการฯ    → ส่งต่อให้ผู้จัดการอนุมัติ
   *              • อนุมัติ       approveExpense   ผู้จัดการแผนกช่าง          → ชื่อ/ลายเซ็นที่พิมพ์ในช่องรวม
   *   ส่วนที่ 3  อนุมัติเบิกจ่าย  disburseExpense  ผู้จัดการฯ · กรรมการฯ      ลายเซ็นช่อง "ผู้อนุมัติเบิกจ่าย"
   *
   * ⚠️ แจ้งเตือนของแต่ละขั้นส่งหา "role ที่มีสิทธิ์ของขั้นถัดไป" เท่านั้น (routes/expenses.js อ่านจากตารางนี้)
   * แก้ใครทำขั้นไหนได้ที่นี่จุดเดียว ผู้รับแจ้งเตือนก็เปลี่ยนตามอัตโนมัติ ไม่มีทางหลุดกัน
   * ⚠️ ข้ามขั้นไม่ได้ทุกกรณี (route บังคับสถานะก่อนหน้าเสมอ) และตรวจสอบ/อนุมัติใบของตัวเองได้เฉพาะ
   * ผู้มีสิทธิ์ approveOwnExpense
   *
   * ส่วนที่ 2 มือแรก — ✅ "ให้แค่แอดมิน และผู้จัดการเท่านั้น ที่ดำเนินการและอนุมัติตรวจสอบได้"
   * ✅ "ในช่องที่ 2 คือให้แอดมินมีหน้าที่ตรวจสอบ ตรวจแล้วส่งมาให้ผจก.แผนกลงอนุมัติให้"
   * ⚠️ กรรมการผู้จัดการไม่อยู่ในขั้นนี้โดยตั้งใจ (ผู้ใช้กำหนดให้เข้ามาที่ขั้นอนุมัติเบิกจ่าย)
   */
  reviewExpense: [ROLES.ADMIN, ROLES.MANAGER],

  /**
   * ส่วนที่ 2 มือสอง — อนุมัติ · ✅ "พอแอดมินอนุมัติตรวจสอบเสร็จ ให้ส่งแจ้งเตือนแค่ผู้จัดการที่อนุมัติ แล้วจัดการต่อ"
   * ⚠️ อนุมัติได้เฉพาะใบที่ "ผ่านการตรวจสอบแล้ว" เสมอ · แอดมินไม่มีสิทธิ์นี้แล้ว (แอดมิน = ผู้ตรวจสอบ)
   */
  approveExpense: [ROLES.MANAGER],

  /**
   * ส่วนที่ 3 — อนุมัติเบิกจ่าย (บันทึกการจ่ายเงิน Advance / ปิดส่วนต่างใบเคลม / จ่ายคืนใบสำรองจ่าย)
   * ✅ "หลังจากผู้จัดการอนุมัติขั้นตอนสุดท้าย ให้แจ้งเตือนผู้จัดการ และกรรมการผู้จัดการ สามารถดำเนินการได้"
   * ⚠️ เป็นขั้นที่ "เงินออกจริง" จึงบันทึกวิธีจ่าย/เลขอ้างอิง/สลิป และลายเซ็นช่อง "ผู้อนุมัติเบิกจ่าย" ในขั้นนี้
   * ⚠️ ผู้จัดการที่อนุมัติขั้น 3 มาอนุมัติเบิกจ่ายต่อเองได้ (ผู้ใช้กำหนดให้ผู้จัดการทำขั้นนี้ได้ด้วย)
   */
  disburseExpense: [ROLES.DIRECTOR, ROLES.MANAGER],

  /**
   * กดครบทั้งสองขั้นในใบเดียวกันเองได้ (ตรวจสอบเอง → อนุมัติเอง)
   *
   * ✅ ผู้ใช้สั่ง: "สิทธิ์ผู้จัดการให้กดตรวจสอบ และอนุมัติเองได้ด้วย" — ผู้จัดการเป็นผู้มีอำนาจสูงสุด
   * ในสายอนุมัติค่าใช้จ่าย จะทำเองทั้งสองขั้นก็ได้ (เช่น แอดมินลา/นอกเวลา งานต้องไม่ค้าง)
   * ⚠️ แลกมาด้วยการที่ใบนั้นไม่มี "คนที่สองมาสอบทาน" — ใบยังบันทึกทั้งสองขั้นไว้ในประวัติและพิมพ์
   * ชื่อ/ลายเซ็นคนเดียวกันทั้งช่องผู้ตรวจสอบและผู้อนุมัติ ตรวจย้อนหลังได้ว่าใบไหนทำคนเดียว
   * ⚠️ ไม่ให้แอดมิน — แอดมินคือ "ผู้ตรวจสอบ" ตามการออกแบบ ถ้าให้ด้วยก็ไม่เหลือการสอบทานเลยทั้งระบบ
   */
  // ⚠️ ขั้นอนุมัติมีแต่ผู้จัดการ สิทธิ์ "ตรวจเองแล้วอนุมัติต่อเอง" จึงมีความหมายกับผู้จัดการเท่านั้น
  approveOwnReview: [ROLES.MANAGER],

  /**
   * ตรวจสอบ/อนุมัติ "ใบของตัวเอง" ได้ — ข้อยกเว้นของหลักควบคุมภายในพื้นฐาน
   *
   * ✅ ผู้ใช้สั่ง: "ให้ผู้จัดการอนุมัติตรวจสอบในใบได้ด้วย" — ผู้จัดการเป็นผู้มีอำนาจสูงสุดของบริษัท
   * ไม่มีใครเหนือกว่าให้อนุมัติแทนได้ เหมือนกับแอดมิน
   * ⚠️ แยกเป็นสิทธิ์ของตัวเอง ไม่รวมกับ manageAll — "ตั้งค่าระบบได้" กับ "เซ็นอนุมัติเงินให้ตัวเองได้"
   * เป็นคนละเรื่อง ต้องเปิด/ปิดแยกกันได้ (เช่นวันหลังอยากคุมเข้มเฉพาะเรื่องเงิน ก็ถอดตรงนี้จุดเดียว)
   * ⚠️ ใบที่อนุมัติเองจะมีชื่อ/ลายเซ็นคนเดียวกันทั้งช่องผู้เบิก ผู้ตรวจสอบ และผู้อนุมัติ — ตรวจย้อนหลังได้
   */
  approveOwnExpense: [ROLES.ADMIN, ROLES.DIRECTOR, ROLES.MANAGER],

  /** เห็นใบของทุกคน + เบิกแทนคนอื่นได้ + ดูรายงานทั้งบริษัท (คนอื่นเห็นเฉพาะของตัวเอง — กรองที่ server) */
  viewAllExpenses: [ROLES.ADMIN, ROLES.DIRECTOR, ROLES.MANAGER],
};

/**
 * ── สิทธิ์ในระบบ (แยกจากตำแหน่งในองค์กร) ──────────────────────────────────────
 * ✅ ผู้ใช้สั่ง: "ทำสิทธิ์ในระบบ และสิทธิ์ในองค์กรแยกกัน เช่นในระบบ Admin / Super Admin"
 *
 *   Super Admin  — ตั้งค่าองค์กร · ตารางสิทธิ์ · ตั้งผู้ดูแลระบบคนอื่น (ทำได้ทุกอย่าง)
 *   Admin        — จัดการผู้ใช้/ข้อมูลหลักได้ แต่แตะตั้งค่าระบบและตารางสิทธิ์ไม่ได้
 *   Member       — ไม่มีสิทธิ์ระดับระบบ (ใช้สิทธิ์จากตำแหน่งในองค์กรล้วนๆ)
 *
 * ⚠️ ชื่อสามชั้นนี้เป็น "ภาษาอังกฤษและเปลี่ยนชื่อไม่ได้" โดยตั้งใจ (ผู้ใช้สั่ง) — เป็นศัพท์ของระบบ
 * ไม่ใช่ตำแหน่งในบริษัท และกันสับสนกับตำแหน่ง "แอดมินช่าง" ซึ่งเป็นคนละเรื่องกัน
 * (ส่วนตำแหน่งในองค์กรเปลี่ยนชื่อได้จากหน้าตั้งค่า — ดู setRankLabels)
 */
const SYSTEM_ROLES = { SUPER: "superadmin", ADMIN: "admin", MEMBER: "member" };
const ALL_SYSTEM_ROLES = Object.values(SYSTEM_ROLES);
const SYSTEM_ROLE_LABEL = {
  [SYSTEM_ROLES.SUPER]: "Super Admin",
  [SYSTEM_ROLES.ADMIN]: "Admin",
  [SYSTEM_ROLES.MEMBER]: "Member",
};
/** คำอธิบายเป็นภาษาไทย — ชื่อชั้นเป็นอังกฤษ แต่คำอธิบายต้องอ่านเข้าใจทันทีว่าทำอะไรได้ */
const SYSTEM_ROLE_DESC = {
  [SYSTEM_ROLES.SUPER]: "ตั้งค่าองค์กร · ตารางสิทธิ์ · ตั้งผู้ดูแลระบบ · จัดการผู้ใช้ทั้งหมด",
  [SYSTEM_ROLES.ADMIN]: "จัดการผู้ใช้และข้อมูลหลัก (ลูกค้า/ประเภทงาน) — แตะตั้งค่าระบบและตารางสิทธิ์ไม่ได้",
  [SYSTEM_ROLES.MEMBER]: "ใช้งานตามตำแหน่งในองค์กรเท่านั้น",
};

/** สิทธิ์ที่ตัดสินด้วย "ชั้นในระบบ" ไม่ใช่ตำแหน่งในองค์กร */
const SYSTEM_CAPABILITIES = {
  /** จัดการผู้ใช้ · ข้อมูลหลัก · ทะเบียนต่างๆ (เดิมคือ AdminRoute) */
  manageAll: [SYSTEM_ROLES.SUPER, SYSTEM_ROLES.ADMIN],
  /** ตั้งค่าองค์กร · ตารางสิทธิ์ · เปลี่ยนชื่อตำแหน่ง · ตั้งชั้นผู้ดูแลระบบให้คนอื่น */
  manageSystem: [SYSTEM_ROLES.SUPER],
};

/**
 * ผู้ใช้เก่าที่ยังไม่เคยตั้ง "ชั้นในระบบ" ให้เดาจากตำแหน่งในองค์กร — ระบบเดิมทำงานต่อได้ทันทีโดยไม่ต้องย้ายข้อมูล
 * ⚠️ ผู้จัดการแผนกช่างได้ superadmin เพราะเดิมผู้ใช้กำหนดให้ "ตั้งค่าอะไรได้หมด" (ถ้าลดชั้นตรงนี้
 * คนที่ดูแลระบบอยู่จริงจะเข้าหน้าตั้งค่าไม่ได้ทันทีที่ deploy)
 */
const DEFAULT_SYSTEM_ROLE = {
  [ROLES.DIRECTOR]: SYSTEM_ROLES.SUPER,
  [ROLES.MANAGER]: SYSTEM_ROLES.SUPER,
  [ROLES.ADMIN]: SYSTEM_ROLES.ADMIN,
  [ROLES.TECH_LEAD]: SYSTEM_ROLES.MEMBER,
  [ROLES.TECHNICIAN]: SYSTEM_ROLES.MEMBER,
  [ROLES.SALE]: SYSTEM_ROLES.MEMBER,
  [ROLES.USER]: SYSTEM_ROLES.MEMBER,
};

/**
 * ชั้นในระบบของผู้ใช้คนนี้
 * @param {object|string} who  user object (ใช้ systemRole ถ้ามี) หรือสตริงตำแหน่งในองค์กร (ของเก่า)
 */
const systemRoleOf = (who) => {
  if (who && typeof who === "object") {
    // ✅ รูปแบบใหม่: มี rank เป็นตำแหน่งในองค์กร แปลว่า role คือ "ตำแหน่งในระบบ"
    const isNewShape = ALL_ROLES.includes(String(who.rank || "").trim().toLowerCase());
    const role = String(who.role || "").trim().toLowerCase();
    if (isNewShape && ALL_SYSTEM_ROLES.includes(role)) return role;
    // รูปแบบเก่า: ตำแหน่งในระบบอยู่ที่ systemRole
    const legacy = String(who.systemRole || "").trim().toLowerCase();
    if (ALL_SYSTEM_ROLES.includes(legacy)) return legacy;
  }
  return DEFAULT_SYSTEM_ROLE[normalizeRole(who)] || SYSTEM_ROLES.MEMBER;
};

const isSystemCapability = (capability) => Object.prototype.hasOwnProperty.call(SYSTEM_CAPABILITIES, capability);

const ALL_CAPABILITIES = Object.keys(CAPABILITIES);

/**
 * ── สิทธิ์ที่ "ปรับเองได้จากหน้าตั้งค่า" ──────────────────────────────────────
 * ✅ ผู้ใช้สั่ง: "อยากให้ตั้งค่ากำหนดสิทธิ์ได้ด้วยว่าอยากให้ใครมองเห็นเมนูอะไร และจัดการอะไรได้บ้าง เอาพอสังเขป"
 *
 * ⚠️ เปิดให้ปรับเฉพาะรายการที่ "อธิบายเป็นภาษาคนได้" และไม่ทำให้ระบบพังถ้าปิด — ส่วนที่เหลือของตาราง
 * (เช่น approveOwnExpense / approveOwnReview ซึ่งเป็นกฎควบคุมภายในของเอกสารการเงิน) ยังตายตัวในโค้ด
 * ⚠️ ค่าที่ปรับเก็บเป็น "ส่วนต่างจากค่าเริ่มต้น" ในฐานข้อมูล ไม่ได้ทับทั้งตาราง — เพิ่มสิทธิ์ใหม่ในโค้ด
 * วันหลัง role เดิมจะได้ค่าเริ่มต้นของสิทธิ์นั้นทันทีโดยไม่ต้องไปตั้งใหม่ทีละอัน
 */
const EDITABLE_CAPABILITIES = [
  "viewAllJobs",
  "viewServiceCalendar",
  "editOperation",
  "approveJobs",
  "editAnyJob",
  "requestDispatch",
  "assignDispatch",
  "receiveDispatch",
  "viewFinance",
  "editFinance",
  "viewContracts",
  "editContracts",
  "viewDocuments",
  "editDocuments",
  "createSalesPlan",
  "manageMasterData",
  "requestExpense",
  "reviewExpense",
  "approveExpense",
  "disburseExpense",
  "viewAllExpenses",
];

/**
 * role ที่ "ห้ามแก้สิทธิ์" — กรรมการผู้จัดการต้องมีสิทธิ์เต็มเสมอ
 * 🔒 นี่คือกันล็อกตัวเองออกจากระบบ: ถ้าเผลอปิด manageAll ของทุก role จะไม่เหลือใครเข้าหน้าตั้งค่าสิทธิ์ได้อีกเลย
 */
const LOCKED_ROLES = [ROLES.DIRECTOR];

/**
 * ตารางส่วนต่างที่ผู้ดูแลปรับไว้ { role: { capability: true|false } }
 * ⚠️ เก็บในหน่วยความจำเพื่อให้ can() ยังเป็นฟังก์ชัน "sync" เหมือนเดิม (ถูกเรียกหลายร้อยจุดทั่วระบบ)
 * โหลดจากฐานข้อมูลตอนบูตและรีเฟรชเป็นระยะ — ดู services/permissionOverrides.js
 */
let OVERRIDES = {};

const setCapabilityOverrides = (map) => {
  const clean = {};
  Object.entries(map || {}).forEach(([role, caps]) => {
    const r = String(role || "").toLowerCase();
    if (!ALL_ROLES.includes(r) || LOCKED_ROLES.includes(r)) return;
    Object.entries(caps || {}).forEach(([cap, value]) => {
      if (!EDITABLE_CAPABILITIES.includes(cap) || typeof value !== "boolean") return;
      clean[r] = clean[r] || {};
      clean[r][cap] = value;
    });
  });
  OVERRIDES = clean;
  return OVERRIDES;
};

const getCapabilityOverrides = () => OVERRIDES;

/**
 * ── ชื่อตำแหน่งในองค์กรที่ตั้งเองได้ ──────────────────────────────────────────
 * ✅ ผู้ใช้สั่ง: "ในองค์กรให้สามารถเปลี่ยนชื่อได้"
 * ⚠️ เปลี่ยนได้แค่ "ชื่อที่แสดง" — คีย์ของตำแหน่ง (admin/manager/technician...) ต้องคงเดิมตลอดไป
 * เพราะถูกอ้างในฐานข้อมูลของผู้ใช้ทุกคน ในตารางสิทธิ์ และในเอกสารที่ออกไปแล้ว
 */
let RANK_LABEL_OVERRIDES = {};

const setRankLabels = (map) => {
  const clean = {};
  Object.entries(map || {}).forEach(([role, label]) => {
    const r = String(role || "").toLowerCase();
    const text = String(label || "").trim().slice(0, 60);
    if (ALL_ROLES.includes(r) && text) clean[r] = text;
  });
  RANK_LABEL_OVERRIDES = clean;
  return RANK_LABEL_OVERRIDES;
};

const getRankLabelOverrides = () => RANK_LABEL_OVERRIDES;

/** ชื่อตำแหน่งที่ใช้แสดงจริง (ชื่อที่ตั้งเอง > ชื่อเริ่มต้น) */
const rankLabelOf = (who) => {
  const r = normalizeRole(who);
  return RANK_LABEL_OVERRIDES[r] || RANK_LABEL[r] || r;
};

/** ตารางสิทธิ์ที่ "ใช้จริง" ตอนนี้ (ค่าเริ่มต้น + ส่วนต่าง) — ใช้ส่งให้หน้าจอวาดเมนู */
const effectiveCapabilities = () => Object.fromEntries(
  Object.entries(CAPABILITIES).map(([cap, roles]) => [
    cap,
    ALL_ROLES.filter((r) => (typeof OVERRIDES[r]?.[cap] === "boolean" ? OVERRIDES[r][cap] : roles.includes(r))),
  ])
);

/**
 * รายชื่อ role ที่เป็น "หัวหน้า" — ใช้เป็น **ผู้รับแจ้งเตือน** (sendPushToRoles) เท่านั้น
 * ⚠️ คนละเรื่องกับ CAPABILITIES โดยตั้งใจ: อันนั้นตอบว่า "ทำได้ไหม" อันนี้ตอบว่า "ส่งหาใคร"
 * ถ้าเอามาปนกันจะเกิดกรณีที่เพิ่มสิทธิ์ให้ role ใหม่แล้วมันได้รับแจ้งเตือนพ่วงไปด้วยโดยไม่ตั้งใจ
 */
/**
 * ช่างหน้างานทั้งหมด (ช่างเทคนิค + หัวหน้าช่างเทคนิค)
 * ✅ ใช้ทุกที่ที่ถามว่า "คนนี้เป็นช่างไหม" — เพิ่ม role ช่างแบบใหม่ในอนาคตก็แก้ที่นี่ที่เดียว
 * ⚠️ อย่าเทียบ role === "technician" ตรงๆ อีก ไม่งั้นหัวหน้าช่างจะหลุดจากรายชื่อ/เมนูของช่างเงียบๆ
 */
const TECHNICIAN_ROLES = [ROLES.TECHNICIAN, ROLES.TECH_LEAD];

const SUPERVISOR_ROLES = [ROLES.ADMIN, ROLES.DIRECTOR, ROLES.MANAGER];

/**
 * รับได้ทั้ง user object ({ role }), req.user, หรือสตริง role ตรงๆ
 * ⚠️ ต้อง toLowerCase เสมอ — ข้อมูลเดิมในฐานข้อมูลถูกกรอกด้วยมือผ่านหน้าจัดการผู้ใช้
 * (โค้ดเดิมทั่วแอปก็ทำ .toLowerCase() ทุกจุดด้วยเหตุผลเดียวกัน)
 */
const normalizeRole = (who) => {
  if (typeof who === "string") return who.trim().toLowerCase();
  // ✅ รูปแบบใหม่: user.rank = ตำแหน่งในองค์กร · รูปแบบเก่า (และสำเนาที่ฝังในเอกสารอื่น): user.role
  const rank = String(who?.rank || "").trim().toLowerCase();
  if (ALL_ROLES.includes(rank)) return rank;
  return String(who?.role || "").trim().toLowerCase();
};

/** ชื่อเดียวกับ normalizeRole แต่เรียกตามคำที่ผู้ใช้กำหนด — โค้ดใหม่ควรใช้ตัวนี้ */
const normalizeRank = (who) => normalizeRole(who);

/**
 * ── ลำดับชั้นของสิทธิ์ (ใครแก้สิทธิ์ใครได้) ────────────────────────────────────
 *
 * ✅ ผู้ใช้สั่ง: "ผู้จัดการสูงสุด · แอดมินไม่ให้แก้ไขตัวเองและคนอื่นเป็นผู้จัดการได้ · ผู้จัดการทำได้หมด"
 *
 *   กรรมการผู้จัดการ (4) — สูงสุดของบริษัท ตั้ง/ถอดสิทธิ์ได้ทุกระดับ รวมถึงตั้งกรรมการผู้จัดการคนใหม่
 *   ผู้จัดการแผนกช่าง (3) — ตั้งสิทธิ์ได้ถึงระดับตัวเอง (ตั้งกรรมการผู้จัดการไม่ได้)
 *   แอดมิน   (2)  — จัดการระบบได้ทุกอย่าง แต่ "ตั้งใครเป็นผู้จัดการไม่ได้" และ "แตะสิทธิ์ผู้จัดการไม่ได้"
 *   ช่าง/เซล/ผู้ใช้ (1) — ไม่มีสิทธิ์จัดการผู้ใช้เลย
 *
 * กติกา 3 ข้อที่ใช้ทุกจุดที่แตะสิทธิ์ผู้ใช้ (เพิ่มผู้ใช้ / เปลี่ยน role / ลบผู้ใช้):
 *   1. ตั้งสิทธิ์ที่ "สูงกว่าระดับตัวเอง" ไม่ได้        → แอดมินตั้งผู้จัดการไม่ได้ (canAssignRole)
 *   2. แตะบัญชีที่ "ระดับสูงกว่าตัวเอง" ไม่ได้        → แอดมินถอดสิทธิ์/ลบผู้จัดการไม่ได้ (canManageUserOfRole)
 *   3. เปลี่ยนสิทธิ์ของตัวเองไม่ได้ (ทุกระดับ)        → กันยกระดับตัวเองและกันล็อกตัวเองออกจากระบบ
 *
 * ⚠️ ฝั่งหน้าจอมีคู่แฝดที่ da-app/src/shared/utils/roles.js — ต้องตรงกันเป๊ะ (หน้าจอไว้ซ่อนปุ่ม
 * ส่วนขอบเขตจริงบังคับที่ server เสมอ)
 */
const ROLE_LEVEL = {
  [ROLES.DIRECTOR]: 4,
  [ROLES.MANAGER]: 3,
  [ROLES.ADMIN]: 2,
  [ROLES.TECHNICIAN]: 1,
  [ROLES.TECH_LEAD]: 1,
  [ROLES.SALE]: 1,
  [ROLES.USER]: 1,
};

/** ระดับของผู้ใช้/role (role ที่ระบบไม่รู้จัก = 0 ทำอะไรไม่ได้เลย) */
const roleLevel = (who) => ROLE_LEVEL[normalizeRole(who)] || 0;

/** ตั้ง role นี้ให้คนอื่นได้ไหม — ต้องมีสิทธิ์จัดการผู้ใช้ก่อน และห้ามตั้งสิทธิ์ที่สูงกว่าระดับตัวเอง (กฎข้อ 1) */
const canAssignRole = (actor, role) =>
  can(actor, "manageAll") && roleLevel(role) > 0 && roleLevel(role) <= roleLevel(actor);

/** แตะบัญชีที่มี role นี้ได้ไหม (เปลี่ยนสิทธิ์/ลบ) — ต้องมีสิทธิ์จัดการผู้ใช้ และห้ามแตะคนที่ระดับสูงกว่าตัวเอง (กฎข้อ 2) */
const canManageUserOfRole = (actor, targetRole) =>
  can(actor, "manageAll") && roleLevel(actor) >= roleLevel(targetRole);


/**
 * ✅ ตัวเดียวที่โค้ดที่อื่นควรเรียก
 * @param {object|string} who   user object / req.user / สตริง role
 * @param {string} capability   ชื่อจาก CAPABILITIES
 */
const can = (who, capability) => {
  // ✅ สิทธิ์ระดับระบบ (จัดการผู้ใช้/ตั้งค่าระบบ) ตัดสินด้วย "ชั้นในระบบ" ไม่เกี่ยวกับตำแหน่งในองค์กร
  if (isSystemCapability(capability)) return SYSTEM_CAPABILITIES[capability].includes(systemRoleOf(who));
  const allowed = CAPABILITIES[capability];
  // ⚠️ พิมพ์ชื่อสิทธิ์ผิด = ปฏิเสธเสมอ (ปลอดภัยไว้ก่อน) แต่ต้องส่งเสียงดังพอให้เห็นตอน dev
  // ไม่งั้นจะกลายเป็นบั๊กเงียบแบบเดียวกับที่ไฟล์นี้ตั้งใจจะกำจัด
  if (!allowed) {
    console.error(`❌ can(): ไม่รู้จักสิทธิ์ "${capability}" — ตรวจชื่อใน src/config/roles.js`);
    return false;
  }
  const role = normalizeRole(who);
  // ✅ ค่าที่ผู้ดูแลปรับเองจากหน้าตั้งค่าสิทธิ์ (ถ้ามี) ชนะตารางค่าเริ่มต้น
  const override = OVERRIDES[role]?.[capability];
  if (typeof override === "boolean") return override;
  return allowed.includes(role);
};

/** แผนกที่ role นี้สังกัด (null = ไม่ผูกแผนกใดเป็นพิเศษ) */
const departmentOf = (who) => ROLE_DEPARTMENT[normalizeRole(who)] || null;

const isRole = (who, ...roles) => roles.map((r) => String(r).toLowerCase()).includes(normalizeRole(who));

/** ทางลัดที่ใช้บ่อยที่สุดในระบบเดิม — มีไว้ให้การย้ายโค้ดเก่าอ่านง่ายขึ้น */
const isAdminOrManager = (who) => isRole(who, ROLES.ADMIN, ROLES.DIRECTOR, ROLES.MANAGER);

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

/**
 * ── นามแฝง Rank ──
 * คีย์ในฐานข้อมูลยังชื่อ user.role เหมือนเดิม (ข้อมูลผู้ใช้ทุกคนอ้างคีย์นี้อยู่)
 * แต่โค้ดที่เขียนใหม่ให้เรียกผ่านชื่อนี้ จะได้อ่านโค้ดแล้วตรงกับคำที่ผู้ใช้เห็นบนหน้าจอ
 */
const RANKS = ROLES;

/**
 * เงื่อนไขค้นหาผู้ใช้ตาม Rank (ตำแหน่งในองค์กร) — ใช้กับ User.find/countDocuments เสมอ
 *
 * ⚠️ ห้ามเขียน { rank: { $in: [...] } } ตรงๆ: เอกสารที่ยังไม่ถูกย้าย (ของเก่า/กู้คืนจากสำรอง/
 * สร้างจากโค้ดรุ่นเก่าระหว่าง deploy) เก็บตำแหน่งในองค์กรไว้ที่ role — ถ้าไม่เผื่อไว้ คนกลุ่มนั้นจะ
 * "หายไปเงียบๆ" จากรายชื่อผู้รับแจ้งเตือน ซึ่งเป็นบั๊กที่ไม่มี error ให้เห็นเลย
 * ⚠️ สาขาของเก่าจะใช้ก็ต่อเมื่อ rank ว่างจริงๆ — กันเคส role = "admin" (ตำแหน่งในระบบ) ถูกนับเป็นแอดมินช่าง
 */
const rankFilter = (ranks) => ({
  $or: [
    { rank: { $in: ranks } },
    { rank: { $in: [null, ""] }, role: { $in: ranks } },
  ],
});
const ALL_RANKS = ALL_ROLES;
const rankOf = (who) => normalizeRole(who);

/**
 * ชื่อตำแหน่งที่ใช้พิมพ์ใต้ชื่อคนในเอกสาร/ใบเบิก
 * ลำดับ: ตำแหน่งเฉพาะบุคคล (jobTitle) > ค่าเก่าในฐานข้อมูล (rank) > ชื่อ Rank ของตำแหน่ง
 * ⚠️ อ่าน user.rank ต่อไปด้วย เพราะผู้ใช้ที่กรอกไว้ก่อนเปลี่ยนชื่อฟิลด์ ต้องไม่หายไปจากเอกสาร
 */
const titleOf = (user) => {
  const own = String(user?.jobTitle || "").trim();
  if (own) return own;
  // ⚠️ ข้อมูลเก่า: user.rank เคยเป็น "ข้อความตำแหน่งที่พิมพ์เอง" ก่อนเปลี่ยนความหมายเป็นตำแหน่งในองค์กร
  const legacy = String(user?.rank || "").trim();
  if (legacy && !ALL_ROLES.includes(legacy.toLowerCase())) return legacy;
  return rankLabelOf(user) || "";
};

module.exports = {
  ROLES,
  ALL_ROLES,
  RANKS,
  ALL_RANKS,
  rankFilter,
  rankOf,
  normalizeRank,
  titleOf,
  RANK_LABEL,
  DEPARTMENT,
  DEPARTMENT_LABEL,
  ROLE_DEPARTMENT,
  CAPABILITIES,
  ALL_CAPABILITIES,
  EDITABLE_CAPABILITIES,
  LOCKED_ROLES,
  SYSTEM_ROLES,
  ALL_SYSTEM_ROLES,
  SYSTEM_ROLE_LABEL,
  SYSTEM_ROLE_DESC,
  SYSTEM_CAPABILITIES,
  DEFAULT_SYSTEM_ROLE,
  systemRoleOf,
  isSystemCapability,
  setRankLabels,
  getRankLabelOverrides,
  rankLabelOf,
  setCapabilityOverrides,
  getCapabilityOverrides,
  effectiveCapabilities,
  SUPERVISOR_ROLES,
  TECHNICIAN_ROLES,
  ROLE_LEVEL,
  roleLevel,
  canAssignRole,
  canManageUserOfRole,
  normalizeRole,
  can,
  departmentOf,
  isRole,
  isAdminOrManager,
  requireCap,
};
