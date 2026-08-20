// db.js
const mongoose = require('mongoose');

mongoose.connect(`${process.env.APP_DATABASE}`, {

})
.then(() => console.log('Connected to MongoDB'))
.catch((err) => console.error('Connection error', err));

module.exports = mongoose;