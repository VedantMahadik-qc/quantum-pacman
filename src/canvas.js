// Arcade renderer: navy field, neon-blue walls, glowing pellets, glitch collapse.
import { WALL } from './mothLabyrinth.js';
import { actorPos, STATE_START, STATE_PLAYING, STATE_PAUSED, STATE_GAMEOVER } from './game.js';

const NAVY = '#00001e';
const WALL_BLUE = '#1919A6';
const WALL_GLOW = '#3b3bff';
const PELLET = '#ffe066';
const PAC = '#ffe000';
const FRIGHT_BLUE = '#2121de';
const FRIGHT_FACE = '#ffb8ae';

// Overlay prompts blink on wall-clock time so they keep blinking while the game is frozen.
const blinkOn = () => Math.floor(performance.now() / 500) % 2 === 0;

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.time = 0;
    this.wallCache = null;
    this.wallGrid = null;
    this.popups = [];
  }

  resize(cols, rows) {
    this.cols = cols;
    this.rows = rows;
    this.setDisplayTile(this.cssTile || 24);
  }

  /**
   * Crisp integer scaling: each tile is exactly `cssTile` CSS px on screen, and the
   * backing store is rendered at that size × devicePixelRatio, so every tile maps to
   * whole device pixels (no blurry fractional resampling on any display).
   */
  setDisplayTile(cssTile) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2); // cap for mobile fill-rate
    const tile = Math.max(8, Math.round(cssTile * dpr));
    if (tile === this.tile && cssTile === this.cssTile) return;
    this.cssTile = cssTile;
    this.tile = tile;
    this.canvas.width = this.cols * tile;
    this.canvas.height = this.rows * tile;
    this.canvas.style.width = `${this.cols * cssTile}px`;
    this.canvas.style.height = `${this.rows * cssTile}px`;
    this.invalidateWalls();
  }

  invalidateWalls() {
    this.wallGrid = null;
  }

  popup(text, x, y) {
    this.popups.push({ text, x, y, life: 1 });
  }

  draw(game, dt) {
    this.time += dt;
    const { ctx, tile: T } = this;
    const W = this.canvas.width;
    const H = this.canvas.height;

    ctx.save();
    ctx.fillStyle = NAVY;
    ctx.fillRect(0, 0, W, H);

    // The collapse glitch only animates while actually playing (frozen when paused).
    const shakeK = game.state === STATE_PLAYING ? game.shake / 0.5 : 0;
    if (shakeK > 0) ctx.translate((Math.random() - 0.5) * T * 0.8 * shakeK, (Math.random() - 0.5) * T * 0.8 * shakeK);

    if (this.wallGrid !== game.grid) this.#buildWalls(game.grid);
    ctx.drawImage(this.wallCache, 0, 0);

    this.#drawPellets(game);
    if (game.state !== STATE_GAMEOVER) {
      for (const g of game.ghosts) this.#wrapped(actorPos(g), (pos) => this.#drawGhost(g, game, pos));
      this.#wrapped(actorPos(game.player), (pos) => this.#drawPac(game, pos));
    }
    this.#drawPopups(dt);
    ctx.restore();

    if (shakeK > 0) this.#glitch(shakeK);
    this.#banner(game);

    // Faint scanlines for the cabinet feel.
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    for (let y = 0; y < H; y += 3) ctx.fillRect(0, y, W, 1);
  }

  // ─── Walls (cached per topology) ───────────────────────────────────────

  #buildWalls(grid) {
    const T = this.tile;
    const rows = grid.length;
    const cols = grid[0].length;
    const base = document.createElement('canvas');
    base.width = cols * T;
    base.height = rows * T;
    const b = base.getContext('2d');
    const wall = (x, y) => grid[y]?.[x] === undefined || grid[y][x] === WALL;
    const line = Math.max(2, Math.round(T * 0.12));
    const inset = Math.round(T * 0.22);

    // 1) Blue slab for every wall tile, shrunk away from corridors.
    b.fillStyle = WALL_BLUE;
    const slab = (x, y) => [
      x * T + (wall(x - 1, y) ? 0 : inset),
      y * T + (wall(x, y - 1) ? 0 : inset),
      (x + 1) * T - (wall(x + 1, y) ? 0 : inset),
      (y + 1) * T - (wall(x, y + 1) ? 0 : inset),
    ];
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
      if (!wall(x, y)) continue;
      const [l, t, r, bt] = slab(x, y);
      b.fillRect(l, t, r - l, bt - t);
    }
    // 2) Hollow it out with navy, leaving a neon outline.
    b.fillStyle = NAVY;
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
      if (!wall(x, y)) continue;
      const [l, t, r, bt] = slab(x, y);
      const L = l + (wall(x - 1, y) ? 0 : line);
      const Tp = t + (wall(x, y - 1) ? 0 : line);
      const R = r - (wall(x + 1, y) ? 0 : line);
      const B = bt - (wall(x, y + 1) ? 0 : line);
      b.fillRect(L, Tp, R - L, B - Tp);
    }
    // 3) Re-draw inner corners where a diagonal corridor would otherwise leave a gap.
    b.fillStyle = WALL_BLUE;
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
      if (!wall(x, y)) continue;
      for (const [dx, dy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        if (wall(x + dx, y) && wall(x, y + dy) && !wall(x + dx, y + dy)) {
          const cx = dx < 0 ? x * T + inset : (x + 1) * T - inset - line;
          const cy = dy < 0 ? y * T + inset : (y + 1) * T - inset - line;
          b.fillRect(dx < 0 ? x * T : cx, dy < 0 ? y * T : cy, dx < 0 ? inset + line : inset + line, dy < 0 ? inset + line : inset + line);
          b.fillStyle = NAVY;
          b.fillRect(dx < 0 ? x * T : cx + line, dy < 0 ? y * T : cy + line, inset, inset);
          b.fillStyle = WALL_BLUE;
        }
      }
    }

    // Glow pass baked into the cache.
    const cache = document.createElement('canvas');
    cache.width = base.width;
    cache.height = base.height;
    const c = cache.getContext('2d');
    c.shadowColor = WALL_GLOW;
    c.shadowBlur = T * 0.35;
    c.drawImage(base, 0, 0);
    c.shadowBlur = 0;
    c.drawImage(base, 0, 0);

    this.wallCache = cache;
    this.wallGrid = grid;
  }

  // ─── Pellets ───────────────────────────────────────────────────────────

  #drawPellets(game) {
    const { ctx, tile: T } = this;
    const W = game.W;
    ctx.fillStyle = PELLET;
    for (const k of game.pellets) {
      const x = (k % W + 0.5) * T;
      const y = (Math.floor(k / W) + 0.5) * T;
      ctx.globalAlpha = 0.18;
      ctx.beginPath();
      ctx.arc(x, y, T * 0.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.beginPath();
      ctx.arc(x, y, T * 0.09, 0, Math.PI * 2);
      ctx.fill();
    }

    const blinkOn = Math.sin(this.time * 8) > -0.3;
    if (blinkOn) {
      ctx.shadowColor = PELLET;
      ctx.shadowBlur = T * 0.6;
      for (const k of game.power) {
        const x = (k % W + 0.5) * T;
        const y = (Math.floor(k / W) + 0.5) * T;
        const r = T * (0.26 + 0.04 * Math.sin(this.time * 5));
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.shadowBlur = 0;
    }
  }

  // ─── Pac-Man ───────────────────────────────────────────────────────────

  /** Draw an actor, plus its mirror image while it straddles a side tunnel. */
  #wrapped(pos, draw) {
    draw(pos);
    if (pos.x < 1) draw({ x: pos.x + this.cols, y: pos.y });
    else if (pos.x > this.cols - 1) draw({ x: pos.x - this.cols, y: pos.y });
  }

  #drawPac(game, { x, y }) {
    const { ctx, tile: T } = this;
    const p = game.player;
    const r = T * 0.44;
    const cx = x * T;
    const cy = y * T;

    if (game.phase === 'dying') {
      // Classic collapse-into-nothing death animation.
      const k = 1 - Math.max(0, game.phaseTime) / 1.2;
      const gape = Math.min(Math.PI, k * Math.PI * 1.1);
      ctx.fillStyle = PAC;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, r, -Math.PI / 2 + gape, -Math.PI / 2 - gape + Math.PI * 2);
      ctx.closePath();
      ctx.fill();
      return;
    }

    const angle = Math.atan2(p.facing[1], p.facing[0]);
    const mouth = p.moving ? (0.04 + 0.24 * Math.abs(Math.sin(this.time * 14))) * Math.PI : 0.12 * Math.PI;
    ctx.shadowColor = PAC;
    ctx.shadowBlur = T * 0.4;
    ctx.fillStyle = PAC;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, angle + mouth, angle - mouth + Math.PI * 2);
    ctx.closePath();
    ctx.fill();
    ctx.shadowBlur = 0;
  }

  // ─── Ghosts ────────────────────────────────────────────────────────────

  #drawGhost(g, game, { x, y }) {
    const { ctx, tile: T } = this;
    const cx = x * T;
    const cy = y * T;
    const r = T * 0.44;
    const frightened = game.fright > 0 && g.frightened && g.mode !== 'eaten';

    if (g.mode !== 'eaten') {
      let body = g.color;
      if (frightened) {
        const flashing = game.fright < 2 && Math.floor(this.time * 8) % 2 === 0;
        body = flashing ? '#ffffff' : FRIGHT_BLUE;
      }
      if (g.mode === 'house') ctx.globalAlpha = 0.75;
      ctx.shadowColor = body;
      ctx.shadowBlur = T * 0.3;
      ctx.fillStyle = body;
      ctx.beginPath();
      ctx.arc(cx, cy - r * 0.15, r, Math.PI, 0);
      const bottom = cy + r;
      ctx.lineTo(cx + r, bottom);
      const waves = 3;
      const phase = Math.floor(this.time * 8) % 2 ? 0.5 : 0;
      for (let i = waves * 2; i >= 0; i--) {
        const wx = cx - r + (2 * r * i) / (waves * 2);
        const wy = bottom - ((i + phase * 2) % 2 === 0 ? 0 : r * 0.28);
        ctx.lineTo(wx, wy);
      }
      ctx.closePath();
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.globalAlpha = 1;

      if (frightened) {
        const face = game.fright < 2 && Math.floor(this.time * 8) % 2 === 0 ? '#ff2a2a' : FRIGHT_FACE;
        ctx.fillStyle = face;
        ctx.fillRect(cx - r * 0.4, cy - r * 0.35, r * 0.22, r * 0.22);
        ctx.fillRect(cx + r * 0.18, cy - r * 0.35, r * 0.22, r * 0.22);
        ctx.strokeStyle = face;
        ctx.lineWidth = Math.max(1, T * 0.05);
        ctx.beginPath();
        for (let i = 0; i <= 6; i++) {
          const mx = cx - r * 0.6 + (r * 1.2 * i) / 6;
          const my = cy + r * 0.3 + (i % 2 ? -r * 0.12 : 0);
          i ? ctx.lineTo(mx, my) : ctx.moveTo(mx, my);
        }
        ctx.stroke();
        return;
      }
    }

    // Eyes looking where the ghost is heading.
    const [dx, dy] = g.dir;
    for (const side of [-1, 1]) {
      const ex = cx + side * r * 0.36;
      const ey = cy - r * 0.2;
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.ellipse(ex, ey, r * 0.26, r * 0.32, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#1b3cff';
      ctx.beginPath();
      ctx.arc(ex + dx * r * 0.12, ey + dy * r * 0.14, r * 0.14, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  #drawPopups(dt) {
    const { ctx, tile: T } = this;
    ctx.font = `${Math.round(T * 0.45)}px "Press Start 2P", monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#2ef2ff';
    this.popups = this.popups.filter((p) => (p.life -= dt) > 0);
    for (const p of this.popups) {
      ctx.globalAlpha = Math.min(1, p.life * 2);
      ctx.fillText(p.text, p.x * T, (p.y - (1 - p.life) * 0.8) * T);
    }
    ctx.globalAlpha = 1;
  }

  // ─── Effects & banners ─────────────────────────────────────────────────

  #glitch(k) {
    const { ctx } = this;
    const W = this.canvas.width;
    const H = this.canvas.height;
    // Displace random horizontal slices.
    const slices = 6 + Math.floor(Math.random() * 6);
    for (let i = 0; i < slices; i++) {
      const sy = Math.random() * H;
      const sh = 4 + Math.random() * 28;
      const dx = (Math.random() - 0.5) * 60 * k;
      ctx.drawImage(this.canvas, 0, sy, W, sh, dx, sy, W, sh);
    }
    // Chromatic tint bands.
    ctx.globalCompositeOperation = 'lighter';
    for (const color of ['rgba(255,0,120,0.18)', 'rgba(0,255,255,0.14)']) {
      ctx.fillStyle = color;
      ctx.fillRect(0, Math.random() * H, W, 8 + Math.random() * 40);
    }
    ctx.globalCompositeOperation = 'source-over';
    this.#centerText('SUPERPOSITION COLLAPSE', '#2ef2ff', 0.5, 0.42 * k + 0.1);
  }

  #banner(game) {
    if (game.state === STATE_START) return this.#startScreen(game.touchUI);
    if (game.state === STATE_PAUSED) return this.#pauseScreen(game.touchUI);
    if (game.state === STATE_GAMEOVER) {
      this.#dim(0.55);
      this.#centerText('GAME OVER', '#ff2a2a', 0.44);
      if (blinkOn()) this.#centerText(game.touchUI ? 'TAP TO PLAY AGAIN' : 'PRESS SPACE OR ENTER', '#ffffff', 0.54, 0.4);
      return;
    }
    if (game.phase === 'ready') this.#centerText('READY!', PAC, 0.6);
    else if (game.phase === 'clear') this.#centerText('TOPOLOGY CLEARED', PAC, 0.5);
  }

  #dim(alpha) {
    const { ctx } = this;
    ctx.fillStyle = `rgba(0, 0, 20, ${alpha})`;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
  }

  /** Plain glowing line of text (no backing panel). */
  #line(text, color, yFrac, scale) {
    const { ctx, tile: T } = this;
    ctx.font = `${Math.round(T * scale)}px "Press Start 2P", monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = color;
    ctx.shadowBlur = T * 0.35;
    ctx.fillStyle = color;
    ctx.fillText(text, this.canvas.width / 2, this.canvas.height * yFrac);
    ctx.shadowBlur = 0;
  }

  #startScreen(touch) {
    this.#dim(0.8);
    this.#line('QUANTUM', PAC, 0.24, 1.25);
    this.#line('PAC-MAN', PAC, 0.31, 1.25);
    this.#line('THE SHIFTING LABYRINTH', '#2ef2ff', 0.375, 0.36);
    if (blinkOn()) this.#line(touch ? 'TAP ANYWHERE' : 'PRESS SPACE OR ENTER', '#ffffff', 0.5, 0.5);
    this.#line('TO PLAY', '#ffffff', 0.54, 0.5);
    const hints = touch
      ? [['SWIPE', 'MOVE'], ['DOUBLE-TAP / ⚡', 'COLLAPSE'], ['⏸ BUTTON', 'PAUSE']]
      : [['WASD / ARROWS', 'MOVE'], ['SPACE', 'FORCE COLLAPSE'], ['ESC / P', 'PAUSE']];
    hints.forEach(([key, what], i) => {
      const y = 0.66 + i * 0.055;
      this.#line(`${key.padEnd(13, ' ')} ${what.padStart(14, ' ')}`, '#7f86c9', y, 0.34);
    });
    this.#line('THE MAZE COLLAPSES EVERY 6 SECONDS', '#ffb8de', 0.87, 0.3);
  }

  #pauseScreen(touch) {
    this.#dim(0.6);
    this.#centerText('PAUSED', PAC, 0.45, 0.9);
    this.#line(touch ? 'TAP TO RESUME' : 'ESC / P TO RESUME', '#ffffff', 0.56, 0.4);
  }

  #centerText(text, color, yFrac, scale = 0.6) {
    const { ctx, tile: T } = this;
    const W = this.canvas.width;
    const H = this.canvas.height;
    ctx.font = `${Math.round(T * scale)}px "Press Start 2P", monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const m = ctx.measureText(text);
    ctx.fillStyle = 'rgba(0,0,30,0.85)';
    ctx.fillRect(W / 2 - m.width / 2 - T * 0.4, H * yFrac - T * scale, m.width + T * 0.8, T * scale * 2);
    ctx.shadowColor = color;
    ctx.shadowBlur = T * 0.4;
    ctx.fillStyle = color;
    ctx.fillText(text, W / 2, H * yFrac);
    ctx.shadowBlur = 0;
  }
}
