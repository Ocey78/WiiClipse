export const GAMECUBE_BUTTON_IDS = Object.freeze({
  B: 0,
  Y: 1,
  SELECT: 2,
  START: 3,
  UP: 4,
  DOWN: 5,
  LEFT: 6,
  RIGHT: 7,
  A: 8,
  X: 9,
  L: 10,
  R: 11,
  Z: 12,
});

export const GAMECUBE_AXIS_IDS = Object.freeze({
  lx: 0,
  ly: 1,
  rx: 2,
  ry: 3,
  l: 4,
  r: 5,
});

const clamp = (value, min = -1, max = 1) => Math.max(min, Math.min(max, Number(value) || 0));

export class DolphinWasmAdapter {
  constructor(module) {
    if (!module?.FS || typeof module.cwrap !== 'function') {
      throw new TypeError('A loaded Dolphin Emscripten module is required.');
    }

    this.module = module;
    this.ready = false;
    this.running = false;
    this.lastButtons = [];
    this.lastAxes = [];
    this.native = {
      init: module.cwrap('dweb_init', 'number', []),
      loadGame: module.cwrap('dweb_load_game', 'number', ['string']),
      runFrame: module.cwrap('dweb_run_frame', null, []),
      setButton: module.cwrap('dweb_set_button', null, ['number', 'number']),
      setAxis: module.cwrap('dweb_set_axis', null, ['number', 'number']),
      unloadGame: module.cwrap('dweb_unload_game', null, []),
      shutdown: module.cwrap('dweb_shutdown', null, []),
      version: (() => {
        try { return module.cwrap('dweb_version', 'string', []); }
        catch { return () => 'dolphin-web'; }
      })(),
    };
  }

  async init() {
    for (const path of ['/dolphin/system', '/dolphin/save', '/dolphin/assets', '/content']) {
      this.module.FS.mkdirTree(path);
    }
    if (!this.native.init()) throw new Error('Dolphin native host initialization failed.');
    this.ready = true;
    return { version: this.native.version() || 'dolphin-web' };
  }

  isReady() { return this.ready; }

  getFrameRate() {
    const rate = this.module._dweb_get_frame_rate?.();
    return Number.isFinite(rate) && rate >= 20 && rate <= 120 ? rate : 60;
  }

  async bootGamePath(path) {
    if (!this.ready) throw new Error('Dolphin core is not initialized.');
    if (!path) throw new Error('A mounted game path is required.');
    if (!this.native.loadGame(path)) throw new Error(`Dolphin rejected ${path}.`);
    this.lastButtons = [];
    this.lastAxes = [];
    this.running = true;
  }

  runFrame() {
    if (this.ready && this.running) this.native.runFrame();
  }

  setInput(snapshot = {}) {
    if (!this.ready) return;
    const buttons = snapshot.buttons || {};
    const axes = snapshot.axes || {};

    for (const [name, id] of Object.entries(GAMECUBE_BUTTON_IDS)) {
      const value = buttons[name] ? 1 : 0;
      if (this.lastButtons[id] !== value) {
        this.native.setButton(id, value);
        this.lastButtons[id] = value;
      }
    }
    for (const [name, id] of Object.entries(GAMECUBE_AXIS_IDS)) {
      const value = clamp(axes[name]);
      if (this.lastAxes[id] !== value) {
        this.native.setAxis(id, value);
        this.lastAxes[id] = value;
      }
    }
  }

  unloadGame() {
    if (!this.ready || !this.running) return;
    this.native.unloadGame();
    this.running = false;
  }

  shutdown() {
    if (!this.ready) return;
    if (this.running) this.unloadGame();
    this.native.shutdown();
    this.ready = false;
  }
}
