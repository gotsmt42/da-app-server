/**
 * ของกลางที่ทุกโมดูลของ /api/events ใช้ร่วมกัน — ยกมาจากส่วนหัวของ calendarEvent.js เดิมทั้งดุ้น
 * (require, ค่าคงที่ และ helper ที่ route หลายตัวเรียกใช้) ไม่ได้แก้เนื้อในเลย
 *
 * ⚠️ helper ที่มีแค่หมวดเดียวใช้ ไม่ต้องเอามาไว้ที่นี่ — ให้อยู่ในไฟล์ของหมวดนั้น
 * (เช่น requireEventFinanceAccess / financeActor อยู่ใน billing.js)
 */
const moment = require("moment");
require("moment/locale/th");

const CalendarEvent = require("../../models/Events");
const User = require("../../models/User");

const verifyToken = require("../../middleware/auth");

const multer = require("multer");
// ⚠️ เดิมไฟล์นี้ require "../config/cloudinaryConfig" ส่วน routes/auth.js require "../utils/cloudinary"
// ทั้งสองไฟล์เรียก cloudinary.config() ด้วยค่าเดียวกันเป๊ะ = ตั้งค่าซ้ำซ้อนคนละที่ ถ้าวันไหนแก้ ENV
// หรือ option แล้วแก้ไม่ครบทั้งคู่จะได้พฤติกรรมต่างกันโดยไม่รู้ตัว — รวมเหลือไฟล์เดียวแล้ว
const { cloudinary } = require("../../config/cloudinary");

const storage = multer.memoryStorage();
const upload = multer({ storage });

const streamifier = require("streamifier");
const { computeBillingAmounts, computeDueAt } = require("../../utils/billing");
const InvoiceScan = require("../../services/InvoiceScan");
const crypto = require("crypto");

// ✅ จำนวนครั้งสูงสุดต่อสัญญา — ต้องตรงกับ MAX_VISIT_COUNT ฝั่งหน้าจอ (ContractOverview.js) เป๊ะๆ
// ใช้จำกัดเลข "ครั้งที่" ปลายทางตอนย้ายครั้ง (ดู PUT /contract/:contractGroupId/move-round)
const MAX_VISIT_COUNT = 12;
const { sendPushToUsers, sendPushToRoles, sendPushToAllUsers } = require("../../services/PushNotify");
// ⚠️ findResPersonConflicts (เช็คช่างชนกัน/double-booking กับงานอื่นในระบบ) ถูกตัดออกจากทุก route
// แล้วตามที่ผู้ใช้ขอ — 1 ทีมรับหลายงานในวันเดียวกันได้ตามปกติ เหลือไว้แค่ findMutualOverlaps (เช็คว่า
// วันที่ที่กรอกมาในคำขอเดียวกันชนกันเองหรือไม่ เช่น หลายวันไม่ติดกันของงานเดียวกันทับกันเอง)
const { findMutualOverlaps } = require("../../utils/scheduleConflict");

// ✅ ห้ามมี 2 งานใช้ "ครั้งที่" (time) ซ้ำกันภายในสัญญาเดียวกัน (contractGroupId เดียวกัน) — ไม่ว่าจะเป็น
// แผนงานล่วงหน้า (unscheduled) หรือลงตารางจริงแล้วก็ตาม เพราะทั้งสองแบบ "จอง" หมายเลขครั้งนั้นไปแล้ว
// excludeId ใช้ตอนแปลง draft เดิมเป็นงานจริง (PUT /:id/schedule) เพื่อไม่ให้ชนกับตัวมันเอง
async function findDuplicateContractRound(contractGroupId, time, excludeId) {
  if (!contractGroupId || time === undefined || time === null || time === "") return null;
  const query = { contractGroupId, time: String(time) };
  if (excludeId) query._id = { $ne: excludeId };
  return CalendarEvent.findOne(query);
}

