const webpush = require("web-push");
const PushSubscription = require("../models/PushSubscription");
const User = require("../models/User");

webpush.setVapidDetails(
  process.env.VAPID_SUBJECT,
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

// ✅ ส่ง push ให้ผู้ใช้ตาม userId ทุกอุปกรณ์/เบราว์เซอร์ที่เคย subscribe ไว้
// ถ้า endpoint หมดอายุ/ถูกยกเลิก (404/410) ให้ลบ subscription นั้นทิ้งจาก DB ไปเลย
async function sendPushToUsers(userIds, payload) {
  const ids = [...new Set((Array.isArray(userIds) ? userIds : [userIds]).filter(Boolean).map(String))];
  if (ids.length === 0) return;

  const subs = await PushSubscription.find({ userId: { $in: ids } });
  const body = JSON.stringify(payload);

  await Promise.all(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: sub.keys },
          body
        );
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) {
          await PushSubscription.deleteOne({ _id: sub._id });
        } else {
          console.error("❌ Push notification error:", err.statusCode, err.body);
        }
      }
    })
  );
}

// ✅ ส่ง push ให้ทุกคนที่มี role อยู่ใน roles ที่ระบุ (เช่น แจ้งแอดมิน/manager ทุกคนตอนช่างขอปิดงาน)
async function sendPushToRoles(roles, payload) {
  const users = await User.find({ role: { $in: roles } }).select("_id").lean();
  await sendPushToUsers(users.map((u) => u._id.toString()), payload);
}

// ✅ ส่ง push ให้ทุกคนในระบบ (เช่น แจ้งตอนมีการเพิ่มงานใหม่) ยกเว้นคนที่ระบุ (เช่น คนที่เพิ่งเพิ่มงานเอง)
async function sendPushToAllUsers(payload, excludeUserIds = []) {
  const excluded = new Set((Array.isArray(excludeUserIds) ? excludeUserIds : [excludeUserIds]).filter(Boolean).map(String));
  const users = await User.find({}).select("_id").lean();
  const ids = users.map((u) => u._id.toString()).filter((id) => !excluded.has(id));
  await sendPushToUsers(ids, payload);
}

module.exports = { sendPushToUsers, sendPushToRoles, sendPushToAllUsers };
