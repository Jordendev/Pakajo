const express = require('express');
const axios = require('axios');
const mammoth = require('mammoth');
let pdfjsLib = null;

// Initialize pdfjs (prefer legacy build in Node.js). This is async because
// the legacy distribution ships as ESM (.mjs) and must be dynamically imported.
async function initPdfjs() {
  // Try dynamic import for legacy .mjs
  try {
    const mod = await import('pdfjs-dist/legacy/build/pdf.mjs');
    pdfjsLib = mod && (mod.default || mod);

    // Try to point workerSrc to the local worker file where possible
    try {
      const workerPath = require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs');
      pdfjsLib.GlobalWorkerOptions.workerSrc = workerPath;
    } catch (e) {
      console.warn('Could not resolve legacy pdf.worker.mjs — workerSrc left unset');
    }

    console.log('Using pdfjs-dist legacy build (via dynamic import)');
    return;
  } catch (err) {
    // Fallback to the default package (may still work)
    try {
      pdfjsLib = require('pdfjs-dist');
      pdfjsLib.GlobalWorkerOptions.workerSrc = `//cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.worker.min.js`;
      console.warn('pdfjs-dist legacy build not found; using default build');
      return;
    } catch (e2) {
      console.error('Failed to load pdfjs-dist:', e2 && e2.stack ? e2.stack : e2);
      throw e2;
    }
  }
}

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// PDF-Text extrahieren
async function extractPdf(buffer) {
  const data = new Uint8Array(buffer);
  const doc = await pdfjsLib.getDocument({ data }).promise;
  let text = '';
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const strings = content.items.map(item => item.str);
    text += strings.join(' ') + '\n';
  }
  return text;
}

// DOCX-Text extrahieren
async function extractDocx(buffer) {
  const result = await mammoth.extractRawText({ buffer });
  return result.value;
}

