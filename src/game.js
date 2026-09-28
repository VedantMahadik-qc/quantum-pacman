// Quantum Pac-Man: state, input, tile-locked movement, ghost AI, and maze morphing.
import { WALL, PATH, COLS, ROWS, LAYOUT, TopologyQueue, connectAll, isPen, isLocked } from './mothLabyrinth.js';

// Top-level game states. PLAYING has sub-phases (this.phase): ready → playing → dying | clear.
export const STATE_START = 'start';
export const STATE_PLAYING = 'playing';
export const STATE_PAUSED = 'paused';
export const STATE_GAMEOVER = 'gameover';

const COLLAPSE_PERIOD = 6; // seconds between superposition collapses
const SHAKE_TIME = 0.5;
const FRIGHT_TIME = 7;
const START_LIVES = 3;

const PAC_SPEED = 6.5; // tiles per second
const GHOST_SPEED = 5.4;
const EATEN_SPEED = 13;
const CORNER_WINDOW = 0.3; // fraction of a tile within which a turn snaps through a corner

const PTS_PELLET = 10;
const PTS_POWER = 50;
const PTS_GHOST = 200;

const HIGH_KEY = 'qpm-highscore';

const DIRS = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
const KEYMAP = {
  KeyW: 'up', ArrowUp: 'up',
  KeyS: 'down', ArrowDown: 'down',
  KeyA: 'left', ArrowLeft: 'left',
  KeyD: 'right', ArrowRight: 'right',
};
const NEIGHBORS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

const GHOSTS = [
  { name: 'Blinky', color: '#ff2a2a', release: 0 },
  { name: 'Pinky', color: '#ffb8de', release: 3 },
  { name: 'Inky', color: '#2ef2ff', release: 6 },
];

