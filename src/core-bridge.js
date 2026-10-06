export class DolphinCoreBridge {
  constructor() { this.module = null; }
  async load(factory) {
    if (typeof factory !== 'function') throw new TypeError('A Dolphin WASM module factory is required.');
    const mod = await factory();
    if (!mod || typeof mod.bootGame !== 'function') throw new Error('WASM module does not expose bootGame.');
    this.module = mod;
    return true;
  }
  isReady() { return !!this.module; }
  async bootGame(buffer) {
    if (!this.module) throw new Error('Dolphin core is not loaded.');
    return this.module.bootGame(buffer);
  }
  setInput(snapshot) { if (this.module?.setInput) this.module.setInput(snapshot); }
}
