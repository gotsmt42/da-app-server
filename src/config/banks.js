/**
 * banks.js — รายชื่อธนาคาร/ช่องทางรับเงิน สำหรับบัญชีรับเงินของผู้เบิก (ใบเคลม)
 *
 * ⚠️ ต้องตรงกับ BANKS ใน da-app/src/features/expenses/bankMeta.js (code / digits) — เพิ่มธนาคารต้องแก้ทั้งสองฝั่ง
 * ไม่งั้นหน้าจอเลือกธนาคารที่ server ไม่รู้จักแล้วบันทึกไม่ผ่านโดยผู้ใช้ไม่รู้สาเหตุ
 * ✅ digits = จำนวนหลักที่ถูกต้องของเลขบัญชี — กันพิมพ์ตกหล่น/เกินมา 1 หลัก ซึ่งทำให้โอนเงินผิดบัญชีหรือโอนไม่เข้า
 *    (เลขบัญชีธนาคารไทยส่วนใหญ่ 10 หลัก · ออมสิน/ธ.ก.ส. 12 หลัก · พร้อมเพย์ = เบอร์มือถือ 10 หลัก หรือเลขบัตร ปชช. 13 หลัก)
 */
const BANKS = [
  { code: "KBANK", name: "ธนาคารกสิกรไทย", digits: [10] },
  { code: "SCB", name: "ธนาคารไทยพาณิชย์", digits: [10] },
  { code: "BBL", name: "ธนาคารกรุงเทพ", digits: [10] },
  { code: "KTB", name: "ธนาคารกรุงไทย", digits: [10] },
  { code: "BAY", name: "ธนาคารกรุงศรีอยุธยา", digits: [10] },
  { code: "TTB", name: "ธนาคารทหารไทยธนชาต (ttb)", digits: [10] },
  { code: "GSB", name: "ธนาคารออมสิน", digits: [12] },
  { code: "BAAC", name: "ธนาคารเพื่อการเกษตรและสหกรณ์การเกษตร (ธ.ก.ส.)", digits: [12] },
  { code: "GHB", name: "ธนาคารอาคารสงเคราะห์", digits: [12] },
  { code: "UOB", name: "ธนาคารยูโอบี", digits: [10] },
  { code: "CIMB", name: "ธนาคารซีไอเอ็มบี ไทย", digits: [10] },
  { code: "KKP", name: "ธนาคารเกียรตินาคินภัทร", digits: [10] },
  { code: "LHB", name: "ธนาคารแลนด์ แอนด์ เฮ้าส์", digits: [10] },
  { code: "TISCO", name: "ธนาคารทิสโก้", digits: [10] },
  { code: "ICBC", name: "ธนาคารไอซีบีซี (ไทย)", digits: [10] },
  { code: "IBANK", name: "ธนาคารอิสลามแห่งประเทศไทย", digits: [10] },
  { code: "PROMPTPAY", name: "พร้อมเพย์", digits: [10, 13] },
];

const bankByCode = (code) => BANKS.find((b) => b.code === code) || null;

/** เก็บเลขบัญชีเป็นตัวเลขล้วนเสมอ — ขีด/ช่องว่างที่พิมพ์มาเป็นแค่รูปแบบการแสดงผล */
const digitsOnly = (v) => String(v || "").replace(/\D/g, "");

/** @returns {string} ข้อความผิดพลาดภาษาไทย หรือ "" ถ้าถูกต้อง */
const validateAccount = (bankCode, accountNo) => {
  const bank = bankByCode(bankCode);
  if (!bank) return "กรุณาเลือกธนาคาร";
  const no = digitsOnly(accountNo);
  if (!no) return "กรุณากรอกเลขบัญชี";
  if (!bank.digits.includes(no.length)) {
    return bank.code === "PROMPTPAY"
      ? "พร้อมเพย์ต้องเป็นเบอร์มือถือ 10 หลัก หรือเลขบัตรประชาชน 13 หลัก"
      : `เลขบัญชี${bank.name}ต้องมี ${bank.digits.join(" หรือ ")} หลัก (กรอกมา ${no.length} หลัก)`;
  }
  return "";
};

module.exports = { BANKS, bankByCode, digitsOnly, validateAccount };