export class Game {
  constructor(renderer, hooks = {}) {
    this.renderer = renderer;
    this.hooks = hooks; // { getApiKey, getMode, onHud, onSource, onStatus, onEngine, onState }
    this.state = STATE_START;
    this.high = readHigh();
    this.W = COLS;
    this.H = ROWS;
    this.queue = new TopologyQueue({
      getApiKey: () => hooks.getApiKey?.() || '',
      getMode: () => hooks.getMode?.() || 'emu',
      onStatus: (text) => hooks.onStatus?.(text),
      onEngine: (engine, error) => hooks.onEngine?.(engine, error),
    });
    this.last = 0;
    renderer.resize(COLS, ROWS);

    addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      const k = KEYMAP[e.code];
      const idle = this.state === STATE_START || this.state === STATE_GAMEOVER;
      if (e.code === 'Space' || e.code === 'Enter') {
        e.preventDefault();
        if (e.repeat) return;
        if (idle) this.begin();
        else if (e.code === 'Space') this.forceCollapse();
      } else if (e.code === 'Escape' || e.code === 'KeyP') {
        e.preventDefault();
        if (!e.repeat) this.togglePause();
      } else if (k) {
        e.preventDefault();
        if (this.player && this.state === STATE_PLAYING) this.player.next = DIRS[k];
      }
    });

    // Leaving the tab or window pauses the game instead of letting ghosts run unattended.
    const autoPause = () => { if (this.state === STATE_PLAYING) this.togglePause(); };
    addEventListener('blur', autoPause);
    document.addEventListener?.('visibilitychange', () => { if (document.hidden) autoPause(); });
  }

  /**
   * Touch controls on `el` (the canvas):
   *  • swipe ≥ SWIPE_PX in a direction steers Pac-Man (chained swipes work mid-touch)
   *  • tap starts the game (start / game-over screens) or resumes when paused
   *  • double-tap while playing forces a collapse
   * Default gestures (scroll, pull-to-refresh, double-tap zoom) are suppressed on the canvas.
   */
  bindTouch(el) {
    const SWIPE_PX = 20;
    const DOUBLE_TAP_MS = 300;
    let start = null;
    let swiped = false;
    let lastTap = { t: 0, x: 0, y: 0 };

    const steer = (dx, dy) => {
      const dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? DIRS.right : DIRS.left) : (dy > 0 ? DIRS.down : DIRS.up);
      if (this.player && this.state === STATE_PLAYING) this.player.next = dir;
    };

    el.addEventListener('touchstart', (e) => {
      e.preventDefault();
      this.touchUI = true;
      const t = e.changedTouches[0];
      start = { x: t.clientX, y: t.clientY };
      swiped = false;
    }, { passive: false });

    el.addEventListener('touchmove', (e) => {
      e.preventDefault();
      if (!start) return;
      const t = e.changedTouches[0];
      const dx = t.clientX - start.x;
      const dy = t.clientY - start.y;
      if (Math.max(Math.abs(dx), Math.abs(dy)) < SWIPE_PX) return;
      steer(dx, dy);
      swiped = true;
      start = { x: t.clientX, y: t.clientY }; // re-anchor so a single touch can chain turns
    }, { passive: false });

    el.addEventListener('touchend', (e) => {
      e.preventDefault();
      if (!start) return;
      const t = e.changedTouches[0];
      const dx = t.clientX - start.x;
      const dy = t.clientY - start.y;
      start = null;
      if (Math.max(Math.abs(dx), Math.abs(dy)) >= SWIPE_PX) { steer(dx, dy); return; }
      if (swiped) return;

      // A tap.
      if (this.state === STATE_START || this.state === STATE_GAMEOVER) { this.begin(); return; }
      if (this.state === STATE_PAUSED) { this.togglePause(); return; }
      const now = performance.now();
      const near = Math.hypot(t.clientX - lastTap.x, t.clientY - lastTap.y) < 40;
      if (now - lastTap.t < DOUBLE_TAP_MS && near) {
        this.forceCollapse();
        lastTap = { t: 0, x: 0, y: 0 };
      } else {
        lastTap = { t: now, x: t.clientX, y: t.clientY };
      }
    }, { passive: false });

    el.addEventListener('touchcancel', () => { start = null; });
  }

  /** Build the first board (shown behind the start screen) and start the render loop. */
  start() {
    this.newGame();
    this.#setState(STATE_START);
    requestAnimationFrame((t) => this.#frame(t));
  }

  /** Start (or restart after game over) a run. */
  begin() {
    if (this.state === STATE_GAMEOVER) this.newGame();
    this.#setState(STATE_PLAYING);
  }

  togglePause() {
    if (this.state === STATE_PLAYING) this.#setState(STATE_PAUSED);
    else if (this.state === STATE_PAUSED) this.#setState(STATE_PLAYING);
  }

  #setState(state) {
    this.state = state;
    this.hooks.onState?.(state);
  }

  newGame() {
    this.score = 0;
    this.lives = START_LIVES;
    this.level = 0;
    this.nextLevel();
  }

  nextLevel() {
    this.level += 1;
    const topo = this.queue.take();
    this.grid = topo.grid.map((row) => row.slice());
    this.#setSource(topo);
    this.renderer.invalidateWalls();

    const { W, H } = this;
    const corners = [[1, 1], [W - 2, 1], [1, H - 2], [W - 2, H - 2]];
    this.power = new Set(corners.map(([x, y]) => y * W + x));
    this.pellets = new Set();
    const spawn = LAYOUT.pacSpawn;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const k = y * W + x;
        if (this.grid[y][x] !== PATH || this.power.has(k) || isPen(x, y)) continue;
        if (x === spawn.x && y === spawn.y) continue;
        this.pellets.add(k);
      }
    }

    this.collapseIn = COLLAPSE_PERIOD;
    this.#resetActors();
  }

  /** Trigger a superposition collapse now (UI button). */
  forceCollapse() {
    if (this.state !== STATE_PLAYING) return;
    if (this.phase === 'playing' || this.phase === 'ready') this.#collapse();
  }

  // ─── Actors ────────────────────────────────────────────────────────────

  #resetActors() {
    const ps = nearestOpen(this.grid, LAYOUT.pacSpawn.x, LAYOUT.pacSpawn.y);
    this.player = { tx: ps.x, ty: ps.y, t: 0, dir: [0, 0], next: DIRS.left, facing: DIRS.left };
    const speedup = 1 + 0.05 * (this.level - 1);
    this.ghosts = GHOSTS.map((g, i) => {
      const s = LAYOUT.ghostSpawns[i];
      return {
        ...g,
        spawn: s,
        tx: s.x,
        ty: s.y,
        t: 0,
        dir: [0, 0],
        mode: g.release === 0 ? 'chase' : 'house',
        releaseIn: g.release,
        speed: GHOST_SPEED * speedup,
        path: [],
      };
    });
    this.fright = 0;
    this.shake = 0;
    this.phase = 'ready';
    this.phaseTime = 1.6;
  }

  #frame(t) {
    const dt = Math.min(0.05, (t - this.last) / 1000 || 0);
    this.last = t;
    this.tick(dt);
    requestAnimationFrame((n) => this.#frame(n));
  }

  /** Advance the simulation by `dt` seconds and render one frame. */
  tick(dt) {
    // Only PLAYING advances the simulation (timer, movement, ghosts). Paused freezes the
    // renderer's clock too; the start screen keeps idle animations running behind it.
    if (this.state === STATE_PLAYING) this.#update(dt);
    this.renderer.draw(this, this.state === STATE_PAUSED ? 0 : dt);
    this.#emitHud();
  }

  #update(dt) {
    this.shake = Math.max(0, this.shake - dt);

    switch (this.phase) {
      case 'ready':
        if ((this.phaseTime -= dt) <= 0) this.phase = 'playing';
        return;
      case 'dying':
        if ((this.phaseTime -= dt) <= 0) {
          this.lives -= 1;
          if (this.lives <= 0) {
            this.phase = 'gameover';
            this.#setState(STATE_GAMEOVER);
          } else {
            this.#resetActors();
          }
        }
        return;
      case 'clear':
        if ((this.phaseTime -= dt) <= 0) this.nextLevel();
        return;
      case 'gameover':
        return;
    }

    this.collapseIn -= dt;
    if (this.collapseIn <= 0) this.#collapse();

    if (this.fright > 0) this.fright = Math.max(0, this.fright - dt);

    this.#movePlayer(dt);
    this.#eat();
    for (const g of this.ghosts) this.#moveGhost(g, dt);
    this.#collide();

    if (this.pellets.size === 0 && this.power.size === 0) {
      this.phase = 'clear';
      this.phaseTime = 1.5;
    }
  }

  #movePlayer(dt) {
    const p = this.player;
    const { grid, W } = this;
    const [nx, ny] = p.next;
    const moving = p.dir[0] || p.dir[1];

    if (p.t > 0 && moving) {
      if (nx === -p.dir[0] && ny === -p.dir[1]) {
        // Instant reversal mid-corridor.
        p.tx = wrapX(p.tx + p.dir[0], W);
        p.ty += p.dir[1];
        p.t = 1 - p.t;
        p.dir = p.next;
      } else if (nx !== p.dir[0] || ny !== p.dir[1]) {
        // Corner sliding: a perpendicular turn pressed just after or just before a
        // junction snaps through the corner instead of being lost.
        if (p.t < CORNER_WINDOW && isOpen(grid, p.tx + nx, p.ty + ny)) {
          p.t = 0;
        } else if (p.t > 1 - CORNER_WINDOW && isOpen(grid, p.tx + p.dir[0] + nx, p.ty + p.dir[1] + ny)) {
          p.tx = wrapX(p.tx + p.dir[0], W);
          p.ty += p.dir[1];
          p.t = 0;
        }
      }
    }

    advance(p, PAC_SPEED * dt, W, (e) => {
      // Turn buffering: the queued direction is taken at the first tile center where it's open.
      if (isOpen(grid, e.tx + e.next[0], e.ty + e.next[1])) e.dir = e.next;
      else if (!isOpen(grid, e.tx + e.dir[0], e.ty + e.dir[1])) e.dir = [0, 0];
    });
    if (p.dir[0] || p.dir[1]) p.facing = p.dir;
    p.moving = !!(p.dir[0] || p.dir[1]);
  }

  #moveGhost(g, dt) {
    if (g.mode === 'house') {
      if ((g.releaseIn -= dt) <= 0) g.mode = 'chase';
      return;
    }
    let speed = g.speed;
    if (g.mode === 'eaten') speed = EATEN_SPEED;
    else if (this.fright > 0 && g.frightened) speed = g.speed * 0.5;
    else if (g.ty === LAYOUT.tunnelRow && (g.tx < 2 || g.tx > this.W - 3)) speed = g.speed * 0.6; // tunnel drag
    advance(g, speed * dt, this.W, (e) => this.#steer(e));
  }

  /** Choose a ghost's direction at a tile center. */
  #steer(g) {
    if (g.mode === 'eaten' && g.tx === g.spawn.x && g.ty === g.spawn.y) {
      g.mode = 'chase';
      g.frightened = false;
    }

    if (g.mode === 'chase' && this.fright > 0 && g.frightened) {
      // Frightened: wander, preferring not to reverse and to increase distance from Pac-Man.
      const options = NEIGHBORS.filter(([dx, dy]) => isOpen(this.grid, g.tx + dx, g.ty + dy));
      if (!options.length) { this.#unstick(g); g.dir = [0, 0]; return; }
      const forward = options.filter(([dx, dy]) => dx !== -g.dir[0] || dy !== -g.dir[1]);
      const pool = forward.length ? forward : options;
      const p = this.player;
      pool.sort((a, b) =>
        Math.hypot(g.tx + b[0] - p.tx, g.ty + b[1] - p.ty) - Math.hypot(g.tx + a[0] - p.tx, g.ty + a[1] - p.ty));
      g.dir = Math.random() < 0.6 ? pool[0] : pool[Math.floor(Math.random() * pool.length)];
      g.path = [];
      return;
    }

    this.#repath(g);
    const step = g.path[1];
    g.dir = step ? stepDir(g, step, this.W) : [0, 0];
  }

  #repath(g) {
    const target = g.mode === 'eaten' ? g.spawn : this.#ghostTarget(g);
    g.path = bfsPath(this.grid, { x: g.tx, y: g.ty }, target);
    if (!g.path) {
      // Severed from its target (or sealed in) — punch out, then try again.
      this.#unstick(g);
      g.path = bfsPath(this.grid, { x: g.tx, y: g.ty }, target) || [];
    }
  }

  /** Force open an adjacent wall so a trapped ghost can rejoin the maze. */
  #unstick(g) {
    const { grid, W, H } = this;
    const options = NEIGHBORS
      .map(([dx, dy]) => ({ x: g.tx + dx, y: g.ty + dy }))
      .filter(({ x, y }) => x > 0 && y > 0 && x < W - 1 && y < H - 1 && !isLocked(x, y));
    const pick = options.find(({ x, y }) => grid[y][x] === WALL);
    if (pick) grid[pick.y][pick.x] = PATH;
    connectAll(grid, { x: this.player.tx, y: this.player.ty });
    this.renderer.invalidateWalls();
  }

  #ghostTarget(g) {
    const p = this.player;
    const [fx, fy] = p.facing;
    switch (g.name) {
      case 'Pinky': // ambush 4 tiles ahead
        return nearestOpen(this.grid, p.tx + fx * 4, p.ty + fy * 4);
      case 'Inky': { // flank: mirror Blinky around the tile 2 ahead of Pac-Man
        const b = this.ghosts[0];
        return nearestOpen(this.grid, 2 * (p.tx + fx * 2) - b.tx, 2 * (p.ty + fy * 2) - b.ty);
      }
      default: // Blinky: direct pursuit
        return { x: p.tx, y: p.ty };
    }
  }

  #eat() {
    const { x, y } = snapTile(this.player, this.W);
    const k = y * this.W + x;
    if (this.pellets.delete(k)) this.#addScore(PTS_PELLET);
    if (this.power.delete(k)) {
      this.#addScore(PTS_POWER);
      this.fright = FRIGHT_TIME;
      for (const g of this.ghosts) {
        if (g.mode === 'eaten') continue;
        g.frightened = true;
        // Classic behavior: ghosts reverse when frightened.
        if (g.t > 0) {
          g.tx = wrapX(g.tx + g.dir[0], this.W);
          g.ty += g.dir[1];
          g.t = 1 - g.t;
          g.dir = [-g.dir[0], -g.dir[1]];
        }
      }
    }
    if (this.fright === 0) for (const g of this.ghosts) g.frightened = false;
  }

  #collide() {
    const pp = actorPos(this.player);
    for (const g of this.ghosts) {
      if (g.mode !== 'chase') continue;
      const gp = actorPos(g);
      if (Math.hypot(pp.x - gp.x, pp.y - gp.y) > 0.6) continue;
      if (this.fright > 0 && g.frightened) {
        g.mode = 'eaten';
        g.frightened = false;
        this.#addScore(PTS_GHOST);
        this.renderer.popup(`${PTS_GHOST}`, gp.x, gp.y);
      } else {
        this.phase = 'dying';
        this.phaseTime = 1.2;
        return;
      }
    }
  }

  #addScore(n) {
    this.score += n;
    if (this.score > this.high) {
      this.high = this.score;
      writeHigh(this.high);
    }
  }

  // ─── Superposition collapse ────────────────────────────────────────────

  #collapse() {
    const topo = this.queue.take();
    const grid = topo.grid.map((row) => row.slice());
    const { W, H } = this;
    const interior = (x, y) => x > 0 && y > 0 && x < W - 1 && y < H - 1;

    // Morph safety: the full 3×3 block centred on Pac-Man (plus the tile he's entering)
    // is opened, so a wall never lands on him and none of his four exits is sealed.
    const p = this.player;
    const safe = [];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) safe.push({ x: p.tx + dx, y: p.ty + dy });
    if (p.t > 0) safe.push({ x: wrapX(p.tx + p.dir[0], W), y: p.ty + p.dir[1] });
    for (const c of safe) if (interior(c.x, c.y) && !isLocked(c.x, c.y)) grid[c.y][c.x] = PATH;
    grid[p.ty][p.tx] = PATH; // even on a tunnel edge tile

    // Ghosts: their tile (and the one they're entering) are always floor.
    for (const g of this.ghosts) {
      grid[g.ty][g.tx] = PATH;
      if (g.t > 0) grid[g.ty + g.dir[1]][wrapX(g.tx + g.dir[0], W)] = PATH;
    }

    // Flood fill from Pac-Man: any floor the carving above cut off gets stitched back in.
    connectAll(grid, { x: p.tx, y: p.ty });

    this.grid = grid;
    this.#setSource(topo);

    // Keep only pellets that landed on open corridor.
    const keep = (set) => new Set([...set].filter((k) => grid[Math.floor(k / W)][k % W] === PATH));
    this.pellets = keep(this.pellets);
    this.power = keep(this.power);

    // Ghosts re-plan from their current cell against the new topology right away.
    for (const g of this.ghosts) {
      if (g.mode === 'house') continue;
      if (this.fright > 0 && g.frightened) { g.path = []; continue; }
      this.#repath(g);
      // If mid-edge and the old heading no longer continues, the next center re-steers.
    }

    this.collapseIn = COLLAPSE_PERIOD;
    this.shake = SHAKE_TIME;
    this.renderer.invalidateWalls();
  }

  #setSource(topo) {
    this.topology = topo;
    this.jobId = topo.jobIds?.[0] || null;
    this.hooks.onSource?.(topo);
  }

  #emitHud() {
    this.hooks.onHud?.({
      score: this.score,
      high: this.high,
      lives: this.lives,
      level: this.level,
      collapseIn: this.collapseIn,
      collapsePeriod: COLLAPSE_PERIOD,
      jobId: this.jobId,
      fright: this.fright,
    });
  }
}

