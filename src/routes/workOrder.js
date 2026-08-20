const express = require("express");
const router = express.Router();
const controller = require("../controllers/workOrderController");

const upload = require("../middleware/uploadWorkOrderImage");


router.get("/my-jobs/:userId", controller.getMyJobs);

router.patch("/:id/start", controller.startJob);
router.patch("/:id/finish", controller.finishJob);


router.post(
  "/:id/upload/:type", 
  upload.single("image"), 
  controller.uploadImage
);


module.exports = router;
