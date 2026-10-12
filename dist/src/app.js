import { detectCapabilities } from './capabilities.js';
import { classifyGameFile } from './game-file.js';
import { InputState } from './input-state.js';
import { createInputController } from './input-controller.js';
import { DolphinWorkerClient } from './dolphin-worker-client.js';
import { WebGLRenderer } from './webgl-renderer.js';
import { AudioSink } from './audio-sink.js';
import { FrameScheduler } from './frame-scheduler.js';
import { PlaybackState, FrameStats } from './session-state.js';

const $ = selector => document.querySelector(selector);
const input = new InputState();
const audio = new AudioSink();
const playback = new PlaybackState();
const stats = new FrameStats();
const canvas = $('#screen');
let renderer = null;
let rendererError = null;
let selectedGame = null;
let runningGame = null;
let gameBooting = false;
let gameStopping = false;
let savePending = false;
let scheduler = null;
let controls = null;
let sentInputRevision = -1;

// Preferences are optional: private browsing and full storage must still allow play.
let preferences = {};
try {
  const stored = JSON.parse(localStorage.getItem('wiiclipse-preferences') || '{}');
  if (stored && typeof stored === 'object' && !Array.isArray(stored)) preferences = stored;
} catch {}
function savePreferences() {
  try { localStorage.setItem('wiiclipse-preferences', JSON.stringify(preferences)); } catch {}
}

try {
  renderer = new WebGLRenderer(canvas);
  renderer.clear();
} catch (error) {
  rendererError = error;
  $('#status').textContent = error.message;
}

const capabilityNames = { webgl2: 'WebGL2 graphics', webgpu: 'WebGPU available', gamepad: 'Gamepad input', serviceWorker: 'Offline shell' };
$('#capabilities').innerHTML = Object.entries(detectCapabilities())
  .map(([key, value]) => `<span class="badge ${value ? 'ok' : 'no'}">${capabilityNames[key]}: ${value ? 'available' : 'unavailable'}</span>`).join('');

let worker = null;
let workerStartupError = null;
try {
  if (typeof Worker === 'function') worker = new Worker(new URL('./dolphin-worker.js', import.meta.url), { type: 'module', name: 'dolphin-core' });
} catch (error) { workerStartupError = error; }

const core = worker ? new DolphinWorkerClient(worker, {
  onVideo(frame) {
    if (renderer) renderer.presentXRGB8888(frame);
    else frame.bitmap?.close();
  },
  onAudio: chunk => audio.push(chunk),
  onFrameDone({ frameRate }) {
    if (!playback.paused && stats.frame(performance.now(), frameRate)) {
      $('#fps').textContent = String(stats.fps);
      $('#speed').textContent = stats.speed === null ? '—' : `${stats.speed}%`;
    }
    scheduler?.frameDone(frameRate);
  },
  onStatus(message) {
    if (message && !playback.manualPaused) $('#status').textContent = rendererError?.message || message;
  },
  onSaveStatus({ state, message }) {
    $('#saveState').textContent = message || ({ saving: 'Saving progress…', saved: 'Progress saved on this device', error: 'Progress could not be saved' }[state] || 'Local save storage');
    $('#saveState').dataset.state = state;
  },
  onLog: ({ level = 'info', message = '' }) => console[level === 'error' ? 'error' : 'log'](`[Dolphin] ${message}`),
  onError(error) {
    scheduler?.stop();
    playback.stop();
    controls?.setEnabled(false);
    audio.setPaused(true).catch(() => {});
    $('#status').textContent = error.message;
    if (!core.isReady()) {
      $('#coreState').textContent = 'Native core unavailable';
      $('#coreState').classList.remove('ready');
    }
    runningGame = null;
    updatePlayState();
  },
}) : null;
scheduler = new FrameScheduler(() => core?.runFrame() || false);

function sendInput(force = false) {
  if (!core?.isReady() || (!force && sentInputRevision === input.revision)) return;
  core.setInput(input.snapshot());
  sentInputRevision = input.revision;
}
controls = createInputController({ input, document, window, navigator,
  onChange: () => sendInput(),
  onGamepad: name => { $('#gamepadState').textContent = name || 'Connect a gamepad, then press a button'; },
});
controls.setEnabled(false);

