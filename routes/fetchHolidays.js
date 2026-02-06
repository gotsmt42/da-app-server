const express = require("express");
const axios = require("axios");
const router = express.Router();

const API_URL = "https://api.iapp.co.th/v3/store/data/thai-holiday";
const API_KEY = process.env.THAI_HOLIDAY_API_KEY;

router.get("/", async (req, res, next) => {
  try {
    const year = req.query.year || new Date().getFullYear();

    const response = await axios.get(API_URL, {
      headers: { apikey: API_KEY }, // ✅ ใช้ header แบบนี้ตามภาพ
      params: { holiday_type: "public", year }, // ✅ holiday_type ต้องใส่
    });


    res.json(response.data.data || response.data || []);
  } catch (error) {
    console.error("❌ Error fetching Thai holidays:", error.response?.status, error.response?.data || error.message);

    const fallbackHolidays = [
      { date: `${new Date().getFullYear()}-01-01`, name: "วันปีใหม่" },
      { date: `${new Date().getFullYear()}-04-13`, name: "วันสงกรานต์" },
    ];
    res.json(fallbackHolidays);
  }
});

module.exports = router;