// ─── Movement & grid helpers ────────────────────────────────────────────

const wrapX = (x, W) => ((x % W) + W) % W;

/**
 * Tile-locked movement: actors travel edge-by-edge between tile centers.
 * `decide` runs at every tile center to pick the next direction. X wraps
 * through the side tunnels.
 */
function advance(e, dist, W, decide) {
  let guard = 8;
  while (dist > 1e-6 && guard--) {
    if (e.t === 0) {
      decide(e);
      if (!e.dir[0] && !e.dir[1]) return;
    }
    const step = Math.min(dist, 1 - e.t);
    e.t += step;
    dist -= step;
    if (e.t >= 1 - 1e-9) {
      e.tx = wrapX(e.tx + e.dir[0], W);
      e.ty += e.dir[1];
      e.t = 0;
    }
  }
}

/** Continuous position in tile units (may briefly sit outside [0, W) inside a tunnel). */
export function actorPos(a) {
  return { x: a.tx + 0.5 + a.dir[0] * a.t, y: a.ty + 0.5 + a.dir[1] * a.t };
}

function snapTile(a, W) {
  return a.t < 0.5 ? { x: a.tx, y: a.ty } : { x: wrapX(a.tx + a.dir[0], W), y: a.ty + a.dir[1] };
}

function stepDir(from, to, W) {
  let dx = to.x - from.tx;
  if (dx > 1) dx = -1; // wrapped through the left tunnel
  if (dx < -1) dx = 1; // wrapped through the right tunnel
  return [dx, to.y - from.ty];
}

