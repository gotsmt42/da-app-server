const admin = require("firebase-admin");
const serviceAccount = require("./serviceAccountKey.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  storageBucket: "da-app-a62c3.appspot.com", // <-- แก้เป็นชื่อ bucket จริง
});

const bucket = admin.storage().bucket();

module.exports = bucket;