// ✅ ห้ามเลขที่สัญญาซ้ำกันข้ามสัญญา — เอกสารทุกครั้งที่ (visit) ในสัญญาเดียวกันมี contractNo เดียวกัน
// อยู่แล้วโดยตั้งใจ (นับเป็นสัญญาเดียว ไม่ใช่ซ้ำ) ต้องกันเฉพาะกรณีเลขที่นี้ไปโผล่ที่ contractGroupId
// อื่นเท่านั้นถึงจะถือว่าซ้ำจริง — excludeContractGroupId ไม่ใส่มาตอนสร้างสัญญาใหม่ทั้งชุด (ยังไม่มี
// contractGroupId ให้ยกเว้น เจอที่ไหนก็ถือว่าซ้ำหมด) ใส่มาตอนแก้ไข/สร้างครั้งถัดไปของสัญญาที่มีอยู่แล้ว
async function findDuplicateContractNo(contractNo, excludeContractGroupId) {
  const trimmed = (contractNo || "").trim();
  if (!trimmed) return null;
  const query = { contractNo: trimmed };
  if (excludeContractGroupId) query.contractGroupId = { $ne: excludeContractGroupId };
  return CalendarEvent.findOne(query).select("contractGroupId contractNo").lean();
}

// ✅ เทียบข้อมูลสัญญา "ก่อน → หลัง" เพื่อบันทึกลง activityLog (ดู PUT /contract/:contractGroupId)
// ⚠️ หน้าภาพรวมงานส่งค่าทั้งชุดกลับมาทุกครั้งที่กดบันทึก แม้ผู้ใช้แก้แค่ช่องเดียว จึงต้องเทียบค่าจริง
// ทีละฟิลด์ ไม่ใช่เชื่อว่า "มีใน req.body = ถูกแก้" ไม่งั้นไทม์ไลน์จะเต็มไปด้วยรายการที่ไม่ได้แก้อะไรเลย
const CONTRACT_FIELD_LABELS = {
  contractNo: "เลขที่สัญญา",
  quotationNo: "เลขที่ใบเสนอราคา",
  contractStart: "วันเริ่มสัญญา",
  contractEnd: "วันสิ้นสุดสัญญา",
  visitCount: "จำนวนครั้งทั้งหมด",
  intervalMonths: "ระยะห่างระหว่างรอบ (เดือน)",
  jobValue: "มูลค่างาน",
  commission: "ค่าคอมมิชชั่น",
  team: "ทีมที่เข้างาน",
  resPerson: "ผู้ปฏิบัติงาน",
  responsiblePerson: "ผู้รับผิดชอบ",
};
// responsiblePersonId เปลี่ยนคู่กับ responsiblePerson เสมอ — log แค่ชื่อที่คนอ่านออกก็พอ ไม่งั้นได้
// บรรทัดรหัสยาวๆ ที่ไม่มีความหมายกับผู้อ่านซ้อนมาอีกรายการทุกครั้งที่เปลี่ยนผู้รับผิดชอบ

const DATE_CONTRACT_FIELDS = new Set(["contractStart", "contractEnd"]);
const NUMBER_CONTRACT_FIELDS = new Set(["visitCount", "intervalMonths", "jobValue", "commission"]);

// ทำให้ค่าเทียบกันได้จริง — ค่าที่ "ไม่มี" มาได้ทั้ง undefined / null / "" ต้องถือว่าเท่ากันหมด
// และวันที่ที่เก็บเป็น Date กับที่ส่งมาเป็นสตริง "YYYY-MM-DD" ต้องเทียบกันได้ด้วย
function normalizeContractValue(field, v) {
  if (v === undefined || v === null || v === "") return "";
  if (DATE_CONTRACT_FIELDS.has(field)) {
    const m = moment(v);
    return m.isValid() ? m.format("YYYY-MM-DD") : "";
  }
  if (NUMBER_CONTRACT_FIELDS.has(field)) {
    const n = Number(v);
    return Number.isFinite(n) ? String(n) : "";
  }
  return String(v).trim();
}

function formatContractValue(field, v) {
  const norm = normalizeContractValue(field, v);
  if (norm === "") return "(ว่าง)";
  if (DATE_CONTRACT_FIELDS.has(field)) return moment(norm, "YYYY-MM-DD").format("DD/MM/YYYY");
  if (field === "jobValue" || field === "commission") return `${Number(norm).toLocaleString("th-TH")} บาท`;
  return norm;
}

function diffContractFields(before, update) {
  const changes = [];
  for (const [field, label] of Object.entries(CONTRACT_FIELD_LABELS)) {
    if (!(field in update)) continue;
    const from = normalizeContractValue(field, before?.[field]);
    const to = normalizeContractValue(field, update[field]);
    if (from === to) continue;
    changes.push({
      field,
      label,
      from: formatContractValue(field, before?.[field]),
      to: formatContractValue(field, update[field]),
    });
  }
  return changes;
}

