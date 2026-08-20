const dns = require('dns');

function checkInternetConnection(req, res, next) {
  dns.lookup('google.com', (err) => {
    if (err && err.code === 'ENOTFOUND') {
      // ไม่มีการเชื่อมต่ออินเทอร์เน็ต
      return res.status(503).json({ message: 'No internet connection. Please check your connection and try again.' });
    }
    // มีการเชื่อมต่ออินเทอร์เน็ต
    next();
  });
}

module.exports = checkInternetConnection;
