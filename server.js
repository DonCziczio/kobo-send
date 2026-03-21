const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = 3000;
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const EXPIRY_MS = 15 * 60 * 1000; // 15 minutes
const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB

// Ensure uploads directory exists
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// In-memory store: code -> { filePath, originalName, createdAt, expiresAt, status }
const fileStore = new Map();

// Multer config
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const unique = crypto.randomBytes(8).toString('hex');
    const ext = path.extname(file.originalname);
    cb(null, `${unique}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE }
});

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Generate a 6-char alphanumeric code (uppercase + digits)
function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // removed ambiguous: I,O,0,1
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars[crypto.randomInt(chars.length)];
  }
  // Make sure it's unique
  if (fileStore.has(code)) return generateCode();
  return code;
}

// ─── ENDPOINTS ────────────────────────────────────────────

// Upload file
app.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  const code = generateCode();
  const now = Date.now();

  fileStore.set(code, {
    filePath: req.file.path,
    originalName: req.file.originalname,
    size: req.file.size,
    createdAt: now,
    expiresAt: now + EXPIRY_MS,
    status: 'waiting' // waiting | connected | expired
  });

  console.log(`[UPLOAD] Code: ${code} | File: ${req.file.originalname} | Size: ${(req.file.size / 1024 / 1024).toFixed(2)}MB`);

  res.json({
    code,
    fileName: req.file.originalname,
    size: req.file.size,
    expiresAt: now + EXPIRY_MS
  });
});

// Check status
app.get('/status/:code', (req, res) => {
  const code = req.params.code.toUpperCase();
  const entry = fileStore.get(code);

  if (!entry) {
    return res.json({ status: 'expired', message: 'Code not found or expired' });
  }

  if (Date.now() > entry.expiresAt) {
    cleanupEntry(code);
    return res.json({ status: 'expired', message: 'Code has expired' });
  }

  res.json({
    status: entry.status,
    fileName: entry.originalName,
    size: entry.size
  });
});

// Download file (used by Kobo)
app.get('/download/:code', (req, res) => {
  const code = req.params.code.toUpperCase();
  const entry = fileStore.get(code);

  if (!entry) {
    return res.status(404).json({ error: 'Code not found or expired' });
  }

  if (Date.now() > entry.expiresAt) {
    cleanupEntry(code);
    return res.status(410).json({ error: 'Code has expired' });
  }

  if (!fs.existsSync(entry.filePath)) {
    fileStore.delete(code);
    return res.status(404).json({ error: 'File not found on server' });
  }

  // Mark as connected
  entry.status = 'connected';
  fileStore.set(code, entry);

  console.log(`[DOWNLOAD] Code: ${code} | File: ${entry.originalName}`);

  res.download(entry.filePath, entry.originalName, (err) => {
    if (err) {
      console.error(`[ERROR] Download failed for ${code}:`, err.message);
    }
  });
});

// Serve kobo page
app.get('/kobo', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'kobo.html'));
});

// ─── CLEANUP ──────────────────────────────────────────────

function cleanupEntry(code) {
  const entry = fileStore.get(code);
  if (entry) {
    if (fs.existsSync(entry.filePath)) {
      fs.unlinkSync(entry.filePath);
      console.log(`[CLEANUP] Deleted file for code: ${code}`);
    }
    fileStore.delete(code);
  }
}

// Run cleanup every 60 seconds
setInterval(() => {
  const now = Date.now();
  for (const [code, entry] of fileStore.entries()) {
    if (now > entry.expiresAt) {
      cleanupEntry(code);
    }
  }
}, 60 * 1000);

// ─── START ────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log('');
  console.log('  ╔══════════════════════════════════════════╗');
  console.log('  ║         📚  Kobo Send  is running        ║');
  console.log('  ╠══════════════════════════════════════════╣');
  console.log(`  ║  Upload:  http://localhost:${PORT}          ║`);
  console.log(`  ║  Kobo:    http://localhost:${PORT}/kobo     ║`);
  console.log('  ╚══════════════════════════════════════════╝');
  console.log('');
});
