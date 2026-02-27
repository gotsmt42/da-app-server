const express = require("express");
const router = express.Router();
const holidaysData = require("../data/thai-holidays-2026-2028.json");

router.get("/", (req, res) => {
  const year = req.query.year || new Date().getFullYear().toString();

  const holidays = holidaysData[year] || [];

  console.log(`Holidays for ${year}:`, holidays);

  res.json(holidays);
});

module.exports = router;

