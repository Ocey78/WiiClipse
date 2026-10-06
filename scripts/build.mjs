import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const copyTree = (source, destination) => {
  if (!fs.existsSync(source)) return;
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(source, destination, { recursive: true, force: true });
};

fs.rmSync('dist', { recursive: true, force: true });
fs.mkdirSync('dist', { recursive: true });
copyTree('public', 'dist');
copyTree('src', 'dist/src');

// All runtime assets share one version so a changed binary also invalidates its
// JavaScript loader, preloaded data, and optional generated worker scripts.
const coreDirectory = 'dist/core';
const coreFiles = fs.existsSync(coreDirectory)
  ? fs.readdirSync(coreDirectory, { withFileTypes: true })
    .filter(file => file.isFile() && /^dolphin-core(?:\.[a-z0-9_-]+)*\.(?:js|wasm|data)$/i.test(file.name))
    .map(file => file.name).sort()
  : [];
const coreHash = createHash('sha256');
for (const name of coreFiles) {
  const fileHash = createHash('sha256').update(fs.readFileSync(path.join(coreDirectory, name))).digest();
  coreHash.update(name).update('\0').update(fileHash);
}
const coreVersion = coreFiles.length ? coreHash.digest('hex') : '';
const workerPath = 'dist/src/dolphin-worker.js';
const worker = fs.readFileSync(workerPath, 'utf8');
const versionPlaceholder = '__WIICLIPSE_CORE_VERSION__';
if (!worker.includes(versionPlaceholder)) throw new Error('Core asset version placeholder is missing from dolphin-worker.js.');
fs.writeFileSync(workerPath, worker.replaceAll(versionPlaceholder, coreVersion));

const htmlPath = 'dist/index.html';
let html = fs.readFileSync(htmlPath, 'utf8').replaceAll('../src/', './src/');
fs.writeFileSync(htmlPath, html);

const swPath = 'dist/sw.js';
let sw = fs.readFileSync(swPath, 'utf8').replaceAll('../src/', './src/');
fs.writeFileSync(swPath, sw);

const coreState = fs.existsSync('dist/core/dolphin-core.wasm') ? 'with Dolphin WASM core' : 'without compiled Dolphin WASM core';
console.log(`Built dist/ ${coreState}`);
