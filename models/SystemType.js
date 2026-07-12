const mongoose = require("../db/");

const systemTypeSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true, trim: true },
  },
  { timestamps: true }
);

const SystemType = mongoose.model("SystemType", systemTypeSchema);
module.exports = SystemType;