function resetStats() {
  stats.reset();
  $('#fps').textContent = '—';
  $('#speed').textContent = '—';
}
function updatePlayState() {
  const busy = gameBooting || gameStopping;
  $('#playerPanel').classList.toggle('is-running', playback.running && !playback.paused);
  $('#play').disabled = !renderer || !selectedGame || !core?.isReady() || busy
    || (playback.running && selectedGame === runningGame);
  $('#play').textContent = gameBooting ? 'Starting…' : playback.running && selectedGame !== runningGame ? 'Switch game' : 'Play';
  $('#pause').disabled = !playback.running || busy;
  $('#pause').textContent = playback.manualPaused ? 'Resume' : 'Pause';
  $('#pause').setAttribute('aria-label', playback.manualPaused ? 'Resume game' : 'Pause game');
  $('#pause').setAttribute('aria-pressed', String(playback.manualPaused));
  $('#stop').disabled = !playback.running || busy;
  $('#saveNow').disabled = !core?.isReady() || busy || savePending;
  $('#emptyScreen').hidden = playback.running;
  $('#emptyTitle').textContent = selectedGame ? 'Game selected' : 'No game running';
  $('#emptyHint').textContent = selectedGame ? 'Press Play to start.' : 'Open a game file above.';
  $('#sessionState').textContent = gameBooting ? 'Starting' : gameStopping ? 'Stopping'
    : playback.running ? (playback.paused ? 'Paused' : 'Playing') : core?.isReady() ? 'Ready to play' : 'Getting ready';
}
function applyPlaybackState() {
  scheduler.setPaused(playback.paused);
  controls.setEnabled(!playback.paused);
  audio.setPaused(playback.paused).catch(error => { $('#status').textContent = `Audio: ${error.message}`; });
  resetStats();
  updatePlayState();
}
function syncSaves() {
  if (!core?.isReady()) return Promise.resolve();
  return core.syncSaves().catch(error => {
    $('#saveState').textContent = `Save failed: ${error.message}`;
    $('#saveState').dataset.state = 'error';
  });
}

async function initializeCore() {
  if (!core) {
    $('#coreState').textContent = 'Web Workers unavailable';
    $('#status').textContent = workerStartupError?.message || 'This browser cannot run the Dolphin worker.';
    updatePlayState();
    return;
  }
  try {
    const { version } = await core.initialize();
    $('#coreState').textContent = 'Core ready';
    $('#coreState').setAttribute('title', version);
    $('#coreState').classList.add('ready');
    $('#status').textContent = rendererError?.message || 'Choose a game to begin.';
  } catch (error) {
    $('#coreState').textContent = /not installed|not built/i.test(error.message) ? 'Native core not built' : 'Native core unavailable';
    $('#coreState').classList.remove('ready');
    $('#status').textContent = error.message;
  }
  updatePlayState();
}

const fileInput = $('#gameFile');
$('#chooseGame').addEventListener('click', () => { fileInput.value = ''; fileInput.click(); });
function selectGame(file) {
  if (!file) return;
  const meta = classifyGameFile(file.name, file.size);
  $('#gameName').textContent = meta.name;
  const size = meta.bytes >= 1024 ** 3 ? `${(meta.bytes / 1024 ** 3).toFixed(2)} GB`
    : meta.bytes >= 1024 ** 2 ? `${(meta.bytes / 1024 ** 2).toFixed(1)} MB`
      : meta.bytes >= 1024 ? `${(meta.bytes / 1024).toFixed(1)} KB` : `${meta.bytes} bytes`;
  $('#gameMeta').textContent = meta.supported ? `${meta.system} • ${size} • stays on device` : meta.reason;
  selectedGame = meta.supported ? file : null;
  if (!meta.supported) $('#status').textContent = meta.reason;
  updatePlayState();
}
fileInput.addEventListener('change', () => selectGame(fileInput.files?.[0]));
const dropZone = $('#dropZone');
for (const type of ['dragenter', 'dragover']) dropZone.addEventListener(type, event => {
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  dropZone.classList.add('drag-over');
});
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', event => {
  event.preventDefault();
  dropZone.classList.remove('drag-over');
  const files = event.dataTransfer?.files;
  if (files?.length > 1) { $('#status').textContent = 'Choose one game at a time.'; return; }
  selectGame(files?.[0]);
});
// Prevent dropped files outside the target from navigating away from a session.
window.addEventListener('dragover', event => event.preventDefault());
window.addEventListener('drop', event => event.preventDefault());

