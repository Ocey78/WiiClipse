import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fetchCore } from '../scripts/fetch-core.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const assets = new Map([
  ['dolphin-core.js', Buffer.from('release JavaScript fixture')],
  ['dolphin-core.wasm', Buffer.from('release WASM fixture')],
  ['dolphin-core.data', Buffer.from('release data fixture')],
  ['dolphin-core.worker.js', Buffer.from('release worker fixture')],
]);
const release = () => ({
  schemaVersion: 1,
  tag: 'core-test-123',
  hostCommit: '1'.repeat(40),
  dolphinCommit: 'f8603f14e7f5a090e6693857d625a55ea9330534',
  emscripten: '4.0.23',
  runId: '123',
  source: { name: 'dolphin-browser-source.tar.gz', sha256: '2'.repeat(64) },
  files: [...assets].map(([name, bytes]) => ({ name, sha256: digest(bytes) })),
});

async function fixture(t, manifest = release()) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wiiclipse-core-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'native'));
  if (manifest) await fs.writeFile(path.join(root, 'native/core-release.json'), JSON.stringify(manifest));
  return root;
}

test('without a manifest core acquisition uses no network and preserves a local native build', async t => {
  const root = await fixture(t, null);
  await fs.mkdir(path.join(root, 'public/core'), { recursive: true });
  await fs.writeFile(path.join(root, 'public/core/local-build'), 'keep');
  const result = await fetchCore({ root, log() {}, fetchImpl() { assert.fail('must not fetch'); } });
  assert.equal(result.installed, false);
  assert.equal(await fs.readFile(path.join(root, 'public/core/local-build'), 'utf8'), 'keep');
});

test('installs exactly the hash-verified assets from the pinned release and retains source provenance', async t => {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, 'public/core'), { recursive: true });
  await fs.writeFile(path.join(root, 'public/core/dolphin-core.old.worker.js'), 'stale');
  const requested = [];
  const result = await fetchCore({ root, log() {}, fetchImpl: async url => {
    requested.push(url);
    return new Response(assets.get(new URL(url).pathname.split('/').at(-1)));
  } });
  assert.equal(result.installed, true);
  assert.deepEqual(requested.sort(), [...assets.keys()].map(name =>
    `https://github.com/Ocey78/WiiClipse/releases/download/core-test-123/${name}`).sort());
  assert.deepEqual((await fs.readdir(path.join(root, 'public/core'))).sort(),
    [...assets.keys(), 'core-release.json'].sort());
  for (const [name, bytes] of assets) assert.deepEqual(await fs.readFile(path.join(root, 'public/core', name)), bytes);
  const provenance = JSON.parse(await fs.readFile(path.join(root, 'public/core/core-release.json'), 'utf8'));
  assert.equal(provenance.source.url, 'https://github.com/Ocey78/WiiClipse/releases/download/core-test-123/dolphin-browser-source.tar.gz');
  assert.equal(provenance.hostCommit, release().hostCommit);
});

test('a corrupted or unavailable file fails acquisition without replacing the previous core', async t => {
  for (const mode of ['hash', 'http', 'network']) {
    await t.test(mode, async t => {
      const root = await fixture(t);
      await fs.mkdir(path.join(root, 'public/core'), { recursive: true });
      await fs.writeFile(path.join(root, 'public/core/previous-core'), 'keep');
      await assert.rejects(fetchCore({ root, log() {}, fetchImpl: async url => {
        const name = new URL(url).pathname.split('/').at(-1);
        if (name === 'dolphin-core.wasm') {
          if (mode === 'http') return new Response('missing', { status: 404 });
          if (mode === 'network') throw new Error('connection lost');
          return new Response('corrupted download');
        }
        return new Response(assets.get(name));
      } }), mode === 'hash' ? /SHA-256 mismatch/ : mode === 'http' ? /HTTP 404/ : /connection lost/);
      assert.deepEqual(await fs.readdir(path.join(root, 'public/core')), ['previous-core']);
      assert.equal(await fs.readFile(path.join(root, 'public/core/previous-core'), 'utf8'), 'keep');
      assert.deepEqual(await fs.readdir(path.join(root, 'public')), ['core']);
    });
  }
});

test('rejects unsafe or incomplete manifests before making requests', async t => {
  const cases = {
    'path in tag': m => { m.tag = '../latest'; },
    'query in tag': m => { m.tag = 'v1?other'; },
    'path in asset': m => { m.files[0].name = '../dolphin-core.js'; },
    'unrecognized asset': m => { m.files[0].name = 'index.html'; },
    'duplicate asset': m => { m.files.push(m.files[0]); },
    'missing preloaded data': m => { m.files = m.files.filter(f => f.name !== 'dolphin-core.data'); },
    'invalid digest': m => { m.files[0].sha256 = 'not a digest'; },
    'invalid host commit': m => { m.hostCommit = 'main'; },
    'invalid source digest': m => { m.source.sha256 = 'missing'; },
    'unsafe source name': m => { m.source.name = '../source.tar.gz'; },
    'unsupported schema': m => { m.schemaVersion = 2; },
  };
  for (const [name, mutate] of Object.entries(cases)) {
    await t.test(name, async t => {
      const manifest = release();
      mutate(manifest);
      const root = await fixture(t, manifest);
      await assert.rejects(fetchCore({ root, log() {}, fetchImpl() { assert.fail('must not fetch'); } }), /Invalid core release manifest/);
      await assert.rejects(fs.stat(path.join(root, 'public')), { code: 'ENOENT' });
    });
  }
});
