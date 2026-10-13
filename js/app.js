import { SpectrogramView } from './view.js';

// Note spellings ("Note names" option). The default is sharps only.
const NAMINGS = {
  mixed: ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'B♭', 'B'],
  sharps: ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'],
  flats: ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'G♭', 'G', 'A♭', 'A', 'B♭', 'B'],
};

// Analysis Rate Medium: 43 columns/s, about 6 s on screen.
const DEFAULTS = { sensitivity: 'medium', rate: 1, quality: 1, ref: 440, naming: 'sharps' };
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
let worker = null;

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

async function start() {
  const startEl = document.getElementById('start');
  startEl.querySelector('p').textContent = 'Starting…';
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
    });
  } catch (err) {
    startEl.querySelector('h1').textContent = 'Microphone Access Denied';
    startEl.querySelector('p').textContent = 'Allow microphone access for this page, then tap to try again.';
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
  worker = new Worker('js/worker.js', { type: 'module' });
  worker.onmessage = (e) => { view.addColumn(e.data.col); octaves = e.data.octaves; };
  worker.postMessage({ type: 'init', sampleRate: ctx.sampleRate, port: ch.port2, settings }, [ch.port2]);
  if (ctx.state === 'suspended') await ctx.resume();
  startEl.hidden = true;
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
  for (const [k, el] of Object.entries(fields)) {
    el.addEventListener('change', () => {
      let v = STRING_SETTINGS.has(k) ? el.value : Number(el.value);
      if (k === 'ref') v = Math.min(460, Math.max(420, Number.isFinite(v) ? v : 440));
      settings[k] = v;
      el.value = String(v);
      saveSettings(settings);
      if (k !== 'naming' && worker) {
        if (k === 'quality' || k === 'rate') view.clear();
        worker.postMessage({ type: 'settings', settings });
      }
    });
  }
}

document.getElementById('start').addEventListener('click', () => {
  start().catch((err) => {
    const el = document.getElementById('start');
    el.querySelector('h1').textContent = 'Audio Error!';
    el.querySelector('p').textContent = String(err && err.message || err);
    console.error(err);
  });
});
bindOptions();
requestAnimationFrame(frame);
