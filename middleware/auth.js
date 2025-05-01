const jwt = require('jsonwebtoken');
const User = require("../models/User");

module.exports = verifyToken = async (req, res, next) => {
    try {
        const token = req.header('Authorization').replace('Bearer ', '').trim();
        
        if (!token) {
            return res.status(401).send('Access denied. No token provided.');
        }
        
        const decoded = jwt.verify(token, process.env.APP_SECRET);
        
        // ค้นหาข้อมูลผู้ใช้โดยใช้ Payload จาก Token
        const user = await User.findById(decoded.userId);
        
        if (!user) {
            return res.status(404).send('User not found.');
        }

        console.log(token);
        
        
        req.userId = decoded.userId;
        req.user = user; // เพิ่มข้อมูลผู้ใช้ใน req object สำหรับการใช้งานใน middleware ต่อไป (ถ้าต้องการ)
        
        next();
    } catch (error) {
        if (error instanceof jwt.JsonWebTokenError) {
            return res.status(403).send('Invalid token.');
        }
        console.error(error);
        return res.status(500).send('Internal Server Error.');
    }
};
