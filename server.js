const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFile } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const EXPIRY_MS = 15 * 60 * 1000; // 15 minutes
const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB

// Formats that need Calibre conversion to EPUB first
const CALIBRE_FORMATS = ['.pdf', '.mobi', '.azw', '.azw3', '.fb2', '.djvu', '.cbz', '.cbr', '.txt'];
// Formats that can go directly to kepubify (already EPUB)
const EPUB_EXT = '.epub';

// Ensure uploads directory exists
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// In-memory store
const fileStore = new Map();

// Multer config
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const unique = crypto.randomBytes(8).toString('hex');
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${unique}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE }
});

app.use(express.static(path.join(__dirname, 'public')));
app.set('trust proxy', true);

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars[crypto.randomInt(chars.length)];
  }
  if (fileStore.has(code)) return generateCode();
  return code;
}

// ─── CONVERSION HELPERS ───────────────────────────────────

// Convert any format to EPUB using Calibre's ebook-convert
function convertToEpub(inputPath) {
  return new Promise((resolve, reject) => {
    const outputPath = inputPath.replace(/\.[^.]+$/, '.epub');
    console.log(`[CONVERT] Calibre: ${path.basename(inputPath)} → EPUB`);

    execFile('ebook-convert', [inputPath, outputPath], {
      timeout: 120000 // 2 min timeout
    }, (err, stdout, stderr) => {
      if (err) {
        console.error(`[CONVERT ERROR] Calibre: ${err.message}`);
        return reject(new Error('Conversion to EPUB failed'));
      }
      console.log(`[CONVERT] Calibre done: ${path.basename(outputPath)}`);
      resolve(outputPath);
    });
  });
}

// Convert EPUB to Kobo EPUB using kepubify
function convertToKepub(inputPath) {
  return new Promise((resolve, reject) => {
    const dir = path.dirname(inputPath);
    const base = path.basename(inputPath, '.epub');
    const outputPath = path.join(dir, `${base}.kepub.epub`);

    console.log(`[CONVERT] Kepubify: ${path.basename(inputPath)} → KEPUB`);

    execFile('kepubify', ['-o', outputPath, inputPath], {
      timeout: 60000
    }, (err, stdout, stderr) => {
      if (err) {
        console.error(`[CONVERT ERROR] Kepubify: ${err.message}`);
        return reject(new Error('Conversion to Kobo EPUB failed'));
      }
      console.log(`[CONVERT] Kepubify done: ${path.basename(outputPath)}`);
      resolve(outputPath);
    });
  });
}

