import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repository = 'https://github.com/Ocey78/WiiClipse';
const requiredFiles = ['dolphin-core.js', 'dolphin-core.wasm', 'dolphin-core.data'];
const digestPattern = /^[a-f0-9]{64}$/i;
const commitPattern = /^[a-f0-9]{40}$/i;

function validateManifest(manifest) {
  const require = (condition, message) => {
    if (!condition) throw new Error(`Invalid core release manifest: ${message}`);
  };
  require(manifest?.schemaVersion === 1, 'schemaVersion must be 1');
  require(typeof manifest.tag === 'string' && /^[a-z0-9][a-z0-9._-]{0,127}$/i.test(manifest.tag), 'unsafe release tag');
  require(typeof manifest.hostCommit === 'string' && commitPattern.test(manifest.hostCommit), 'hostCommit must be a full commit hash');
  require(typeof manifest.dolphinCommit === 'string' && commitPattern.test(manifest.dolphinCommit), 'dolphinCommit must be a full commit hash');
  require(typeof manifest.emscripten === 'string' && /^\d+\.\d+\.\d+$/.test(manifest.emscripten), 'emscripten must be a pinned version');
  require((typeof manifest.runId === 'string' && /^[1-9]\d*$/.test(manifest.runId)) ||
    (Number.isSafeInteger(manifest.runId) && manifest.runId > 0), 'runId must identify the verified workflow run');
  require(manifest.source?.name === 'dolphin-browser-source.tar.gz', 'unexpected source archive name');
  require(typeof manifest.source?.sha256 === 'string' && digestPattern.test(manifest.source.sha256), 'source archive requires a SHA-256 digest');
  require(Array.isArray(manifest.files), 'files must be an array');
  const names = new Set();
  for (const file of manifest.files) {
    require(typeof file?.name === 'string' && (requiredFiles.includes(file.name) ||
      /^dolphin-core(?:\.[a-z0-9_-]+)?\.worker\.js$/i.test(file.name)), 'unexpected core asset name');
    require(!names.has(file.name), `duplicate asset ${file.name}`);
    require(typeof file.sha256 === 'string' && digestPattern.test(file.sha256), `invalid digest for ${file.name}`);
    names.add(file.name);
  }
  require(requiredFiles.every(name => names.has(name)), 'JavaScript, WASM, and preloaded data are all required');
}

async function download(file, releaseUrl, directory, fetchImpl) {
  const response = await fetchImpl(`${releaseUrl}/${file.name}`, { signal: AbortSignal.timeout(180_000) });
  if (!response.ok) throw new Error(`Downloading ${file.name}: HTTP ${response.status}`);
  if (!response.body) throw new Error(`Downloading ${file.name}: empty response body`);
  const hash = createHash('sha256');
  await pipeline(
    Readable.fromWeb(response.body),
    new Transform({ transform(chunk, encoding, callback) { hash.update(chunk); callback(null, chunk); } }),
    createWriteStream(path.join(directory, file.name), { flags: 'wx' }),
  );
  if (hash.digest('hex') !== file.sha256.toLowerCase()) throw new Error(`SHA-256 mismatch for ${file.name}`);
}

export async function fetchCore({
  root = fileURLToPath(new URL('../', import.meta.url)),
  fetchImpl = globalThis.fetch,
  log = console.log,
} = {}) {
  const manifestPath = path.join(root, 'native/core-release.json');
  let manifestText;
  try {
    manifestText = await fs.readFile(manifestPath, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    log('No pinned core release manifest; skipping downloads. A frontend without a compiled core is allowed. Local native build files are preserved.');
    return { installed: false };
  }
  let manifest;
  try {
    manifest = JSON.parse(manifestText);
  } catch (error) {
    throw new Error(`Invalid core release manifest: ${error.message}`);
  }
  validateManifest(manifest);

  const releaseUrl = `${repository}/releases/download/${manifest.tag}`;
  const sourceUrl = `${releaseUrl}/${manifest.source.name}`;
  const publicPath = path.join(root, 'public');
  const destination = path.join(publicPath, 'core');
  await fs.mkdir(publicPath, { recursive: true });
  const staging = await fs.mkdtemp(path.join(publicPath, '.core-download-'));
  const backup = `${staging}-previous`;
  try {
    // Wait for every stream to settle before cleaning up a failed download.
    const results = await Promise.allSettled(manifest.files.map(file => download(file, releaseUrl, staging, fetchImpl)));
    const failures = results.filter(result => result.status === 'rejected');
    if (failures.length) throw new Error(failures.map(result => result.reason.message).join('; '));
    await fs.writeFile(path.join(staging, 'core-release.json'), JSON.stringify({
      ...manifest, source: { ...manifest.source, url: sourceUrl },
    }, null, 2) + '\n');

    let previousExists = false;
    try {
      await fs.rename(destination, backup);
      previousExists = true;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    try {
      await fs.rename(staging, destination);
    } catch (error) {
      if (previousExists) await fs.rename(backup, destination);
      throw error;
    }
    if (previousExists) await fs.rm(backup, { recursive: true, force: true });
    log(`Installed ${manifest.files.length} hash-verified files from core release ${manifest.tag}. Source: ${sourceUrl}`);
    return { installed: true, tag: manifest.tag, sourceUrl };
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  fetchCore().catch(error => { console.error(error.message); process.exitCode = 1; });
}
