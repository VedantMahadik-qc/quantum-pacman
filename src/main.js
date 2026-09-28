import './style.css';
import { Renderer } from './canvas.js';
import { Game, STATE_START, STATE_PLAYING, STATE_PAUSED, STATE_GAMEOVER } from './game.js';
import { shortId, COLS, ROWS } from './mothLabyrinth.js';

const KEY_STORAGE = 'moth-api-key';
const MODE_STORAGE = 'moth-q-mode';

const $ = (id) => document.getElementById(id);
const keyInput = $('api-key');
const modeSelect = $('q-mode');
const badge = $('topology-badge');
const engineLine = $('engine-line');
const statusText = $('status-text');
const pauseBtn = $('pause-btn');

const load = (k) => {
  try { return localStorage.getItem(k) || ''; } catch { return ''; }
};
const save = (k, v) => {
  try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch { /* storage blocked */ }
};

keyInput.value = load(KEY_STORAGE);
modeSelect.value = load(MODE_STORAGE) === 'qpu' ? 'qpu' : 'emu';
const apiKey = () => keyInput.value.trim();

// Only touch the DOM when a value changes — the HUD is fed every frame.
const hudCache = {};
const set = (id, value) => {
  if (hudCache[id] === value) return;
  hudCache[id] = value;
  $(id).textContent = value;
};

let engineName = null;

const canvas = $('game');
const renderer = new Renderer(canvas);

const game = new Game(renderer, {
  getApiKey: apiKey,
  getMode: () => modeSelect.value,
  onHud({ score, high, lives, level, collapseIn, collapsePeriod, jobId }) {
    set('hud-score', String(score));
    set('hud-high', String(high));
    set('hud-level', String(level));
    set('hud-lives', '♥'.repeat(Math.max(0, lives)) || '—');
    set('hud-job', jobId ? `#${shortId(jobId)}` : '—');
    const secs = Math.max(0, Math.ceil(collapseIn));
    set('hud-collapse', `[ ${String(secs).padStart(2, ' ')}s ]`);
    const pct = Math.max(0, Math.min(1, collapseIn / collapsePeriod));
    $('gauge-fill').style.transform = `scaleX(${pct})`;
    $('gauge').classList.toggle('critical', secs <= 2);
  },
  // Badge describes the layout currently on screen — never silently classical.
  onSource(topo) {
    const quantum = topo.source === 'quantum';
    const engine = topo.engine || engineName || 'none';
    const status = quantum
      ? `STATUS: ACTIVE ${topo.mode === 'qpu' ? 'QPU' : 'QUANTUM EMU'} (Job: #${shortId(topo.jobIds[0])})`
      : `STATUS: FALLBACK (Reason: ${topo.reason || 'unknown'})`;
    // First-time players with no key get a friendly hint instead of an error-ish reason.
    badge.textContent = !quantum && !apiKey()
      ? 'ENGINE: CLASSICAL FALLBACK (Enter Moth Key below for QPU)'
      : `ENGINE: ${engine} | ${status}`;
    badge.title = quantum ? `Jobs: ${topo.jobIds.join(', ')}` : '';
    badge.className = `badge ${quantum ? 'qpu' : 'classical'}`;
  },
  onEngine(engine, error) {
    engineName = engine?.id || null;
    engineLine.textContent = engine
      ? `ENGINE: ${engine.id} (${engine.kind} adapter)`
      : apiKey() ? `ENGINE: none — ${error}` : ''; // no key: the badge already says it all
  },
  onStatus(text) {
    statusText.textContent = text;
    statusText.title = text;
  },
  onState(state) {
    const labels = {
      [STATE_START]: ['▶', 'Play'],
      [STATE_PLAYING]: ['⏸', 'Pause'],
      [STATE_PAUSED]: ['▶', 'Resume'],
      [STATE_GAMEOVER]: ['▶', 'Play Again'],
    };
    const [icon, label] = labels[state];
    pauseBtn.innerHTML = `[ <span class="sym">${icon}</span> ${label} ]`;
    pauseBtn.classList.toggle('paused', state === STATE_PAUSED);
  },
});

// One button: Play on the start / game-over screens, Pause ↔ Resume during a run.
pauseBtn.addEventListener('click', (e) => {
  e.currentTarget.blur();
  if (game.state === STATE_START || game.state === STATE_GAMEOVER) game.begin();
  else game.togglePause();
});

// Key or backend change → rediscover the engine and refill the cache.
keyInput.addEventListener('change', () => {
  save(KEY_STORAGE, apiKey());
  game.queue.connect();
});
modeSelect.addEventListener('change', () => {
  save(MODE_STORAGE, modeSelect.value);
  modeSelect.blur();
  game.queue.connect();
});

$('force-collapse').addEventListener('click', (e) => {
  e.currentTarget.blur();
  game.forceCollapse();
});

// Size the screen in whole CSS pixels per tile (crisp integer scaling).
//  • Desktop / landscape: the largest tile size at which the whole cabinet fits the
//    viewport with no scrolling (panel heights depend on text wrapping, so measure).
//  • Mobile (≤ 860px wide, stacked layout): the canvas fits within 100vw × 85vh; the
//    dock below it can scroll into view.
const cabinet = document.querySelector('.cabinet');
const bezel = document.querySelector('.bezel');
const mobileLayout = matchMedia('(max-width: 860px)');
const MOBILE_SIDE_CHROME = 40; // body + cabinet + bezel horizontal padding/borders (see style.css)

function fitCabinet() {
  const preview = (t) => {
    canvas.style.width = `${t * COLS}px`;
    canvas.style.height = `${t * ROWS}px`;
  };
  let tile;
  if (mobileLayout.matches) {
    tile = Math.floor(Math.min((innerWidth - MOBILE_SIDE_CHROME) / COLS, (innerHeight * 0.85) / ROWS));
  } else {
    // Size from the viewport minus the fixed chrome around the canvas. Side panels are
    // fixed-width and height-capped to the screen, so they never dictate the fit.
    const cs = getComputedStyle(cabinet);
    const px = (v) => parseFloat(v) || 0;
    const cabinetV = px(cs.paddingTop) + px(cs.paddingBottom) + px(cs.borderTopWidth) + px(cs.borderBottomWidth);
    const bezelV = bezel.offsetHeight - canvas.offsetHeight;
    const besideW = cabinet.offsetWidth - canvas.offsetWidth; // panels + gaps + paddings + bezel
    const bodyPad = 24;
    tile = Math.floor(Math.min(
      (innerHeight - bodyPad - cabinetV - bezelV) / ROWS,
      (innerWidth - bodyPad - besideW) / COLS,
      48,
    ));
  }
  tile = Math.max(8, tile);
  preview(tile);
  renderer.setDisplayTile(tile);
  document.documentElement.style.setProperty('--panel-max-h', `${bezel.offsetHeight}px`);
}
mobileLayout.addEventListener?.('change', fitCabinet);
addEventListener('resize', fitCabinet);
document.fonts?.ready.then(fitCabinet);
fitCabinet();

// Discover first: with no key this settles synchronously, so the opening board's
// fallback reason is accurate ("no API key" rather than "discovery in progress").
game.queue.connect();
game.touchUI = matchMedia('(pointer: coarse)').matches;
game.bindTouch(canvas);
game.start();

// Touch devices: the on-screen ⚡ button.
$('touch-collapse').addEventListener('click', (e) => {
  e.currentTarget.blur();
  game.forceCollapse();
});

// Dev-only handle for debugging from the console (stripped from production builds).
if (import.meta.env.DEV) window.__qpm = game;
