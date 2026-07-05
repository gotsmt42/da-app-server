const mongoose = require("../db/");

const pushSubscriptionSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  endpoint: { type: String, required: true, unique: true },
  keys: {
    p256dh: { type: String, required: true },
    auth: { type: String, required: true },
  },
}, { timestamps: true });

const PushSubscription = mongoose.model("PushSubscription", pushSubscriptionSchema);
module.exports = PushSubscription;
