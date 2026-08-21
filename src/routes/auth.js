const express = require('express');
const router = express.Router();
const { startDiscourseLogin, handleDiscourseCallback } = require('../controllers/authController');

// Discourseログインを開始
router.get('/discourse/login', startDiscourseLogin);

// Discourseからのコールバック
router.get('/discourse/callback', handleDiscourseCallback);

module.exports = router;