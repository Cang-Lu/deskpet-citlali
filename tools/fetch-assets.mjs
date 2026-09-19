// Download the Citlali pet package from legeling/awesome-codex-pet.
// Assets are CC BY-NC 4.0 (non-commercial); code of that repo is MIT.
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const BASE = 'https://raw.githubusercontent.com/legeling/awesome-codex-pet/main';
const PET_DIR = 'pets/citlali--zaytsevzy';
const OUT = path.resolve('assets/citlali');

const files = [
  [`${PET_DIR}/spritesheet.webp`, 'spritesheet.webp'],
  [`${PET_DIR}/pet.json`, 'pet.json'],
  [`${PET_DIR}/submission.json`, 'submission.json'],
];

/** Read intrinsic size out of a WebP container without a decoder. */
function webpSize(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WEBP') {
    throw new Error('not a RIFF/WEBP file');
  }
  let off = 12;
  while (off + 8 <= buf.length) {
    const fourcc = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (fourcc === 'VP8X') {
      return {
        format: 'VP8X (extended, alpha)',
        width: buf.readUIntLE(body + 4, 3) + 1,
        height: buf.readUIntLE(body + 7, 3) + 1,
      };
    }
    if (fourcc === 'VP8 ') {
      return {
        format: 'VP8 (lossy)',
        width: buf.readUInt16LE(body + 6) & 0x3fff,
        height: buf.readUInt16LE(body + 8) & 0x3fff,
      };
    }
    if (fourcc === 'VP8L') {
      const bits = buf.readUInt32LE(body + 1);
      return {
        format: 'VP8L (lossless)',
        width: (bits & 0x3fff) + 1,
        height: ((bits >> 14) & 0x3fff) + 1,
      };
    }
    off = body + size + (size % 2);
  }
  throw new Error('no image chunk found');
}

await mkdir(OUT, { recursive: true });

for (const [remote, name] of files) {
  const url = `${BASE}/${remote}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(path.join(OUT, name), buf);
  console.log(`ok  ${name.padEnd(18)} ${String(buf.length).padStart(9)} bytes  sha256=${createHash('sha256').update(buf).digest('hex')}`);
}

const sheet = await readFile(path.join(OUT, 'spritesheet.webp'));
const { format, width, height } = webpSize(sheet);
console.log(`\nspritesheet: ${format} ${width}x${height}`);

const CELL_W = 192;
const CELL_H = 208;
const cols = width / CELL_W;
const rows = height / CELL_H;
console.log(`cell ${CELL_W}x${CELL_H} -> ${cols} columns x ${rows} rows`);
console.log(cols === 8 && rows === 11 ? 'OK: matches the v2 8x11 contract' : 'MISMATCH: expected 8x11');

const submission = JSON.parse(await readFile(path.join(OUT, 'submission.json'), 'utf8'));
console.log(`license: ${submission.license}`);
console.log(`author:  ${submission.author} (${submission.author_url})`);
console.log(`source:  ${submission.source_url}`);
