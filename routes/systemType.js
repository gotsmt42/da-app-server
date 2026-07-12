const SystemType = require("../models/SystemType");
const createLookupRouter = require("./lookupCrud");

module.exports = createLookupRouter(SystemType, "ระบบ");
