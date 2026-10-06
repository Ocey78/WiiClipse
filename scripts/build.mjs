import fs from 'node:fs';
import path from 'node:path';

const copyTree = (source, destination) => {
  if (!fs.existsSync(source)) return;
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(source, destination, { recursive: true, force: true });
};

fs.rmSync('dist', { recursive: true, force: true });
fs.mkdirSync('dist', { recursive: true });
copyTree('public', 'dist');
copyTree('src', 'dist/src');

const htmlPath = 'dist/index.html';
let html = fs.readFileSync(htmlPath, 'utf8').replaceAll('../src/', './src/');
fs.writeFileSync(htmlPath, html);

const swPath = 'dist/sw.js';
let sw = fs.readFileSync(swPath, 'utf8').replaceAll('../src/', './src/');
fs.writeFileSync(swPath, sw);

const coreState = fs.existsSync('dist/core/dolphin-core.wasm') ? 'with Dolphin WASM core' : 'without compiled Dolphin WASM core';
console.log(`Built dist/ ${coreState}`);
