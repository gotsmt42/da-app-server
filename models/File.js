// models/User.js
const mongoose = require('../db/');

const fileSchema = new mongoose.Schema({
    filename: String,
    path: String,
    size: Number,
    
    category: String,

    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // เพิ่มฟิลด์ userId ที่เก็บ ObjectId ของผู้ใช้

}, { timestamps: true });

const File = mongoose.model('File', fileSchema);





module.exports = File;
