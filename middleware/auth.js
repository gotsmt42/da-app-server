const jwt = require('jsonwebtoken');
const User = require("../models/User");

module.exports = verifyToken = async (req, res, next) => {
   try {
    const authHeader = req.header("Authorization");

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ message: "Access denied. No token provided." });
    }

    const token = authHeader.replace("Bearer ", "").trim();

    const decoded = jwt.verify(token, process.env.APP_SECRET);

    const user = await User.findById(decoded.userId);

    if (!user) {
      return res.status(404).json({ message: "User not found." });
    }

    req.userId = decoded.userId;
    req.user = user;
    req.token = token;

    next();
  } catch (error) {
    if (error.name === "TokenExpiredError") {
      return res.status(401).json({ message: "Token expired" });
    }

    if (error.name === "JsonWebTokenError") {
      return res.status(403).json({ message: "Invalid token" });
    }

    console.error("❌ Token verification error:", error);
    return res.status(500).json({ message: "Internal Server Error" });
  }
};




// const jwt = require("jsonwebtoken");
// const User = require("../models/User");

// const verifyToken = async (req, res, next) => {
//   try {
//     const authHeader = req.header("Authorization");

//     if (!authHeader || !authHeader.startsWith("Bearer ")) {
//       return res.status(401).json({ message: "Access denied. No token provided." });
//     }

//     const token = authHeader.replace("Bearer ", "").trim();

//     const decoded = jwt.verify(token, process.env.APP_SECRET);

//     const user = await User.findById(decoded.userId);

//     if (!user) {
//       return res.status(404).json({ message: "User not found." });
//     }

//     req.userId = decoded.userId;
//     req.user = user;
//     req.token = token;

//     next();
//   } catch (error) {
//     if (error.name === "TokenExpiredError") {
//       return res.status(401).json({ message: "Token expired" });
//     }

//     if (error.name === "JsonWebTokenError") {
//       return res.status(403).json({ message: "Invalid token" });
//     }

//     console.error("❌ Token verification error:", error);
//     return res.status(500).json({ message: "Internal Server Error" });
//   }
// };

// module.exports = verifyToken;






// const jwt = require('jsonwebtoken');
// const User = require("../models/User");

// module.exports = verifyToken = async (req, res, next) => {
//     try {
//         const token = req.header('Authorization').replace('Bearer ', '').trim();
        
//         if (!token) {
//             return res.status(401).send('Access denied. No token provided.');
//         }
        
//         const decoded = jwt.verify(token, process.env.APP_SECRET);
        
//         // ค้นหาข้อมูลผู้ใช้โดยใช้ Payload จาก Token
//         const user = await User.findById(decoded.userId);
        
//         if (!user) {
//             return res.status(404).send('User not found.');
//         }

//         console.log(token);
        
        
//         req.userId = decoded.userId;
//         req.user = user; // เพิ่มข้อมูลผู้ใช้ใน req object สำหรับการใช้งานใน middleware ต่อไป (ถ้าต้องการ)
        
//         next();
//     } catch (error) {
//         if (error instanceof jwt.JsonWebTokenError) {
//             return res.status(403).send('Invalid token.');
//         }
//         console.error(error);
//         return res.status(500).send('Internal Server Error.');
//     }
// };



