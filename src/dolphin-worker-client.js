export class DolphinWorkerClient {
  constructor(worker, callbacks = {}) {
    if (!worker?.postMessage || !worker?.addEventListener) throw new TypeError('A Worker-like object is required.');
    this.worker = worker;
    this.callbacks = callbacks;
    this.ready = false;
    this.initializing = null;
    this.resolveInit = null;
    this.rejectInit = null;
    worker.addEventListener('message', (event) => this.#onMessage(event.data || {}));
    worker.addEventListener?.('error', (event) => {
      const error = new Error(event?.message || 'Dolphin worker failed.');
      this.rejectInit?.(error);
      this.callbacks.onError?.(error);
    });
  }

  #onMessage(message) {
    switch (message.type) {
      case 'ready':
        this.ready = true;
        this.resolveInit?.({ version: message.version || 'dolphin-web' });
        this.resolveInit = null;
        this.rejectInit = null;
        this.callbacks.onStatus?.('Dolphin core ready');
        break;
      case 'unavailable':
      case 'error': {
        const error = new Error(message.message || 'Dolphin core unavailable.');
        this.ready = false;
        this.rejectInit?.(error);
        this.resolveInit = null;
        this.rejectInit = null;
        this.callbacks.onError?.(error);
        break;
      }
      case 'video': this.callbacks.onVideo?.(message); break;
      case 'audio': this.callbacks.onAudio?.(message); break;
      case 'status': this.callbacks.onStatus?.(message.message || ''); break;
      case 'log': this.callbacks.onLog?.(message); break;
      default: break;
    }
  }

  initialize() {
    if (this.ready) return Promise.resolve({ version: 'dolphin-web' });
    if (this.initializing) return this.initializing;
    this.initializing = new Promise((resolve, reject) => {
      this.resolveInit = resolve;
      this.rejectInit = reject;
    }).finally(() => { this.initializing = null; });
    this.worker.postMessage({ type: 'init' });
    return this.initializing;
  }

  isReady() { return this.ready; }
  bootGame(file) {
    if (!this.ready) throw new Error('Dolphin core is not ready.');
    this.worker.postMessage({ type: 'boot', file });
  }
  setInput(snapshot) { if (this.ready) this.worker.postMessage({ type: 'input', snapshot }); }
  runFrame() { if (this.ready) this.worker.postMessage({ type: 'frame' }); }
  unloadGame() { if (this.ready) this.worker.postMessage({ type: 'unload' }); }
  syncSaves() { if (this.ready) this.worker.postMessage({ type: 'sync-saves' }); }
  terminate() { this.worker.terminate?.(); this.ready = false; }
}
