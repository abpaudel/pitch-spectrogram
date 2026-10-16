import { SpectrogramView, COLS } from './view.js';
import { Demo, DEMO_RATE } from './demo.js';

// Note spellings ("Note names" option). The default is sharps only.
const NAMINGS = {
  mixed: ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'B♭', 'B'],
  sharps: ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'],
  flats: ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'G♭', 'G', 'A♭', 'A', 'B♭', 'B'],
};

// Analysis Rate Medium: 43 columns/s, about 6 s on screen.
const DEFAULTS = { sensitivity: 'medium', rate: 1, quality: 1, ref: 440, naming: 'sharps', startScreen: true };
const STRING_SETTINGS = new Set(['sensitivity', 'naming']);

function loadSettings() {
  try {
    const s = { ...DEFAULTS, ...JSON.parse(localStorage.getItem('pitch-spectrogram') || '{}') };
    // Older saves stored sensitivity as 0 (Normal) / 1 (Maximum), then 'normal'.
    if (typeof s.sensitivity === 'number') s.sensitivity = s.sensitivity === 1 ? 'high' : 'medium';
    if (s.sensitivity === 'normal') s.sensitivity = 'medium';
    return s;
  } catch { return { ...DEFAULTS }; }
}

function saveSettings(s) {
  try { localStorage.setItem('pitch-spectrogram', JSON.stringify(s)); } catch { /* storage unavailable */ }
}

const settings = loadSettings();
const glCanvas = document.getElementById('gl');
const overlay = document.getElementById('overlay');
const view = new SpectrogramView(glCanvas, overlay);
let octaves = new Int8Array(12).fill(-1);
// The analysis worker is created on load so its modules are fetched and
// ready by the time Start is pressed; worker is set once it is started.
const analysis = new Worker('js/worker.js', { type: 'module' });
let worker = null;

// Landing-page demo: prefilled so the screen starts full, then advanced
// in real time by frame() until the microphone starts. Skipped when the
// start screen is off, so analysis is the first thing shown.
let demo = null;
let demoTime = 0;
let demoCols = 0;

function startDemo() {
  demo = new Demo();
  demoTime = performance.now();
  demoCols = 0;
  for (let i = 0; i < COLS; i++) view.addColumn(demo.column());
  octaves = demo.octaves;
}

// Label text: letter, octave digit, then the accidental glyph.
function label(pc) {
  const oct = octaves[pc];
  if (oct < 0) return null;
  const name = NAMINGS[settings.naming][pc];
  return name[0] + oct + name.slice(1);
}

function resize() {
  const dpr = window.devicePixelRatio || 1;
  const r = glCanvas.getBoundingClientRect();
  view.resize(Math.round(r.width * dpr), Math.round(r.height * dpr));
}

function frame() {
  if (demo) {
    const due = Math.floor((performance.now() - demoTime) * DEMO_RATE / 1000);
    if (due - demoCols > 10) demoCols = due - 1;     // skip ahead after the tab was hidden
    for (; demoCols < due; demoCols++) view.addColumn(demo.column());
  }
  resize();
  view.draw(label, settings.naming);
  requestAnimationFrame(frame);
}

async function loadWorklet(ctx) {
  if (!ctx.audioWorklet) return false;
  const timeout = new Promise((resolve) => setTimeout(() => resolve(false), 3000));
  const load = ctx.audioWorklet.addModule('js/capture-worklet.js').then(() => true, () => false);
  return Promise.race([load, timeout]);
}

const startEl = document.getElementById('start');
const startButton = document.getElementById('start-button');
const startStatus = document.getElementById('start-status');

function showStartError(message) {
  startStatus.textContent = message;
  startStatus.hidden = false;
  startButton.disabled = false;
  startButton.lastChild.textContent = 'Try Again';
}

// auto: started on load because the start screen is turned off. Any
// failure then just shows the start screen instead of an error.
async function start(auto = false) {
  startButton.disabled = true;
  startStatus.hidden = true;
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
    });
  } catch (err) {
    if (auto) showStartScreen();
    else showStartError('Microphone access was denied. Allow it for this page, then try again.');
    return;
  }
  const ctx = new AudioContext();
  const src = ctx.createMediaStreamSource(stream);
  const ch = new MessageChannel();
  if (await loadWorklet(ctx)) {
    const node = new AudioWorkletNode(ctx, 'capture', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1, channelCountMode: 'explicit' });
    src.connect(node);
    node.port.postMessage({ port: ch.port1 }, [ch.port1]);
  } else {
    // Fallback for browsers where AudioWorklet is unavailable or never loads.
    const node = ctx.createScriptProcessor(1024, 1, 1);
    node.onaudioprocess = (e) => {
      const x = new Float32Array(e.inputBuffer.getChannelData(0));
      ch.port1.postMessage(x, [x.buffer]);
    };
    const mute = ctx.createGain();
    mute.gain.value = 0;
    src.connect(node);
    node.connect(mute).connect(ctx.destination);
  }
  demo = null;
  view.clear();
  octaves = new Int8Array(12).fill(-1);
  worker = analysis;
  worker.onmessage = (e) => {
    audioRunning();
    view.addColumn(e.data.col); octaves = e.data.octaves; heard(e.data.col);
  };
  worker.postMessage({ type: 'init', sampleRate: ctx.sampleRate, port: ch.port2, settings }, [ch.port2]);
  startEl.hidden = true;
  // Without a user gesture (auto start) the browser may keep audio
  // suspended; it then resumes on the first tap or key press.
  ctx.onstatechange = () => { if (ctx.state === 'running') audioRunning(); };
  if (ctx.state === 'running') audioRunning();
  else {
    ctx.resume().catch(() => {});
    resumeOnGesture(ctx);
  }
}

