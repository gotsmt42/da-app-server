require("dotenv").config(); // เรียกใช้ dotenv เพื่อโหลด Environment Variables
const express = require("express");
const bodyParser = require("body-parser");
const morgan = require('morgan');
const axios = require("axios"); // นำเข้า axios
const cors = require("cors");

const authRouter = require("./routes/auth");
const productRouter = require("./routes/product");
const stockProductRouter = require("./routes/stockProduct");
const fileRouter = require("./routes/file");
const calendarEventRouter = require("./routes/calendarEvent");
const checkInternetConnection = require('./middleware/checkInternetConnection');

const app = express();
const PORT = process.env.APP_PORT || 8080;

const corsOptions = {
  origin: [
    "https://da-app.vercel.app",
    "http://localhost:3000",
  ],
  credentials: true,
};

app.use(morgan("dev"));
app.use(cors(corsOptions)); // ใช้ corsOptions

app.get('/api/holidays', async (req, res) => {
  const url = 'https://www.myhora.com/calendar/ical/holiday.aspx?latest.json';
  try {
    const response = await axios.get(url);
    res.json(response.data); // ส่งข้อมูลที่ได้กลับไป
  } catch (error) {
    console.error("Error fetching holidays:", error);
    res.status(error.response?.status || 500).send(error.message); // ส่งสถานะที่ถูกต้องกลับ
  }
});

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));

app.use("/api/auth", authRouter);
app.use("/api/product", productRouter);
app.use("/api/stockproduct", stockProductRouter);
app.use("/api/files", fileRouter);
app.use("/api/events", calendarEventRouter);

// ใช้ middleware ตรวจสอบการเชื่อมต่ออินเทอร์เน็ต
app.use(checkInternetConnection);

app.use(
  "/api/asset/uploads/images",
  express.static(__dirname + "/asset/uploads/images")
);
app.use(
  "/api/asset/uploads/files",
  express.static(__dirname + "/asset/uploads/files")
);
app.use("/api/asset/image", express.static(__dirname + "/asset/image"));

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
