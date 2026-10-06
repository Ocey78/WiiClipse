import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const buildScript = fileURLToPath(new URL('../scripts/build.mjs', import.meta.url));
const coreFixture = `
  export default async function (options) {
    let rejectedRemoteAsset = false;
    try { options.locateFile('https://example.invalid/dolphin-core.wasm'); }
    catch { rejectedRemoteAsset = true; }
    self.postMessage({
      type: 'core-urls',
      moduleURL: import.meta.url,
      mainScriptURL: options.mainScriptUrlOrBlob,
      assets: ['dolphin-core.wasm', 'dolphin-core.data?download=1', 'dolphin-core.worker.js'].map(options.locateFile),
      rejectedRemoteAsset,
    });
    throw new Error('URL fixture stops before native initialization.');
  }
`;

async function fixture(t, withCore = true) {
  const root = await mkdtemp(join(tmpdir(), 'wiiclipse-core-cache-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'public'), { recursive: true });
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  await writeFile(join(root, 'public/index.html'), '<script type="module" src="../src/dolphin-worker.js"></script>');
  await writeFile(join(root, 'public/sw.js'), "const assets = ['../src/dolphin-worker.js'];");
  for (const name of ['dolphin-worker.js', 'dolphin-wasm-adapter.js']) {
    await cp(new URL(`../src/${name}`, import.meta.url), join(root, 'src', name));
  }
  if (withCore) {
    await mkdir(join(root, 'public/core'));
    await writeFile(join(root, 'public/core/dolphin-core.js'), coreFixture);
    await writeFile(join(root, 'public/core/dolphin-core.wasm'), new Uint8Array([0, 97, 115, 109]));
    await writeFile(join(root, 'public/core/dolphin-core.data'), 'original preload');
  }
  let instance = 0;
  async function loadWorker(built = true) {
    const workerURL = pathToFileURL(join(root, built ? 'dist/src/dolphin-worker.js' : 'src/dolphin-worker.js')).href;
    const previousSelf = globalThis.self;
    const messages = [];
    let receive;
    globalThis.self = {
      location: { href: workerURL },
      postMessage(message) { messages.push(message); },
      addEventListener(type, handler) { if (type === 'message') receive = handler; },
    };
    try {
      await import(`${workerURL}?test=${++instance}`);
      await receive({ data: { type: 'init' } });
      return { messages, urls: messages.find(message => message.type === 'core-urls') };
    } finally {
      globalThis.self = previousSelf;
    }
  }
  return {
    root,
    loadWorker,
    build: () => execFileSync(process.execPath, [buildScript], { cwd: root, encoding: 'utf8' }),
  };
}

test('built core module, pthread script, and located assets use the same content version', async t => {
  const app = await fixture(t);
  app.build();
  const { urls } = await app.loadWorker();
  assert.ok(urls, 'built worker must import the core module');
  const moduleURL = new URL(urls.moduleURL);
  const version = moduleURL.searchParams.get('v');
  assert.match(version || '', /^[a-f0-9]{64}$/);
  assert.equal(urls.mainScriptURL, urls.moduleURL, 'pthread startup must retain the module query');
  for (const asset of urls.assets) {
    const url = new URL(asset);
    assert.equal(url.searchParams.get('v'), version);
    assert.equal(new URL('.', url).href, new URL('.', moduleURL).href);
  }
  assert.equal(new URL(urls.assets[1]).searchParams.get('download'), '1');
  assert.equal(urls.rejectedRemoteAsset, true, 'core assets must remain on the module origin');
});

test('asset content changes invalidate the version while identical rebuilds remain stable', async t => {
  const app = await fixture(t);
  const versionAfterBuild = async () => {
    app.build();
    return new URL((await app.loadWorker()).urls.moduleURL).searchParams.get('v');
  };
  let previous = await versionAfterBuild();
  assert.match(previous || '', /^[a-f0-9]{64}$/);
  assert.equal(await versionAfterBuild(), previous);
  for (const [name, content] of [
    ['dolphin-core.wasm', new Uint8Array([0, 97, 115, 109, 1])],
    ['dolphin-core.data', 'updated preload'],
    ['dolphin-core.js', `${coreFixture}\n// Updated module runtime.\n`],
    ['dolphin-core.worker.js', '// Optional generated worker.\n'],
    ['dolphin-core.worker.js', '// Updated generated worker.\n'],
  ]) {
    await writeFile(join(app.root, 'public/core', name), content);
    const next = await versionAfterBuild();
    assert.notEqual(next, previous, `${name} must invalidate every core URL`);
    previous = next;
  }
  await writeFile(join(app.root, 'public/core/core-release.json'), '{"documentation":"changed"}');
  assert.equal(await versionAfterBuild(), previous, 'release metadata does not change runtime bytes');
});

test('building without a native core preserves the unavailable startup path', async t => {
  const app = await fixture(t, false);
  assert.match(app.build(), /without compiled Dolphin WASM core/);
  const { messages, urls } = await app.loadWorker();
  assert.equal(urls, undefined);
  assert.equal(messages.at(-1).type, 'unavailable');
  assert.equal(messages.some(message => message.type === 'ready'), false);
  assert.match(await readFile(join(app.root, 'dist/index.html'), 'utf8'), /src="\.\/src\//);
});

test('unbuilt development worker uses public core assets without a stamped version', async t => {
  const app = await fixture(t);
  const { urls } = await app.loadWorker(false);
  assert.ok(urls);
  assert.equal(new URL(urls.moduleURL).search, '');
  for (const asset of urls.assets) assert.equal(new URL(asset).searchParams.has('v'), false);
});
