// Download the Electron prebuilt binary for this platform.
//
// `npm install` cannot run electron's postinstall here (the sandbox blocks the
// child-process spawn), so we fetch the release zip ourselves and let
// PowerShell unpack it.
import { mkdir, writeFile, readFile, access } from 'node:fs/promises';
import path from 'node:path';

const electronDir = path.resolve('node_modules/electron');
const version = JSON.parse(await readFile(path.join(electronDir, 'package.json'), 'utf8')).version;

const platform = process.platform === 'win32' ? 'win32' : process.platform;
const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
const zipName = `electron-v${version}-${platform}-${arch}.zip`;
const url = `https://github.com/electron/electron/releases/download/v${version}/${zipName}`;

const outDir = path.resolve('.electron-cache');
const zipPath = path.join(outDir, zipName);

await mkdir(outDir, { recursive: true });

let haveZip = false;
try {
  await access(zipPath);
  haveZip = true;
} catch { /* not cached yet */ }

if (!haveZip) {
  console.log(`downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(zipPath, buf);
  console.log(`saved ${zipPath} (${(buf.length / 1048576).toFixed(1)} MB)`);
} else {
  console.log(`using cached ${zipPath}`);
}

console.log(`ZIP=${zipPath}`);
console.log(`DEST=${path.join(electronDir, 'dist')}`);
