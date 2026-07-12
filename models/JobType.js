const mongoose = require("../db/");

const jobTypeSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true, trim: true },
  },
  { timestamps: true }
);

const JobType = mongoose.model("JobType", jobTypeSchema);
module.exports = JobType;
