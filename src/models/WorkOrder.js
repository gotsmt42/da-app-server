const mongoose = require("../db");

const workOrderSchema = new mongoose.Schema(
  {
    eventId: { type: mongoose.Schema.Types.ObjectId, ref: "CalendarEvent", required: true },

    woNumber: { type: String, unique: true },

    company: String,
    site: String,
    title: String,
    system: String,
    team: String,

    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: "User" },

    plannedStart: Date,
    plannedEnd: Date,

    actualStart: Date,
    actualEnd: Date,

    status: {
      type: String,
      enum: ["waiting", "confirmed", "in-progress", "finished", "cancelled"],
      default: "waiting",
    },

    progress: {
      beforeImages: [String],
      afterImages: [String],
      pmChecklist: [{ question: String, answer: String }],
      note: String,
      signature: String,
    },
  },
  { timestamps: true }

  
);

module.exports = mongoose.model("WorkOrder", workOrderSchema);
