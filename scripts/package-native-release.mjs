import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// Run only after the real browser boot check succeeds. The generated manifest
// must be committed separately to select this immutable release for Pages.
const hostCommit = process.env.GITHUB_SHA;
const runId = process.env.GITHUB_RUN_ID;
if (!/^[a-f0-9]{40}$/.test(hostCommit || '') || !/^[1-9][0-9]*$/.test(runId || '')) {
  throw new Error('A GitHub commit and workflow run are required to package a native release.');
}
const root = process.cwd();
const releaseDir = path.join(root, 'native-release');
const coreDir = path.join(root, 'public/core');
const tag = `core-${hostCommit.slice(0, 12)}-${runId}`;
const dolphinCommit = 'f8603f14e7f5a090e6693857d625a55ea9330534';
const emscripten = process.env.EMSCRIPTEN_VERSION;
const buildProfile = process.env.DWEB_BUILD_PROFILE || 'optimized';
if (!['baseline', 'optimized'].includes(buildProfile)) throw new Error('Known native build profile required.');
if (!/^\d+\.\d+\.\d+$/.test(emscripten || '')) throw new Error('Pinned Emscripten version required.');
await fs.mkdir(releaseDir, { recursive: false });

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

const names = (await fs.readdir(coreDir)).filter(name =>
  /^dolphin-core\.(?:js|wasm|data|(?:[A-Za-z0-9_-]+\.)?worker\.js)$/.test(name)).sort();
for (const required of ['dolphin-core.js', 'dolphin-core.wasm', 'dolphin-core.data']) {
  if (!names.includes(required)) throw new Error(`Missing native artifact: ${required}`);
}
const files = [];
for (const name of names) {
  const file = path.join(releaseDir, name);
  await fs.copyFile(path.join(coreDir, name), file);
  files.push({ name, sha256: await sha256(file) });
}

// Include the complete patched Dolphin tree and checked-out dependencies,
// including licenses, plus the exact browser host, patches and build scripts.
const sourceName = 'dolphin-browser-source.tar.gz';
const sourceFile = path.join(releaseDir, sourceName);
const packed = spawnSync('tar', [
  '--exclude=.git', '-czf', sourceFile,
  '-C', path.join(root, 'native/.build'), 'dolphin',
  '-C', root, 'native/BrowserHost.cpp', 'native/build-dolphin-wasm.sh',
  'native/bootstrap-emsdk-and-build.sh', 'native/patches', 'native/tests',
  'native/README.md', '.github/workflows/native-core.yml',
], { stdio: 'inherit' });
if (packed.error) throw packed.error;
if (packed.status !== 0) throw new Error(`Source archive failed: ${packed.status}`);
const source = { name: sourceName, sha256: await sha256(sourceFile) };
const manifest = { schemaVersion: 1, tag, hostCommit, dolphinCommit, emscripten, buildProfile, runId, source, files };
await fs.writeFile(path.join(releaseDir, 'native-core-release.json'), JSON.stringify(manifest, null, 2) + '\n');
await fs.writeFile(path.join(releaseDir, 'SHA256SUMS.txt'), [...files, source]
  .map(file => `${file.sha256}  ${file.name}`).join('\n') + '\n');
await fs.writeFile(path.join(releaseDir, 'release-notes.md'), [
  'Experimental Dolphin browser core.',
  '',
  'Verified in Chromium by executing an original GameCube DOL and an original Wii WAD channel, and checking their distinct four-color video outputs.',
  'These small homebrew checks do not establish compatibility or performance for individual commercial channels or games.',
  '',
  `Dolphin source: libretro/dolphin@${dolphinCommit}`,
  `Browser port and build scripts: Ocey78/WiiClipse@${hostCommit}`,
  `Emscripten: ${emscripten}`,
  `Compiler profile: ${buildProfile}`,
  `Build and verification: https://github.com/Ocey78/WiiClipse/actions/runs/${runId}`,
  '',
  'The source archive contains the complete patched Dolphin checkout and its dependencies, including license files, plus the browser host, patches, test probes, and reproducible build scripts. The release tag retains the matching frontend.',
  '',
].join('\n'));
console.log(`Packaged verified native release ${tag}`);
