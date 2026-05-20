const WorkOrder = require("../models/WorkOrder");

exports.createFromEvent = async (event) => {
  const woNumber = `WO-${Date.now()}`;

  return await WorkOrder.create({
    eventId: event._id,
    woNumber,

    company: event.company,
    site: event.site,
    title: event.title,
    system: event.system,
    team: event.team,

    assignedTo: event.userId,

    plannedStart: event.start,
    plannedEnd: event.end,
  });
};
