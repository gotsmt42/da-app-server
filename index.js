require("dotenv").config(); // เรียกใช้ dotenv เพื่อโหลด Environment Variables
const express = require("express");
const bodyParser = require("body-parser");
const morgan = require('morgan');
const axios = require("axios"); // นำเข้า axios
const cors = require("cors");

const authRouter = require("./routes/auth");
const customerRouter = require("./routes/customer");
const productRouter = require("./routes/product");
const stockProductRouter = require("./routes/stockProduct");
const fileRouter = require("./routes/file");
const holidayRouter = require("./routes/fetchHolidays");
const calendarEventRouter = require("./routes/calendarEvent");
const checkInternetConnection = require('./middleware/checkInternetConnection');

const app = express();
const PORT = process.env.PORT || 5000;

const corsOptions = {
  origin: [
    "https://da-app.vercel.app",
    "http://localhost:3000",
  ],
  credentials: true,
};

app.use(morgan("dev"));
app.use(cors(corsOptions)); // ใช้ corsOptions


app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));

app.use("/api/auth", authRouter);
app.use("/api/customer", customerRouter);
app.use("/api/product", productRouter);
app.use("/api/stockproduct", stockProductRouter);
app.use("/api/files", fileRouter);
app.use("/api/events", calendarEventRouter);
app.use("/api/holidays", holidayRouter);

// ใช้ middleware ตรวจสอบการเชื่อมต่ออินเทอร์เน็ต
app.use(checkInternetConnection);

app.use("/uploads", express.static("asset/uploads"));

// app.use(
//   "/api/asset/uploads/images",
//   express.static(__dirname + "/asset/uploads/images")
// );
app.use(
  "/api/asset/uploads/files",
  express.static(__dirname + "/asset/uploads/files")
);
app.use("/api/asset/image", express.static(__dirname + "/asset/image"));

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
