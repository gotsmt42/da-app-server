const WorkOrder = require("../models/WorkOrder");

exports.getMyJobs = async (req, res) => {
  const userId = req.params.userId;

if (!userId || userId === "undefined") {
  return res.json({ jobs: [] });
}

const jobs = await WorkOrder.find({ assignedTo: userId }).sort({ plannedStart: 1 });

  res.json({ jobs });
};

exports.startJob = async (req, res) => {
  const { id } = req.params;

  const job = await WorkOrder.findByIdAndUpdate(
    id,
    { status: "in-progress", actualStart: new Date() },
    { new: true }
  );

  res.json({ job });
};

exports.finishJob = async (req, res) => {
  const { id } = req.params;

  const job = await WorkOrder.findByIdAndUpdate(
    id,
    { status: "finished", actualEnd: new Date() },
    { new: true }
  );

  res.json({ job });
};

exports.uploadImage = async (req, res) => {
  try {
    const id = req.params.id;
    const type = req.params.type; // before | after
    const file = req.file;

    if (!file) {
      return res.status(400).json({ message: "ไม่พบไฟล์รูป" });
    }

    const field = type === "before" ? "progress.beforeImages" : "progress.afterImages";

    const workOrder = await WorkOrder.findByIdAndUpdate(
      id,
      { $push: { [field]: file.filename } },
      { new: true }
    );

    return res.json({
      message: "อัปโหลดรูปสำเร็จ",
      workOrder,
      file: file.filename,
    });
  } catch (err) {
    res.status(500).json({ message: "เกิดข้อผิดพลาด", error: err.message });
  }
};

