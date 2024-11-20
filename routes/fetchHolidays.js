const express = require("express");
const axios = require("axios");
const router = express.Router();


const API_URL = "https://apigw1.bot.or.th/bot/public/financial-institutions-holidays/";
const API_KEY = "8e68e314-5a3a-45ec-a248-d243ec0bd097";

router.get("/", verifyToken, async (req, res, next) => {
    try {
    //   const year = req.query.year || "2024";
      const response = await axios.get(API_URL, {
        headers: { "X-IBM-Client-Id": API_KEY },
        // params: { year },
      });
      res.json(response.data.result?.data || []);
    } catch (error) {
      next(error);  // ส่งต่อ error ไปยัง error handler
    }
  });
  
module.exports = router;