$('#play').addEventListener('click', async () => {
  if (!core?.isReady() || !selectedGame || !renderer || gameBooting || gameStopping
    || (playback.running && selectedGame === runningGame)) return;
  const game = selectedGame;
  gameBooting = true;
  scheduler.stop();
  playback.stop();
  controls.reset();
  controls.setEnabled(false);
  audio.reset();
  resetStats();
  updatePlayState();
  try {
    // Unlock audio in the click gesture, but discard the prior title's late PCM
    // until the replacement title has actually booted.
    const audioReady = audio.resume();
    await Promise.all([audioReady, audio.setPaused(true)]);
    $('#status').textContent = 'Opening your game…';
    const { frameRate } = await core.bootGame(game);
    runningGame = game;
    audio.reset();
    playback.start();
    playback.hidden = document.visibilityState === 'hidden';
    sendInput(true);
    applyPlaybackState();
    scheduler.start(frameRate);
    $('#status').textContent = playback.paused ? 'Paused while this tab is hidden' : `Playing ${game.name}`;
    $('#play').blur();
  } catch (error) {
    playback.stop();
    runningGame = null;
    audio.setPaused(true).catch(() => {});
    $('#status').textContent = error.message;
  } finally {
    gameBooting = false;
    updatePlayState();
  }
});
$('#pause').addEventListener('click', async () => {
  if (!playback.running || gameBooting || gameStopping) return;
  playback.manualPaused = !playback.manualPaused;
  applyPlaybackState();
  $('#status').textContent = playback.manualPaused ? 'Paused • your session is kept in memory' : `Playing ${runningGame.name}`;
  $('#pause').blur();
  if (playback.manualPaused) await syncSaves();
});
$('#stop').addEventListener('click', async () => {
  if (!playback.running || gameBooting || gameStopping) return;
  gameStopping = true;
  playback.stop();
  scheduler.stop();
  controls.reset();
  applyPlaybackState();
  try {
    await core.unloadGame();
    renderer.clear();
    $('#status').textContent = 'Game stopped. Choose Play to start again.';
  } catch (error) { $('#status').textContent = `Game stopped. ${error.message}`; }
  finally { runningGame = null; gameStopping = false; updatePlayState(); }
});
$('#saveNow').addEventListener('click', async () => {
  if (!core?.isReady() || savePending || gameBooting || gameStopping) return;
  savePending = true;
  updatePlayState();
  try { await syncSaves(); }
  finally { savePending = false; updatePlayState(); }
});

function updateAudioUI() {
  $('#volume').value = String(Math.round(audio.volume * 100));
  $('#volumeValue').textContent = `${Math.round(audio.volume * 100)}%`;
  $('#mute').textContent = audio.muted ? 'Unmute' : 'Mute';
  $('#mute').setAttribute('aria-label', audio.muted ? 'Unmute audio' : 'Mute audio');
  $('#mute').setAttribute('aria-pressed', String(audio.muted));
}
audio.setVolume(Number.isFinite(preferences.volume) ? preferences.volume : 0.8);
audio.setMuted(preferences.muted === true);
updateAudioUI();
$('#volume').addEventListener('input', event => {
  audio.setVolume(Number(event.target.value) / 100);
  preferences.volume = audio.volume;
  updateAudioUI();
  savePreferences();
});
$('#mute').addEventListener('click', () => {
  audio.setMuted(!audio.muted);
  preferences.muted = audio.muted;
  updateAudioUI();
  savePreferences();
});
function applyDisplay() {
  const aspect = preferences.aspect === '16/9' ? '16/9' : '4/3';
  $('#aspectRatio').value = aspect;
  $('#playerSurface').style.aspectRatio = aspect;
  const showTouch = typeof preferences.showTouch === 'boolean' ? preferences.showTouch : !!window.matchMedia?.('(pointer: coarse)')?.matches;
  $('#showTouch').checked = showTouch;
  $('#touchControls').hidden = !showTouch;
  renderer?.resize();
}
$('#aspectRatio').addEventListener('change', event => { preferences.aspect = event.target.value; applyDisplay(); savePreferences(); });
$('#showTouch').addEventListener('change', event => { controls.reset(); preferences.showTouch = event.target.checked; applyDisplay(); savePreferences(); });
applyDisplay();
function updateFullscreenUI() {
  const expanded = !!document.fullscreenElement || $('#playerPanel').classList.contains('expanded');
  const label = expanded ? 'Exit expanded view' : 'Expand player';
  $('#fullscreen').textContent = expanded ? '↙' : '⛶';
  $('#fullscreen').setAttribute('aria-label', label);
  $('#fullscreen').setAttribute('title', label);
}
$('#fullscreen').addEventListener('click', async () => {
  const panel = $('#playerPanel');
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else if (panel.requestFullscreen) await panel.requestFullscreen();
    else {
      panel.classList.toggle('expanded');
      updateFullscreenUI();
    }
  } catch { $('#status').textContent = 'Fullscreen is unavailable in this browser. Try landscape orientation.'; }
});
document.addEventListener('fullscreenchange', () => {
  updateFullscreenUI();
  renderer?.resize();
});
window.addEventListener('keydown', event => {
  if (event.key === 'Escape') { $('#playerPanel').classList.remove('expanded'); updateFullscreenUI(); }
});
function setHidden(hidden) {
  playback.hidden = hidden;
  applyPlaybackState();
  if (hidden) syncSaves();
}
window.addEventListener('pagehide', () => setHidden(true));
window.addEventListener('pageshow', () => setHidden(document.visibilityState === 'hidden'));
document.addEventListener('visibilitychange', () => setHidden(document.visibilityState === 'hidden'));
initializeCore();
