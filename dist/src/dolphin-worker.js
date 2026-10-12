import { DolphinWasmAdapter } from './dolphin-wasm-adapter.js';

let moduleInstance = null;
let adapter = null;
let gameMounted = false;
let copiedGamePath = null;
let persistenceAvailable = false;
let operationQueue = Promise.resolve();
let saveGroup = null;
let running = false;
let frameCount = 0;
const SAVE_DIR = '/dolphin/save';
const CONTENT_DIR = '/content';
// The build replaces this token with the digest of the copied core assets.
// A source checkout has no stamped version and keeps normal development URLs.
const CORE_ASSET_VERSION = '63195d1d8635a96b57ef74f9b309a8ea25642d7d99689eafa2e9ec2619017479';

const send = (type, extra = {}) => self.postMessage({ type, ...extra });
const status = (message) => send('status', { message });

function candidateCoreURLs() {
  const here = self.location.href;
  return [
    '../core/dolphin-core.js',
    '../public/core/dolphin-core.js',
  ].map(path => {
    const url = new URL(path, here);
    if (/^[a-f0-9]{64}$/.test(CORE_ASSET_VERSION)) url.searchParams.set('v', CORE_ASSET_VERSION);
    return url.href;
  });
}

async function importCoreFactory() {
  let lastError;
  for (const url of candidateCoreURLs()) {
    try {
      const imported = await import(url);
      return { factory: imported.default || imported.createDolphinModule, url };
    } catch (error) { lastError = error; }
  }
  throw new Error(`Dolphin WASM build is not installed. Run native/build-dolphin-wasm.sh first. ${lastError?.message || ''}`.trim());
}

function coreAssetURL(file, moduleURL) {
  const module = new URL(moduleURL);
  const asset = new URL(file, module);
  if (asset.origin !== module.origin) throw new Error('Dolphin core assets must use the module origin.');
  const version = module.searchParams.get('v');
  if (version) asset.searchParams.set('v', version);
  return asset.href;
}

function syncFS(populate = false) {
  if (!moduleInstance?.FS?.syncfs) return Promise.resolve();
  return new Promise((resolve, reject) => {
    moduleInstance.FS.syncfs(populate, (error) => error ? reject(error) : resolve());
  });
}

function enqueue(operation) {
  const pending = operationQueue.then(operation);
  // A failed operation must not poison later retries or cleanup.
  operationQueue = pending.catch(() => {});
  return pending;
}

async function flushSaves() {
  if (!moduleInstance) return;
  send('save-status', { state: 'saving', message: 'Saving progress…' });
  try {
    if (!persistenceAvailable) throw new Error('Persistent save storage is unavailable in this browser.');
    await syncFS(false);
    send('save-status', { state: 'saved', message: 'Progress saved on this device.' });
  } catch (error) {
    send('save-status', { state: 'error', message: `Could not save progress: ${error.message}` });
    throw error;
  }
}

function queueSave(requestId) {
  if (!saveGroup) {
    const group = { requests: [], promise: null };
    saveGroup = group;
    group.promise = enqueue(async () => {
      let error;
      try { await flushSaves(); } catch (failure) { error = failure; }
      for (const id of group.requests) send('saves-synced', {
        requestId: id, ok: !error, ...(error ? { message: error.message } : {}),
      });
      if (saveGroup === group) saveGroup = null;
    });
  }
  if (requestId !== undefined) saveGroup.requests.push(requestId);
  return saveGroup.promise;
}

async function mountPersistentStorage() {
  const FS = moduleInstance.FS;
  const IDBFS = FS.filesystems?.IDBFS || moduleInstance.IDBFS;
  if (!IDBFS) {
    send('log', { level: 'warn', message: 'IDBFS is unavailable; saves will not persist after Safari closes.' });
    send('save-status', { state: 'error', message: 'Persistent save storage is unavailable in this browser.' });
    return;
  }
  FS.mount(IDBFS, {}, SAVE_DIR);
  await syncFS(true);
  persistenceAvailable = true;
  send('save-status', { state: 'ready', message: 'Local save storage ready on this device.' });
}

