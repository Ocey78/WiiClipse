export class DolphinWorkerClient {
  constructor(worker, callbacks = {}) {
    if (!worker?.postMessage || !worker?.addEventListener) throw new TypeError('A Worker-like object is required.');
    this.worker = worker;
    this.callbacks = callbacks;
    this.ready = false;
    this.running = false;
    this.framePending = false;
    this.booting = null;
    this.initializing = null;
    this.resolveInit = null;
    this.rejectInit = null;
    this.resolveBoot = null;
    this.rejectBoot = null;
    worker.addEventListener('message', (event) => this.#onMessage(event.data || {}));
    worker.addEventListener?.('error', (event) => {
      const error = new Error(event?.message || 'Dolphin worker failed.');
      this.#fail(error);
    });
  }

  #fail(error, recoverable = false) {
    if (!recoverable) this.ready = false;
    this.running = false;
    this.framePending = false;
    this.rejectInit?.(error);
    this.resolveInit = null;
    this.rejectInit = null;
    this.rejectBoot?.(error);
    this.resolveBoot = null;
    this.rejectBoot = null;
    this.callbacks.onError?.(error);
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
        this.#fail(error, message.type === 'error' && message.operation === 'boot' && message.recoverable === true);
        break;
      }
      case 'booted':
        this.running = true;
        this.resolveBoot?.();
        this.resolveBoot = null;
        this.rejectBoot = null;
        break;
      case 'frame-done': this.framePending = false; break;
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
    try { this.worker.postMessage({ type: 'init' }); }
    catch (error) { this.#fail(error); }
    return this.initializing;
  }

  isReady() { return this.ready; }
  bootGame(file) {
    if (!this.ready) return Promise.reject(new Error('Dolphin core is not ready.'));
    if (this.booting) return Promise.reject(new Error('A game is already booting.'));
    this.running = false;
    this.framePending = false;
    this.booting = new Promise((resolve, reject) => {
      this.resolveBoot = resolve;
      this.rejectBoot = reject;
    }).finally(() => { this.booting = null; });
    try { this.worker.postMessage({ type: 'boot', file }); }
    catch (error) { this.#fail(error, true); }
    return this.booting;
  }
  setInput(snapshot) { if (this.ready) this.worker.postMessage({ type: 'input', snapshot }); }
  runFrame() {
    if (!this.ready || !this.running || this.framePending) return;
    this.framePending = true;
    try { this.worker.postMessage({ type: 'frame' }); }
    catch (error) { this.#fail(error); }
  }
  unloadGame() {
    this.running = false;
    if (this.ready) this.worker.postMessage({ type: 'unload' });
  }
  syncSaves() { if (this.ready) this.worker.postMessage({ type: 'sync-saves' }); }
  terminate() {
    this.#fail(new Error('Dolphin worker was terminated.'));
    this.worker.terminate?.();
  }
}