// Haupt-Endpunkt: /extract?url=...
app.get('/extract', async (req, res) => {
  // Hole die URL aus ?url=...
  const { url } = req.query;

  if (!url) {
    return res.status(400).json({ error: 'Missing URL parameter' });
  }

  try {
    // Robust URL parsing and filename/extension extraction
    // - Use URL API to handle encoded paths and avoid naive split('?') pitfalls
    // - Decode and sanitize filename; infer extension from Content-Type if missing
    // - After redirects, attempt to extract filename from final URL (if available)
    let filename = '';
    let ext = '';

    let parsedUrl;
    try {
      parsedUrl = new URL(url);
    } catch (e) {
      return res.status(400).json({ error: 'Invalid URL parameter', message: e.message });
    }

    // Extract filename from path (decoded) and sanitize
    filename = decodeURIComponent((parsedUrl.pathname.split('/').pop() || '')).trim();
    filename = filename.replace(/[\r\n]/g, '').trim();
    ext = (filename.split('.').pop() || '').toLowerCase().trim();
    ext = ext.replace(/[^a-z0-9]/g, '');

    // Download file (follow redirects). If filename/extension are missing we will attempt to detect from headers.
    const response = await axios({
      url,
      method: 'GET',
      responseType: 'arraybuffer',
      timeout: 30000,
      maxRedirects: 5
    });

    // Attempt to detect final URL / filename after redirects
    const finalUrl = (response.request && response.request.res && response.request.res.responseUrl) || (response.config && response.config.url) || url;
    if (!filename && finalUrl) {
      try {
        const p = new URL(finalUrl);
        filename = decodeURIComponent((p.pathname.split('/').pop() || '')).trim();
        filename = filename.replace(/[\r\n]/g, '').trim();
        ext = (filename.split('.').pop() || '').toLowerCase().trim();
        ext = ext.replace(/[^a-z0-9]/g, '');
      } catch (e) {
        // ignore
      }
    }

    const contentType = (response.headers && (response.headers['content-type'] || response.headers['Content-Type'])) || '';

    // If extension still unknown, infer from content-type
    if (!ext) {
      if (contentType.includes('pdf')) ext = 'pdf';
      else if (contentType.includes('officedocument') || contentType.includes('word') || contentType.includes('msword') || contentType.includes('application/vnd')) ext = 'docx';
    }

    let text = '';

    if (ext === 'pdf') {
      // If pdfjs isn't ready yet, attempt an on-demand init with a short timeout.
      if (!pdfjsLib) {
        try {
          await Promise.race([
            initPdfjs(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('pdfjs init timeout')), 5000))
          ]);
        } catch (e) {
          return res.status(503).json({ error: 'PDF handler not ready', message: e.message });
        }
      }
      text = await extractPdf(response.data);
    } else if (ext === 'docx') {
      text = await extractDocx(response.data);
    } else {
      // Provide detailed debugging info to help callers
      return res.status(400).json({
        error: 'Unsupported file type... Use .pdf or .docx',
        filename,
        detectedExtension: ext,
        contentType,
        finalUrl
      });
    }

    res.set('Content-Type', 'text/plain; charset=utf-8');
    res.send(text);
  } catch (err) {
    console.error('Extraction error:', err && err.stack ? err.stack : err.message);
    if (err.response) {
      // Upstream returned an error (e.g. signed URL rejection). Surface useful debug info.
      const upstreamStatus = err.response.status;
      const upstreamType = (err.response.headers && (err.response.headers['content-type'] || err.response.headers['Content-Type'])) || '';
      let upstreamBodyPreview;
      const body = err.response.data;
      if (typeof body === 'string') {
        upstreamBodyPreview = body.slice(0, 200);
      } else if (Buffer.isBuffer(body)) {
        upstreamBodyPreview = body.toString('utf8', 0, 200);
      } else {
        try {
          upstreamBodyPreview = JSON.stringify(body).slice(0, 200);
        } catch (e) {
          upstreamBodyPreview = undefined;
        }
      }

      // Detect common signed-URL JWT errors (Supabase returns JSON with InvalidJWT / exp failure)
      const previewLower = (upstreamBodyPreview || '').toLowerCase();
      const isInvalidJwt = upstreamStatus === 400 && (
        previewLower.includes('invalidjwt') ||
        previewLower.includes('"exp"') ||
        /exp.*(fail|expired)/i.test(upstreamBodyPreview || '')
      );

      if (isInvalidJwt) {
        return res.status(401).json({
          error: 'Upstream token invalid or expired',
          upstreamStatus,
          upstreamContentType: upstreamType,
          upstreamBodyPreview,
          suggestion: 'Regenerate signed URL or refresh token'
        });
      }

      return res.status(502).json({
        error: 'Upstream fetch failed',
        upstreamStatus,
        upstreamContentType: upstreamType,
        upstreamBodyPreview,
        message: err.message
      });
    }

    res.status(500).json({
      error: 'Extraction failed',
      message: err.message
    });
  }
});

// Build/version tag for runtime verification
const BUILD_TAG = 'enhanced-fallback-20260114-2';

// Health-Check
app.get('/', (req, res) => {
  res.send('PDF/DOCX Extractor is running!');
});

// Version/Debug endpoint to verify deployed code
app.get('/_version', (req, res) => {
  res.json({
    name: 'Pakajo Extractor',
    build: BUILD_TAG,
    features: {
      robustFilenameExtraction: true,
      contentTypeFallback: true,
      detailedUpstreamErrors: true
    }
  });
});

// Start server AFTER pdfjs initialization; handle listen errors (e.g. EADDRINUSE)
// Start pdfjs init in background (non-blocking) so server can come up fast.
initPdfjs()
  .then(() => console.log('pdfjs initialized (background)'))
  .catch((err) => console.warn('pdfjs initialization failed in background:', err && err.message ? err.message : err));

const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} bereits in Benutzung. Beende vorhandenen Prozess oder setze PORT auf einen anderen Wert (z.B. PORT=3001).`);
    console.error('Tipp: `lsof -i :3000` oder `ss -ltnp | grep 3000` verwenden, dann `kill <PID>`');
    process.exit(1);
  }
  console.error('Server error:', err);
  process.exit(1);
});