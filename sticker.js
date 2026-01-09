const sharp = require('sharp');

function escapeXml(unsafe) {
  return String(unsafe)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function wrapText(text, maxChars = 12) {
  const words = String(text).trim().split(/\s+/);
  const lines = [];
  let line = '';

  for (const w of words) {
    if ((line + ' ' + w).trim().length <= maxChars) {
      line = (line + ' ' + w).trim();
    } else {
      if (line) lines.push(line);
      line = w;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * Versi Optimasi: Teks Besar, Rata Kanan, Mulai dari Atas
 */
async function createStickerFromText(text, opts = {}) {
  const t = String(text || '').trim();
  if (!t) throw new Error('Empty text');

  // Pengaturan default yang lebih besar untuk stiker
  const maxChars = opts.maxChars || 10; 
  const lines = wrapText(t, maxChars);
  
  // Font diperbesar (default 85 agar terlihat bold/besar di stiker 512x512)
  const fontSize = opts.fontSize || 85; 
  const lineHeight = Math.round(fontSize * 1.1);
  const padding = opts.padding != null ? opts.padding : 40;
  const width = opts.width || 512;
  const bg = opts.bg || '#ffffff';
  const fill = opts.fill || '#000000';
  const fontFamily = opts.fontFamily || 'Arial, sans-serif';
  
  // Kalkulasi tinggi dinamis berdasarkan jumlah baris
  const height = padding * 2 + lines.length * lineHeight;

  // Logika Rata Kanan
  const x = width - padding;
  const anchor = 'end'; // Menarik teks ke arah kiri dari titik X (rata kanan)

  const svgLines = lines.map((ln, i) => {
    // y dihitung agar baris pertama benar-benar berada di dekat padding atas
    const y = padding + (i * lineHeight) + (fontSize / 0.85); 
    return `<text x="${x}" y="${y}" text-anchor="${anchor}" font-weight="bold">${escapeXml(ln)}</text>`;
  }).join('\n');

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <rect width="100%" height="100%" fill="${bg}" />
  <g font-family="${fontFamily}" font-size="${fontSize}" fill="${fill}">
    ${svgLines}
  </g>
</svg>`;

  const svgBuffer = Buffer.from(svg);

  // Output WebP dengan kualitas tajam
  return await sharp(svgBuffer)
    .webp({ lossless: true, quality: 100 })
    .toBuffer();
}

module.exports = { createStickerFromText };