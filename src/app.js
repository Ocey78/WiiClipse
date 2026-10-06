import { detectCapabilities } from './capabilities.js';
import { classifyGameFile } from './game-file.js';
import { InputState } from './input-state.js';
import { DolphinWorkerClient } from './dolphin-worker-client.js';
import { WebGLRenderer } from './webgl-renderer.js';
import { AudioSink } from './audio-sink.js';

const $ = (selector) => document.querySelector(selector);
const caps = detectCapabilities();
const input = new InputState();
const canvas = $('#screen');
const audio = new AudioSink();
let renderer;
let rendererError = null;
let selectedGame = null;
let gameRunning = false;
let gameBooting = false;
let runningGame = null;

try {
  renderer = new WebGLRenderer(canvas);
  renderer.clear();
} catch (error) {
  renderer = null;
  rendererError = error;
  $('#status').textContent = error.message;
}

$('#capabilities').innerHTML = Object.entries(caps)
  .map(([key, value]) => `<span class="badge ${value ? 'ok' : 'no'}">${key}: ${value ? 'yes' : 'no'}</span>`)
  .join('');

let worker = null;
let workerStartupError = null;
try {
  if (typeof Worker === 'function') {
    worker = new Worker(new URL('./dolphin-worker.js', import.meta.url), { type: 'module', name: 'dolphin-core' });
  }
} catch (error) { workerStartupError = error; }

const core = worker ? new DolphinWorkerClient(worker, {
  onVideo: (frame) => renderer?.presentXRGB8888(frame),
  onAudio: (chunk) => audio.push(chunk),
  onStatus: (message) => { if (message) $('#status').textContent = rendererError?.message || message; },
  onLog: ({ level = 'info', message = '' }) => console[level === 'error' ? 'error' : 'log'](`[Dolphin] ${message}`),
  onError: (error) => {
    $('#status').textContent = error.message;
    if (!core.isReady()) {
      $('#coreState').textContent = 'Native core unavailable';
      $('#coreState').classList.remove('ready');
    }
    gameRunning = false;
    runningGame = null;
    updatePlayState();
  },
}) : null;

function updatePlayState() {
  $('#play').disabled = !renderer || !selectedGame || !core?.isReady() || gameBooting
    || (gameRunning && selectedGame === runningGame);
}

async function initializeCore() {
  if (!core) {
    $('#coreState').textContent = 'Web Workers unavailable';
    $('#status').textContent = workerStartupError?.message || 'This browser cannot run the Dolphin worker.';
    return;
  }
  try {
    const { version } = await core.initialize();
    $('#coreState').textContent = `Core ready • ${version}`;
    $('#coreState').classList.add('ready');
    $('#status').textContent = rendererError?.message || 'Select a GameCube game, homebrew file, or bootable Wii WAD.';
    updatePlayState();
  } catch (error) {
    $('#coreState').textContent = /not installed|not built/i.test(error.message) ? 'Native core not built' : 'Native core unavailable';
    $('#coreState').classList.remove('ready');
    $('#status').textContent = error.message;
    updatePlayState();
  }
}
initializeCore();

const fileInput = $('#gameFile');
$('#chooseGame').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  const meta = classifyGameFile(file.name, file.size);
  $('#gameName').textContent = meta.name;
  const size = meta.bytes >= 1024 ** 3
    ? `${(meta.bytes / 1024 ** 3).toFixed(2)} GB`
    : `${(meta.bytes / 1024 ** 2).toFixed(1)} MB`;
  $('#gameMeta').textContent = meta.supported ? `${meta.system} • ${size} • stays on device` : meta.reason;
  selectedGame = meta.supported ? file : null;
  updatePlayState();
});

$('#play').addEventListener('click', async () => {
  if (!core?.isReady()) {
    $('#status').textContent = 'Dolphin WASM core is not loaded. Build it with native/build-dolphin-wasm.sh.';
    return;
  }
  if (!selectedGame || !renderer || gameBooting || (gameRunning && selectedGame === runningGame)) return;
  const game = selectedGame;
  gameBooting = true;
  updatePlayState();
  try {
    await audio.resume();
    $('#status').textContent = 'Sending game to Dolphin worker…';
    gameRunning = false;
    await core.bootGame(game);
    gameRunning = true;
    runningGame = game;
  } catch (error) {
    gameRunning = false;
    runningGame = null;
    $('#status').textContent = error.message;
  } finally {
    gameBooting = false;
    updatePlayState();
  }
});

for (const element of document.querySelectorAll('[data-button]')) {
  const name = element.dataset.button;
  const on = (event) => {
    event.preventDefault();
    input.setButton(name, true);
    core?.setInput(input.snapshot());
    element.classList.add('active');
  };
  const off = (event) => {
    event.preventDefault();
    input.setButton(name, false);
    core?.setInput(input.snapshot());
    element.classList.remove('active');
  };
  element.addEventListener('pointerdown', on);
  element.addEventListener('pointerup', off);
  element.addEventListener('pointercancel', off);
  element.addEventListener('pointerleave', off);
}

function pollGamepad() {
  const gp = navigator.getGamepads?.()[0];
  if (gp) {
    const button = (index) => !!gp.buttons[index]?.pressed;
    input.setButton('A', button(0));
    input.setButton('B', button(1));
    input.setButton('X', button(2));
    input.setButton('Y', button(3));
    input.setButton('L', button(4));
    input.setButton('R', button(5));
    input.setButton('SELECT', button(8));
    input.setButton('START', button(9));
    input.setButton('UP', button(12));
    input.setButton('DOWN', button(13));
    input.setButton('LEFT', button(14));
    input.setButton('RIGHT', button(15));
    input.setAxis('lx', gp.axes[0] || 0);
    input.setAxis('ly', gp.axes[1] || 0);
    input.setAxis('rx', gp.axes[2] || 0);
    input.setAxis('ry', gp.axes[3] || 0);
    input.setAxis('l', gp.buttons[6]?.value || 0);
    input.setAxis('r', gp.buttons[7]?.value || 0);
    core?.setInput(input.snapshot());
  }

  if (gameRunning && core?.isReady()) core.runFrame();
  requestAnimationFrame(pollGamepad);
}
requestAnimationFrame(pollGamepad);

window.addEventListener('pagehide', () => core?.syncSaves());
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') core?.syncSaves();
});
