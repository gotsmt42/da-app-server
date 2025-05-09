module.exports = checkFile = async (req, res, next) => {

  if (req.file) {
    const filePath = req.file.path.replace("asset/", "");
    req.imageUrl = filePath;
    req.fileUrl = filePath;
    console.log("🟢 imageUrl set to:", filePath);
  }

  next();
};
