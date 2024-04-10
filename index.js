require('dotenv').config(); // เรียกใช้ dotenv เพื่อโหลด Environment Variables

const express = require('express');
const bodyParser = require('body-parser');
const authRouter = require('./routes/auth');
const productRouter = require('./routes/product');
const fileRouter = require('./routes/file');
const calendarEventRouter = require('./routes/calendarEvent');
const cors = require('cors');
const fs = require('fs');
const https = require('https');

const app = express();
const PORT = process.env.APP_PORT;


const corsOptions = {
  origin: ['https://your-mobile-domain.com', 'http://localhost:3000'], // ระบุโดเมนที่ยอมรับ CORS requests จากนั้น
  credentials: true, // อนุญาตให้ส่ง cookies ระหว่างโดเมน
};

app.use(cors());

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

app.use('/api/auth', authRouter);
app.use('/api/product', productRouter);
app.use('/api/files', fileRouter);
app.use('/api/events', calendarEventRouter);
app.use('/api/asset/uploads/images', express.static(__dirname + '/asset/uploads/images'));
app.use('/api/asset/uploads/files', express.static(__dirname + '/asset/uploads/files'));

app.use('/api/asset/image', express.static(__dirname + '/asset/image'));


const options = {
  key: fs.readFileSync("C:/Program Files/OpenSSL-Win64/keys/localhost.key"),
  cert: fs.readFileSync("C:/Program Files/OpenSSL-Win64/keys/localhost.crt")
};


const server = https.createServer(options, app);

server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