function showStartScreen() {
  document.documentElement.classList.remove('auto-start');
  startButton.disabled = false;
  startDemo();
}

let running = false;
let tapResume = null;

function resumeOnGesture(ctx) {
  tapResume = () => { ctx.resume().catch(() => {}); };
  addEventListener('pointerdown', tapResume);
  addEventListener('keydown', tapResume);
}

// Audio is flowing: the context reported running, or analysis frames arrived.
function audioRunning() {
  if (running) return;
  running = true;
  if (tapResume) {
    removeEventListener('pointerdown', tapResume);
    removeEventListener('keydown', tapResume);
  }
  watchSilence();
}

// Hint shown if nothing has been picked up 5 s after starting; hidden for
// good once a clearly visible column arrives.
const silenceEl = document.getElementById('silence');
let gotSignal = false;

function watchSilence() {
  setTimeout(() => { if (!gotSignal) silenceEl.hidden = false; }, 5000);
}

function heard(col) {
  if (gotSignal) return;
  for (let i = 0; i < col.length; i++) {
    if (col[i] > 8000) { gotSignal = true; silenceEl.hidden = true; return; }
  }
}

// Install: Chromium browsers fire beforeinstallprompt when the app can be
// installed, so the button only appears then. iOS has no such API, so it
// gets a Share-menu hint instead. Neither shows once running installed.
function bindInstall() {
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  if (standalone) return;
  const button = document.getElementById('install');
  let prompt = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    prompt = e;
    button.hidden = false;
  });
  button.addEventListener('click', async () => {
    if (!prompt) return;
    prompt.prompt();
    await prompt.userChoice;
    prompt = null;
    button.hidden = true;
  });
  window.addEventListener('appinstalled', () => { button.hidden = true; });
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (ios) document.getElementById('install-ios').hidden = false;
}

function bindOptions() {
  const panel = document.getElementById('options');
  const fields = {
    sensitivity: document.getElementById('opt-sensitivity'),
    rate: document.getElementById('opt-rate'),
    quality: document.getElementById('opt-quality'),
    naming: document.getElementById('opt-naming'),
    ref: document.getElementById('opt-ref'),
  };
  for (const [k, el] of Object.entries(fields)) el.value = String(settings[k]);
  document.getElementById('menu').addEventListener('click', () => { panel.hidden = !panel.hidden; });
  document.getElementById('opt-close').addEventListener('click', () => { panel.hidden = true; });
  // Start screen: "Don't show this again" on the card, "Show Start Screen"
  // in Options. Main thread only, like naming.
  const skip = document.getElementById('skip-start');
  const show = document.getElementById('opt-start-screen');
  const setStartScreen = (on) => {
    settings.startScreen = on;
    skip.checked = !on;
    show.checked = on;
    saveSettings(settings);
  };
  setStartScreen(settings.startScreen);
  skip.addEventListener('change', () => setStartScreen(!skip.checked));
  show.addEventListener('change', () => setStartScreen(show.checked));
  for (const [k, el] of Object.entries(fields)) {
    el.addEventListener('change', () => {
      let v = STRING_SETTINGS.has(k) ? el.value : Number(el.value);
      if (k === 'ref') v = Math.min(460, Math.max(420, Number.isFinite(v) ? v : 440));
      settings[k] = v;
      el.value = String(v);
      saveSettings(settings);
      if (k === 'naming') view.dirty = true;     // redraw labels
      if (k !== 'naming' && worker) {
        if (k === 'quality' || k === 'rate') view.clear();
        worker.postMessage({ type: 'settings', settings });
      }
    });
  }
}

// Full screen, holding a screen wake lock while in it. The lock is dropped
// by the browser whenever the page is hidden, so it is re-requested on return.
let wakeLock = null;

const fullscreenElement = () => document.fullscreenElement || document.webkitFullscreenElement;

async function requestWakeLock() {
  if (!('wakeLock' in navigator) || wakeLock || document.visibilityState !== 'visible') return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch { /* refused, e.g. by a battery saver */ }
}

function bindFullscreen() {
  const button = document.getElementById('fullscreen');
  const root = document.documentElement;
  const enter = root.requestFullscreen || root.webkitRequestFullscreen;
  const exit = document.exitFullscreen || document.webkitExitFullscreen;
  if (!enter) return;                   // e.g. iPhone Safari: button stays hidden
  button.hidden = false;
  button.addEventListener('click', () => {
    const p = fullscreenElement() ? exit.call(document) : enter.call(root);
    Promise.resolve(p).catch((err) => console.error(err));
  });
  const onChange = () => {
    const on = !!fullscreenElement();
    button.querySelector('.fs-enter').hidden = on;
    button.querySelector('.fs-exit').hidden = !on;
    button.setAttribute('aria-label', on ? 'Exit full screen' : 'Enter full screen');
    if (on) requestWakeLock();
    else if (wakeLock) wakeLock.release();
  };
  document.addEventListener('fullscreenchange', onChange);
  document.addEventListener('webkitfullscreenchange', onChange);
  document.addEventListener('visibilitychange', () => { if (fullscreenElement()) requestWakeLock(); });
}

startButton.addEventListener('click', () => {
  start().catch((err) => {
    showStartError('Audio error: ' + String(err && err.message || err));
    console.error(err);
  });
});
bindOptions();
bindFullscreen();
bindInstall();
if (settings.startScreen) startDemo();
else start(true).catch(() => showStartScreen());
requestAnimationFrame(frame);

// Offline support (sw.js). Needs localhost or HTTPS, like the microphone.
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