// ✅ "ผู้รับผิดชอบตัวจริง" (effective responsible person) — ใช้กับ "การดำเนินงาน"/"ติดตามใบเสนอราคา"/
// หน้า "ภาพรวมงาน" ของช่าง ที่ผู้ใช้ต้องการให้เป็นสิทธิ์ของ "ผู้รับผิดชอบ" (responsiblePerson) ล้วนๆ
// ไม่ใช่ "ทีมที่เข้างาน" (team) อีกต่อไป — แต่ต้อง fallback ไปที่ team/resPerson เมื่องานนั้นยังไม่เคย
// ถูกตั้งค่าผู้รับผิดชอบแยกไว้เลย (responsiblePerson ว่างเปล่า) ไม่งั้นงานเก่า/งานใหม่ทุกงานที่ยังไม่มี
// ใครไปตั้งค่านี้ให้ชัดเจน จะกลายเป็นไม่มีใครนอกจากแอดมิน/manager เข้าถึงได้เลยทันที (พังงานที่ทำอยู่
// ทุกวันนี้ทั้งหมด) — พอแอดมิน/manager มอบหมาย "ผู้รับผิดชอบ" ให้คนละคนกับทีมที่เข้างานเมื่อไหร่
// (ผ่านหน้า "ภาพรวมงาน") ทีมที่เข้างานเดิมจะหลุดจากสิทธิ์กลุ่มนี้ทันที เหลือแค่ผู้รับผิดชอบคนใหม่เท่านั้น
// 🐛 BUG ที่แก้ (งานที่ตัวเองไม่ได้รับผิดชอบโผล่ในตาราง/แก้ไขได้): เดิม 2 ช่องระบุตัวตนของ "ผู้รับผิดชอบ"
// (responsiblePersonId กับ responsiblePerson) fallback ไปหา team/resPerson แยกกันอิสระคนละบรรทัด
// ผลคืองานที่ "มอบหมายให้คนอื่นไปแล้ว" ยังรั่วออกมาได้ เพราะปกติแอดมินมอบหมายด้วยการเลือกชื่อ ซึ่ง
// เซ็ต responsiblePerson ไว้ช่องเดียว ส่วน responsiblePersonId ยังว่าง — เงื่อนไข
//   { responsiblePersonId ว่าง AND resPerson = ฉัน }
// จึงเป็นจริงทันทีสำหรับช่างที่เป็นคนเข้างาน ทั้งที่ช่อง "ผู้รับผิดชอบ" ระบุชื่อคนอื่นไว้ชัดเจนแล้ว
// (และรั่วในทางกลับกันได้ด้วยถ้ามีแต่ id ไม่มีชื่อ)
// ✅ fallback ไปที่ทีมที่เข้างานได้ก็ต่อเมื่อ "ยังไม่มีการมอบหมายผู้รับผิดชอบเลยทั้ง 2 ช่อง" เท่านั้น
// ⚠️ ยังต้องคง fallback ไว้ — สัญญาส่วนใหญ่ในระบบยังขึ้นว่า "ยังไม่มอบหมาย" ถ้าตัดทิ้งไปเลย ช่างจะ
// มองไม่เห็นงานที่ตัวเองต้องไปทำทั้งหมดในทันที
function effectiveResponsibleOrClauses(userId, fname) {
  const emptyOrMissing = (field) => ({ $or: [{ [field]: { $exists: false } }, { [field]: "" }, { [field]: null }] });
  const noResponsibleAssigned = {
    $and: [emptyOrMissing("responsiblePersonId"), emptyOrMissing("responsiblePerson")],
  };
  return [
    { responsiblePersonId: userId },
    { responsiblePerson: fname },
    { $and: [noResponsibleAssigned, { $or: [{ resPerson: userId }, { team: fname }] }] },
  ];
}

/**
 * ✅ ตัวกรองแบบ "เข้มงวด" — เห็นเฉพาะงานที่ระบุตัวเองเป็น "ผู้รับผิดชอบหลัก" ไว้ตรงๆ เท่านั้น
 * ไม่อิงทีมที่เข้างาน ไม่อิงลูกทีม และไม่ fallback ให้งานที่ยังไม่มอบหมาย
 *
 * ⚠️ ใช้เฉพาะหน้า "ภาพรวมงาน" (ส่ง ?scope=responsible มา) ตามที่ผู้ใช้ระบุ — หน้าอื่นทั้งหมด
 * (การดำเนินงาน / งานของฉัน / แดชบอร์ด / ปฏิทิน) ยังใช้ effectiveResponsibleOrClauses เหมือนเดิม
 * เพราะเป็นหน้าที่ช่างใช้ทำงานประจำวัน ถ้าเข้มด้วยจะมองไม่เห็นงานที่ตัวเองต้องไปทำ
 * ⚠️ เหตุผลที่หน้าภาพรวมงานต้องเข้ม: เป็นหน้า "สรุปภาพรวมความรับผิดชอบ" (มูลค่างาน/คืบหน้า/ยอดรวม)
 * งานที่ตัวเองแค่ไปช่วยทำแต่ไม่ได้รับผิดชอบ ไม่ควรถูกนับรวมอยู่ในยอดของตัวเอง
 */
