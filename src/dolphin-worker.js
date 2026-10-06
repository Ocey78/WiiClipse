import { DolphinWasmAdapter } from './dolphin-wasm-adapter.js';

let moduleInstance = null;
let adapter = null;
let gameMounted = false;
let running = false;
let frameCount = 0;
const SAVE_DIR = '/dolphin/save';
const CONTENT_DIR = '/content';

const send = (type, extra = {}) => self.postMessage({ type, ...extra });
const status = (message) => send('status', { message });

function candidateCoreURLs() {
  const here = self.location.href;
  return [
    new URL('../core/dolphin-core.js', here).href,
    new URL('../public/core/dolphin-core.js', here).href,
  ];
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
  const base = new URL('.', moduleURL);
  return new URL(file, base).href;
}

function syncFS(populate = false) {
  if (!moduleInstance?.FS?.syncfs) return Promise.resolve();
  return new Promise((resolve, reject) => {
    moduleInstance.FS.syncfs(populate, (error) => error ? reject(error) : resolve());
  });
}

async function mountPersistentStorage() {
  const FS = moduleInstance.FS;
  const IDBFS = FS.filesystems?.IDBFS || moduleInstance.IDBFS;
  if (!IDBFS) {
    send('log', { level: 'warn', message: 'IDBFS is unavailable; saves will not persist after Safari closes.' });
    return;
  }
  try { FS.mount(IDBFS, {}, SAVE_DIR); }
  catch (error) {
    if (!/mount|busy|exist/i.test(String(error?.message || error))) throw error;
  }
  await syncFS(true);
}

async function initialize() {
  if (adapter?.isReady()) return { version: 'dolphin-web' };
  status('Loading Dolphin WebAssembly core…');
  const { factory, url } = await importCoreFactory();
  if (typeof factory !== 'function') throw new Error('dolphin-core.js did not export an Emscripten module factory.');

  moduleInstance = await factory({
    noInitialRun: true,
    locateFile: (path) => coreAssetURL(path, url),
    print: (message) => send('log', { level: 'info', message: String(message) }),
    printErr: (message) => send('log', { level: 'error', message: String(message) }),
  });

  adapter = new DolphinWasmAdapter(moduleInstance);
  const info = await adapter.init();
  await mountPersistentStorage();
  return info;
}

async function unmountGame() {
  if (!gameMounted || !moduleInstance) return;
  if (running) adapter?.unloadGame();
  running = false;
  try { moduleInstance.FS.unmount(CONTENT_DIR); } catch {}
  gameMounted = false;
  await syncFS(false).catch(() => {});
}

async function mountGame(file) {
  if (!file?.name) throw new Error('No game file was supplied.');
  await unmountGame();
  const FS = moduleInstance.FS;
  const WORKERFS = FS.filesystems?.WORKERFS || moduleInstance.WORKERFS;
  if (WORKERFS) {
    FS.mount(WORKERFS, { files: [file] }, CONTENT_DIR);
  } else {
    send('log', { level: 'warn', message: 'WORKERFS unavailable; copying game into WASM memory.' });
    const bytes = new Uint8Array(await file.arrayBuffer());
    FS.writeFile(`${CONTENT_DIR}/${file.name}`, bytes);
  }
  gameMounted = true;
  return `${CONTENT_DIR}/${file.name}`;
}

self.addEventListener('message', async ({ data = {} }) => {
  try {
    switch (data.type) {
      case 'init': {
        const info = await initialize();
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
          if (frameCount % 600 === 0) syncFS(false).catch(() => {});
        }
        send('frame-done', { frameRate: adapter?.getFrameRate() || 60 });
        break;
      case 'input': adapter?.setInput(data.snapshot); break;
      case 'unload': await unmountGame(); status('Game unloaded'); break;
      case 'sync-saves':
        await syncFS(false).catch((error) => send('log', { level: 'warn', message: `Could not save progress: ${error.message}` }));
        break;
      default: break;
    }
  } catch (error) {
    running = false;
    send(data.type === 'init' ? 'unavailable' : 'error', {
      message: error?.message || String(error),
      operation: data.type,
      recoverable: data.type === 'boot' && adapter?.isReady() === true,
    });
  }
});
