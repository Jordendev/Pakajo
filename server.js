const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const mammoth = require('mammoth');
let pdfjsLib; // wird beim Start asynchron geladen

// Worker-URL (CDN bleibt zur Kompatibilität)
const PDF_WORKER_CDN = `//cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.worker.min.js`;

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Hilfsfunktion: PDF extrahieren
async function extractPdf(url) {
  const response = await axios({
    url,
    method: 'GET',
    responseType: 'arraybuffer'
  });

  const data = new Uint8Array(response.data);
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

// Hilfsfunktion: DOCX extrahieren
async function extractDocx(url) {
  const response = await axios({
    url,
    method: 'GET',
    responseType: 'arraybuffer'
  });

  const result = await mammoth.extractRawText({ buffer: response.data });
  return result.value;
}

// Haupt-Endpunkt
app.get('/extract', async (req, res) => {
  const { url } = req.query;

  if (!url) {
    return res.status(400).json({ error: 'Missing URL parameter' });
  }

  try {
    let text = '';
    const lowerUrl = url.toLowerCase();

    if (lowerUrl.endsWith('.pdf')) {
      text = await extractPdf(url);
    } else if (lowerUrl.endsWith('.docx')) {
      text = await extractDocx(url);
    } else {
      return res.status(400).json({ error: 'Unsupported file type. Use .pdf or .docx' });
    }

    res.set('Content-Type', 'text/plain; charset=utf-8');
    res.send(text);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Extraction failed', details: err.message });
  }
});

// Health-Check
app.get('/', (req, res) => {
  res.send('PDF/DOCX Extractor is running!');
});

// Initialisierung: PDF.js asynchron laden und Server starten
async function init() {
  try {
    const mod = await import('pdfjs-dist/legacy/build/pdf.mjs');
    pdfjsLib = mod.default || mod;
    pdfjsLib.GlobalWorkerOptions.workerSrc = PDF_WORKER_CDN;

    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  } catch (err) {
    console.error('Failed to initialize PDF.js:', err);
    process.exit(1);
  }
}

init();