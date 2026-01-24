const express = require('express');
const router = express.Router();
const multer = require('multer');
const mafileService = require('../services/mafileService');

// Configure multer for ZIP uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB max
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/zip' || file.originalname.endsWith('.zip')) {
      cb(null, true);
    } else {
      cb(new Error('Only ZIP files are allowed'));
    }
  }
});

// Get all MAFiles
router.get('/api/mafiles', (req, res) => {
  try {
    const mafiles = mafileService.getAll();
    res.json(mafiles);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get single MAFile
router.get('/api/mafiles/:id', (req, res) => {
  try {
    const mafile = mafileService.getById(parseInt(req.params.id));
    if (!mafile) {
      return res.status(404).json({ error: 'MAFile not found' });
    }
    res.json(mafile);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Import MAFiles from folder
router.post('/api/mafiles/import/folder', (req, res) => {
  try {
    const { path } = req.body;
    if (!path) {
      return res.status(400).json({ error: 'Folder path required' });
    }

    const result = mafileService.importFromFolder(path);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Import MAFile from content (used by browser folder picker)
const contentUpload = multer({ storage: multer.memoryStorage() });
router.post('/api/mafiles/import/content', contentUpload.none(), (req, res) => {
  try {
    const { content, filename } = req.body;
    if (!content) {
      return res.status(400).json({ error: 'MAFile content required' });
    }

    const result = mafileService.importFromContent(content, filename || 'unknown.maFile');
    if (result) {
      res.json({ success: true, mafile: result });
    } else {
      res.json({ success: true, message: 'MAFile already exists' });
    }
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Import MAFiles from ZIP upload
router.post('/api/mafiles/import/zip', upload.single('file'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'ZIP file required' });
    }

    const result = mafileService.importFromZip(req.file.buffer);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Link MAFile to account
router.post('/api/mafiles/:id/link/:accountId', (req, res) => {
  try {
    const mafileId = parseInt(req.params.id);
    const accountId = parseInt(req.params.accountId);

    mafileService.linkToAccount(mafileId, accountId);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Delete MAFile
router.delete('/api/mafiles/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    mafileService.delete(id);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