async function initialize(options = {}) {
  if (adapter?.isReady()) return { version: 'dolphin-web' };
  status('Loading Dolphin WebAssembly core…');
  const { factory, url } = await importCoreFactory();
  if (typeof factory !== 'function') throw new Error('dolphin-core.js did not export an Emscripten module factory.');

  moduleInstance = await factory({
    noInitialRun: true,
    // Software override supports correctness/performance comparisons on the
    // same CPU core; normal boot negotiates native WebGL2 with a safe fallback.
    dwebRenderer: options.renderer === 'software' ? 'software' : 'hardware',
    dwebVideo: options.video === 'pixels' ? 'pixels' : 'bitmap',
    // Emscripten's default pthread URL drops import.meta.url's query string.
    mainScriptUrlOrBlob: url,
    locateFile: (path) => coreAssetURL(path, url),
    print: (message) => send('log', { level: 'info', message: String(message) }),
    printErr: (message) => send('log', { level: 'error', message: String(message) }),
  });

  adapter = new DolphinWasmAdapter(moduleInstance);
  const info = await adapter.init();
  try { await mountPersistentStorage(); }
  catch (error) {
    send('save-status', { state: 'error', message: `Save storage unavailable: ${error.message}` });
    send('log', { level: 'warn', message: `Could not restore progress: ${error.message}` });
  }
  return info;
}

async function unmountGame() {
  if (!gameMounted || !moduleInstance) return;
  adapter?.unloadGame();
  running = false;
  if (copiedGamePath) moduleInstance.FS.unlink(copiedGamePath);
  else moduleInstance.FS.unmount(CONTENT_DIR);
  copiedGamePath = null;
  gameMounted = false;
}

async function mountGame(file) {
  if (!file?.name) throw new Error('No game file was supplied.');
  if (gameMounted) {
    await unmountGame();
    if (persistenceAvailable) await flushSaves();
  }
  const FS = moduleInstance.FS;
  const WORKERFS = FS.filesystems?.WORKERFS || moduleInstance.WORKERFS;
  if (WORKERFS) {
    FS.mount(WORKERFS, { files: [file] }, CONTENT_DIR);
  } else {
    send('log', { level: 'warn', message: 'WORKERFS unavailable; copying game into WASM memory.' });
    const bytes = new Uint8Array(await file.arrayBuffer());
    FS.writeFile(`${CONTENT_DIR}/${file.name}`, bytes);
    copiedGamePath = `${CONTENT_DIR}/${file.name}`;
  }
  gameMounted = true;
  return `${CONTENT_DIR}/${file.name}`;
}

self.addEventListener('message', ({ data = {} }) => {
  if (data.type === 'sync-saves') return queueSave(data.requestId);
  // Requests separated by lifecycle work represent different filesystem states.
  saveGroup = null;
  return enqueue(() => handleMessage(data));
});

async function handleMessage(data) {
  try {
    switch (data.type) {
      case 'init': {
        const info = await initialize(data);
        send('ready', { version: info.version || 'dolphin-web' });
        break;
      }
      case 'boot': {
        if (!adapter?.isReady()) throw new Error('Dolphin core is not initialized.');
        status(`Mounting ${data.file?.name || 'game'}…`);
        const path = await mountGame(data.file);
        status('Booting title with cached interpreter…');
        await adapter.bootGamePath(path);
        running = true;
        frameCount = 0;
        status('Running');
        send('booted', { frameRate: adapter.getFrameRate() });
        break;
      }
      case 'frame':
        if (running) {
          adapter.runFrame();
          frameCount++;
          if (frameCount % 600 === 0) queueSave();
        }
        send('frame-done', { frameRate: adapter?.getFrameRate() || 60 });
        break;
      case 'input': adapter?.setInput(data.snapshot); break;
      case 'unload':
        await unmountGame();
        await flushSaves();
        status('Game unloaded');
        send('unloaded', { requestId: data.requestId, ok: true });
        break;
      default: break;
    }
  } catch (error) {
    if (data.type === 'unload') {
      send('unloaded', { requestId: data.requestId, ok: false, message: error?.message || String(error) });
      return;
    }
    running = false;
    send(data.type === 'init' ? 'unavailable' : 'error', {
      message: error?.message || String(error),
      operation: data.type,
      recoverable: data.type === 'boot' && adapter?.isReady() === true,
    });
  }
}