// Full conversion pipeline
async function convertForKobo(inputPath, originalName) {
  const ext = path.extname(inputPath).toLowerCase();
  let epubPath = inputPath;
  const tempFiles = []; // track files to clean up on error

  try {
    // Step 1: If not EPUB, convert to EPUB first via Calibre
    if (CALIBRE_FORMATS.includes(ext)) {
      epubPath = await convertToEpub(inputPath);
      tempFiles.push(epubPath);
    }

    // Step 2: Convert EPUB → Kobo EPUB via kepubify
    const kepubPath = await convertToKepub(epubPath);

    // Clean up intermediate EPUB if we created one
    if (epubPath !== inputPath && fs.existsSync(epubPath)) {
      fs.unlinkSync(epubPath);
    }

    // Build the output filename
    const baseName = path.basename(originalName, path.extname(originalName));
    const kepubName = `${baseName}.kepub.epub`;

    return { filePath: kepubPath, fileName: kepubName };

  } catch (err) {
    // Clean up temp files on error
    for (const f of tempFiles) {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
    throw err;
  }
}

// ─── ENDPOINTS ────────────────────────────────────────────

// Upload file
app.post('/upload', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  const convertToKoboFlag = req.query.kepub === '1' || req.query.kepub === 'true';
  const code = generateCode();
  const now = Date.now();
  const protocol = req.protocol;
  const host = req.get('host');
  const baseUrl = `${protocol}://${host}`;

  console.log(`[UPLOAD] Code: ${code} | File: ${req.file.originalname} | Size: ${(req.file.size / 1024 / 1024).toFixed(2)}MB | Kepub: ${convertToKoboFlag}`);

  if (convertToKoboFlag) {
    // Store with "converting" status
    fileStore.set(code, {
      filePath: req.file.path,
      originalName: req.file.originalname,
      size: req.file.size,
      createdAt: now,
      expiresAt: now + EXPIRY_MS,
      status: 'converting'
    });

    // Send response immediately so frontend can show code
    res.json({
      code,
      fileName: req.file.originalname,
      size: req.file.size,
      expiresAt: now + EXPIRY_MS,
      baseUrl,
      converting: true
    });

    // Convert in background
    try {
      const result = await convertForKobo(req.file.path, req.file.originalname);
      const entry = fileStore.get(code);
      if (entry) {
        // Remove original file
        if (fs.existsSync(req.file.path) && req.file.path !== result.filePath) {
          fs.unlinkSync(req.file.path);
        }
        entry.filePath = result.filePath;
        entry.originalName = result.fileName;
        entry.status = 'waiting';
        try {
          const stats = fs.statSync(result.filePath);
          entry.size = stats.size;
        } catch (e) {}
        fileStore.set(code, entry);
        console.log(`[CONVERT] Code ${code} ready: ${result.fileName}`);
      }
    } catch (err) {
      console.error(`[CONVERT FAILED] Code ${code}: ${err.message}`);
      const entry = fileStore.get(code);
      if (entry) {
        entry.status = 'error';
        entry.error = err.message;
        fileStore.set(code, entry);
      }
    }

  } else {
    // No conversion — store directly
    fileStore.set(code, {
      filePath: req.file.path,
      originalName: req.file.originalname,
      size: req.file.size,
      createdAt: now,
      expiresAt: now + EXPIRY_MS,
      status: 'waiting'
    });

    res.json({
      code,
      fileName: req.file.originalname,
      size: req.file.size,
      expiresAt: now + EXPIRY_MS,
      baseUrl,
      converting: false
    });
  }
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
    size: entry.size,
    error: entry.error || null
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

  if (entry.status === 'converting') {
    return res.status(202).json({ error: 'File is still being converted, please wait' });
  }

  if (entry.status === 'error') {
    return res.status(500).json({ error: 'Conversion failed: ' + (entry.error || 'unknown') });
  }

  if (!fs.existsSync(entry.filePath)) {
    fileStore.delete(code);
    return res.status(404).json({ error: 'File not found on server' });
  }

  entry.status = 'connected';
  fileStore.set(code, entry);

  console.log(`[DOWNLOAD] Code: ${code} | File: ${entry.originalName}`);

  res.download(entry.filePath, entry.originalName, (err) => {
    if (err && !res.headersSent) {
      console.error(`[ERROR] Download failed for ${code}:`, err.message);
    }
  });
});

app.get('/kobo', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'kobo.html'));
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', files: fileStore.size });
});

// ─── CLEANUP ──────────────────────────────────────────────

function cleanupEntry(code) {
  const entry = fileStore.get(code);
  if (entry) {
    try {
      if (fs.existsSync(entry.filePath)) {
        fs.unlinkSync(entry.filePath);
        console.log(`[CLEANUP] Deleted file for code: ${code}`);
      }
    } catch (e) {
      console.error(`[CLEANUP ERROR] ${code}:`, e.message);
    }
    fileStore.delete(code);
  }
}

setInterval(() => {
  const now = Date.now();
  for (const [code, entry] of fileStore.entries()) {
    if (now > entry.expiresAt) {
      cleanupEntry(code);
    }
  }
}, 60 * 1000);

// ─── START ────────────────────────────────────────────────

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  📚 KoboSend running on port ${PORT}\n`);
});