function strictResponsibleOrClauses(userId, fname) {
  return [
    { responsiblePersonId: userId },
    { responsiblePerson: fname },
  ];
}

// ✅ เทียบ pattern เดียวกับ effectiveResponsibleOrClauses ด้านบนเป๊ะๆ แต่ใช้เช็ค document เดียวที่โหลด
// มาแล้ว (ไม่ใช่สร้าง Mongo query) — ใช้กับ route ที่เช็คสิทธิ์ทีละ event เช่น quotation-followup
// ⚠️ ต้องใช้ตรรกะเดียวกับ effectiveResponsibleOrClauses เป๊ะๆ — เดิมมีบั๊กตัวเดียวกัน (fallback แยก
// กันคนละช่อง ทำให้งานที่มอบหมายให้คนอื่นแล้วยังผ่านได้) ดูคำอธิบายเต็มที่ฟังก์ชันนั้น
// ⚠️ ถ้าแก้ที่นี่ต้องไปแก้ที่โน่นด้วยเสมอ ไม่งั้น "สิ่งที่มองเห็น" กับ "สิ่งที่แก้ไขได้" จะไม่ตรงกัน
/**
 * ✅ "คนที่เกี่ยวข้องกับงานนี้" — ผู้ลงงาน (คนสร้าง) · ผู้รับผิดชอบ · หัวหน้าทีมที่เข้างาน · ลูกทีม
 * ใช้กับหน้าที่ผู้ใช้ระบุว่า "ใครก็ได้ที่มีชื่อในงาน ต้องเข้าดู/อัปเดตงานตัวเองได้" — หน้า /finance
 * (ติดตามใบเสนอราคา + วางบิล/รับเงิน) และการติดตามใบเสนอราคา
 *
 * ⚠️ อย่าเอาไปใช้แทน "การเช็คผู้รับผิดชอบตัวจริง" เด็ดขาด — เป็นคนละเกณฑ์กันโดยสิ้นเชิง:
 *   • ตัวนี้ = "มีชื่ออยู่ในงานนี้ไหม" (กว้าง) — ใช้ตัดสินว่าเข้าถึงงานของตัวเองได้ไหม
 *   • อีกเกณฑ์ = "เป็นผู้รับผิดชอบที่ถูกมอบหมายไว้ชัดเจนไหม" (แคบ) — เช็คจาก responsiblePersonId /
 *     responsiblePerson ตรงๆ ไม่ fallback ไปที่ทีมที่เข้างาน ใช้กับสิทธิ์ที่ต้องมอบหมายก่อนเท่านั้น
 *     เช่น หน้าภาพรวมงาน/การแก้ไขครั้งที่ของสัญญา (ดูตัวอย่างการเช็คจริงที่ PUT /basic-info)
 */
function isJobParticipant(event, userId, fname) {
  const uid = String(userId);
  return (
    String(event.userId) === uid ||
    (event.resPerson && event.resPerson === uid) ||
    (event.team && event.team === fname) ||
    (event.responsiblePersonId && event.responsiblePersonId === uid) ||
    (event.responsiblePerson && event.responsiblePerson === fname) ||
    (event.teamMembers || []).some(
      (m) => (m?.userId && m.userId === uid) || (m?.name && m.name === fname)
    )
  );
}

module.exports = {
  moment,
  CalendarEvent,
  User,
  verifyToken,
  multer,
  storage,
  upload,
  cloudinary,
  streamifier,
  computeBillingAmounts,
  computeDueAt,
  InvoiceScan,
  crypto,
  MAX_VISIT_COUNT,
  sendPushToUsers,
  sendPushToRoles,
  sendPushToAllUsers,
  findMutualOverlaps,
  findDuplicateContractRound,
  findDuplicateContractNo,
  normalizeContractValue,
  formatContractValue,
  diffContractFields,
  effectiveResponsibleOrClauses,
  strictResponsibleOrClauses,
  isJobParticipant,
};
