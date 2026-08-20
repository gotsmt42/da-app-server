const JobType = require("../models/JobType");
const createLookupRouter = require("./lookupCrud");

module.exports = createLookupRouter(JobType, "ประเภทงาน");
