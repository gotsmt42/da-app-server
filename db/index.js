// db.js
const mongoose = require('mongoose');

mongoose.connect('mongodb://127.0.0.1:27017/myapp', {

})
.then(() => console.log('Connected to MongoDB'))
.catch((err) => console.error('Connection error', err));

module.exports = mongoose;