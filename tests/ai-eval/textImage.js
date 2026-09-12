/**
 * Render a short ASCII string to a PNG buffer with no image dependencies.
 *
 * The OCR endpoint is the only place the app trusts a model to read a date off a
 * product label, and it was the only endpoint never exercised against the real
 * model. A 5x7 bitmap font scaled up gives a clean, deterministic label image to
 * feed it — no fixtures to commit, no rendering library to install.
 */

const zlib = require('zlib');

const FONT = {
    '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
    '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
    '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
    '3': ['11111', '00010', '00100', '00010', '00001', '10001', '01110'],
    '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
    '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
    '6': ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
    '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
    '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
    '9': ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
    'E': ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
    'X': ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
    'P': ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
    'B': ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
    'D': ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
    'M': ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
    'F': ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
    'G': ['01110', '10001', '10000', '10111', '10001', '10001', '01111'],
    'H': ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
    'L': ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
    'O': ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
    'W': ['10001', '10001', '10001', '10101', '10101', '11011', '10001'],
    'R': ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
    '/': ['00001', '00001', '00010', '00100', '01000', '10000', '10000'],
    '.': ['00000', '00000', '00000', '00000', '00000', '01100', '01100'],
    '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
    ':': ['00000', '01100', '01100', '00000', '01100', '01100', '00000'],
    ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000']
};

const GLYPH_W = 5;
const GLYPH_H = 7;

const CRC_TABLE = (() => {
    const table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c;
    }
    return table;
})();

function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([len, body, crc]);
}

/**
 * @param {string[]} lines   text lines (uppercase ASCII the FONT above covers)
 * @param {object}   [opts]
 * @param {number}   [opts.scale]    pixels per font pixel (default 14)
 * @param {number}   [opts.padding]  border in scaled pixels (default 3)
 * @returns {Buffer} PNG bytes, black text on white
 */
function renderTextPng(lines, { scale = 14, padding = 3 } = {}) {
    const cols = Math.max(...lines.map((l) => l.length));
    const width = (cols * (GLYPH_W + 1) + padding * 2) * scale;
    const height = (lines.length * (GLYPH_H + 2) + padding * 2) * scale;

    // One byte per pixel, greyscale, 0 = black, 255 = white.
    const pixels = Buffer.alloc(width * height, 255);

    lines.forEach((line, lineIndex) => {
        [...line.toUpperCase()].forEach((ch, charIndex) => {
            const glyph = FONT[ch];
            if (!glyph) return;
            for (let gy = 0; gy < GLYPH_H; gy++) {
                for (let gx = 0; gx < GLYPH_W; gx++) {
                    if (glyph[gy][gx] !== '1') continue;
                    const baseX = (padding + charIndex * (GLYPH_W + 1) + gx) * scale;
                    const baseY = (padding + lineIndex * (GLYPH_H + 2) + gy) * scale;
                    for (let sy = 0; sy < scale; sy++) {
                        const row = (baseY + sy) * width;
                        pixels.fill(0, row + baseX, row + baseX + scale);
                    }
                }
            }
        });
    });

    // PNG scanlines: one filter byte (0 = none) per row.
    const raw = Buffer.alloc((width + 1) * height);
    for (let y = 0; y < height; y++) {
        raw[y * (width + 1)] = 0;
        pixels.copy(raw, y * (width + 1) + 1, y * width, (y + 1) * width);
    }

    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;   // bit depth
    ihdr[9] = 0;   // colour type: greyscale
    ihdr[10] = 0;  // compression
    ihdr[11] = 0;  // filter
    ihdr[12] = 0;  // interlace

    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
        chunk('IEND', Buffer.alloc(0))
    ]);
}

module.exports = { renderTextPng };