function isOpen(grid, x, y) {
  const row = grid[y];
  return !!row && row[wrapX(x, row.length)] === PATH;
}

function bfsPath(grid, from, to) {
  const H = grid.length;
  const W = grid[0].length;
  const prev = new Int32Array(W * H).fill(-1);
  const start = from.y * W + from.x;
  const goal = to.y * W + to.x;
  prev[start] = start;
  const queue = [start];
  for (let i = 0; i < queue.length; i++) {
    const cur = queue[i];
    if (cur === goal) break;
    const cx = cur % W;
    const cy = (cur - cx) / W;
    for (const [dx, dy] of NEIGHBORS) {
      const nx = wrapX(cx + dx, W);
      const ny = cy + dy;
      if (!isOpen(grid, nx, ny)) continue;
      const n = ny * W + nx;
      if (prev[n] !== -1) continue;
      prev[n] = cur;
      queue.push(n);
    }
  }
  if (prev[goal] === -1) return null;
  const path = [];
  for (let k = goal; ; k = prev[k]) {
    path.push({ x: k % W, y: Math.floor(k / W) });
    if (k === start) break;
  }
  return path.reverse();
}

/** Nearest open tile to (x, y), searching outward through any tile. */
function nearestOpen(grid, x, y) {
  const H = grid.length;
  const W = grid[0].length;
  x = Math.max(0, Math.min(W - 1, Math.round(x)));
  y = Math.max(0, Math.min(H - 1, Math.round(y)));
  const seen = new Set([y * W + x]);
  const queue = [{ x, y }];
  for (let i = 0; i < queue.length; i++) {
    const c = queue[i];
    if (isOpen(grid, c.x, c.y)) return c;
    for (const [dx, dy] of NEIGHBORS) {
      const nx = c.x + dx;
      const ny = c.y + dy;
      const k = ny * W + nx;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H || seen.has(k)) continue;
      seen.add(k);
      queue.push({ x: nx, y: ny });
    }
  }
  return { x: 1, y: 1 };
}

function readHigh() {
  try { return Number(localStorage.getItem(HIGH_KEY)) || 0; } catch { return 0; }
}
function writeHigh(v) {
  try { localStorage.setItem(HIGH_KEY, String(v)); } catch { /* storage blocked */ }
}
