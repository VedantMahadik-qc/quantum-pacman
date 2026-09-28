// Moth engine client (engine discovery, job pipeline, result → maze) + classical fallback.
// Tiles: 0 = Wall (#), 1 = Path (.)
//
// How the quantum maze works (per the Moth OpenAPI spec for labyrinth-v1 / graph-v1):
//   • We send a grid of ROOMS plus a `coupling_map` — the candidate corridors between
//     neighbouring rooms. One qubit per room; the emulator caps a job at 20 qubits.
//   • The engine prepares a ZZ-correlated state over those corridors and returns the
//     most probable measurement bitstrings (qubit 0 leftmost, one bit per room).
//   • Collapse rule: a candidate corridor stays OPEN when its two rooms measured the
//     same bit, and collapses to a WALL when they disagree.
// The 19×25 board has 9×12 rooms; the left half (5×12 = 60 rooms) is split into three
// 5×4 blocks (20 qubits each, one job per block) and mirrored. Every job returns up to
// `top_n` bitstrings, so one 3-job batch yields up to 16 distinct layouts.

const API_BASE = '/moth-api/api/v1';

export const WALL = 0;
export const PATH = 1;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(apiKey, path, init = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', ...init.headers },
  });
  if (!res.ok) {
    let detail = '';
    try {
      const body = await res.json();
      detail = body.detail || body.title || '';
      if (body.errors?.length) detail += ` — ${body.errors.map((e) => `${e.location ?? ''} ${e.message ?? ''}`.trim()).join('; ')}`;
    } catch { /* non-JSON error body */ }
    const err = new Error(`HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// ─── Portrait arcade layout ─────────────────────────────────────────────

export const COLS = 19;
export const ROWS = 25;

/** Fixed landmarks shared by every topology (quantum or classical). */
export const LAYOUT = {
  pacSpawn: { x: 9, y: 19 },
  // Ghost pen interior (inclusive) and its single door on top.
  pen: { x0: 7, x1: 11, y0: 10, y1: 12 },
  penDoor: { x: 9, y: 9 },
  ghostSpawns: [{ x: 9, y: 11 }, { x: 7, y: 11 }, { x: 11, y: 11 }],
  tunnelRow: 12,
};

const NEIGHBORS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/** Protected walls — the pen ring (except its door) and the tunnel sleeves — that carving may never breach. */
export function isLocked(x, y) {
  const { x0, x1, y0, y1 } = LAYOUT.pen;
  const onRing = x >= x0 - 1 && x <= x1 + 1 && y >= y0 - 1 && y <= y1 + 1
    && (x === x0 - 1 || x === x1 + 1 || y === y0 - 1 || y === y1 + 1);
  if (onRing && !(x === LAYOUT.penDoor.x && y === LAYOUT.penDoor.y)) return true;
  // Warp-tunnel sleeve walls.
  const t = LAYOUT.tunnelRow;
  return (y === t - 1 || y === t + 1) && (x <= 2 || x >= COLS - 3);
}

/** Pen interior or door — no pellets here. */
export function isPen(x, y) {
  const { x0, x1, y0, y1 } = LAYOUT.pen;
  return (x >= x0 && x <= x1 && y >= y0 && y <= y1) || (x === LAYOUT.penDoor.x && y === LAYOUT.penDoor.y);
}

// Room lattice for the left half (mirrored across the center column).
const ROOMS_Y = (ROWS - 1) / 2; // 12
const HALF_X = Math.ceil((COLS - 1) / 4); // 5 (includes the center column)
const BLOCK_ROWS = 4; // 5×4 = 20 rooms = 20 qubits per job (emulator cap)
const MAX_QUBITS = 20;

// ─── Engine discovery ───────────────────────────────────────────────────

/**
 * List the engines this key can see, pick the best maze-capable one, and read its
 * params schema. Resolves to { id, name, kind: 'labyrinth' | 'graph', schema }.
 */
export async function discoverEngine(apiKey) {
  const engines = [];
  let cursor = '';
  for (let page = 0; page < 5; page++) {
    const body = await api(apiKey, `/engines${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`);
    engines.push(...(body.engines || []));
    if (!body.next_cursor) break;
    cursor = body.next_cursor;
  }
  console.log('[MOTH ENGINE LIST]', engines);

  const usable = engines.filter((e) => e.enabled !== false);
  const match = (re) => usable.find((e) => re.test(e.engine_id) || re.test(e.name || ''));
  const chosen = usable.find((e) => e.engine_id === 'labyrinth-v1')
    || match(/labyrinth/i) || match(/maze/i) || match(/graph/i);
  if (!chosen) {
    throw new Error(`no labyrinth/maze/graph engine among ${engines.length} engines`);
  }

  const details = await api(apiKey, `/engines/${encodeURIComponent(chosen.engine_id)}`);
  const schema = details.params_schema || {};
  const kind = schemaKind(schema, chosen.engine_id);
  console.log('[MOTH ENGINE SELECTED]', chosen.engine_id, `(${kind} adapter)`, 'params_schema:', schema);
  return { id: chosen.engine_id, name: details.name || chosen.name, kind, schema };
}

/** Decide the payload shape from the engine's real params schema (name as a tiebreaker). */
function schemaKind(schema, id) {
  const props = schema.properties || {};
  if (props.level_data) return 'labyrinth';
  if (props.coupling_map || props.num_qubits || props.operations) return 'graph';
  return /graph/i.test(id) ? 'graph' : 'labyrinth';
}

// ─── Job submission ─────────────────────────────────────────────────────

function buildBody(engine, { rows, cols, couplingMap, mode, name }) {
  const numQubits = rows * cols;
  if (engine.kind === 'graph') {
    // graph-v1: the coupling map is the graph; ZZ targets bias each corridor towards
    // agreement (open) with per-edge variety so some corridors collapse shut.
    return {
      params: {
        num_qubits: numQubits,
        coupling_map: couplingMap,
        operations: couplingMap.map((q) => ({
          type: 'relationship',
          qubits: q,
          paulis: { ZZ: Math.round((Math.random() * 1.3 - 0.3) * 100) / 100 },
        })),
        shots: 1024,
        mode,
      },
    };
  }
  return {
    params: {
      level_data: { name, grid_size: { rows, cols }, num_qubits: numQubits, coupling_map: couplingMap },
      shots: 1024,
      top_n: 16,
      mode,
    },
  };
}

/** Submit one block job. Falls back to the legacy flat body if the params shape is rejected. */
async function submitJob(apiKey, engine, spec) {
  const path = `/engines/${encodeURIComponent(engine.id)}/process`;
  const body = buildBody(engine, spec);
  try {
    return await api(apiKey, path, { method: 'POST', body: JSON.stringify(body) });
  } catch (err) {
    if (err.status !== 400 && err.status !== 422) throw err;
    // The published code samples send level_data/shots/mode at the top level.
    return api(apiKey, path, { method: 'POST', body: JSON.stringify(body.params) });
  }
}

const DONE = new Set(['completed', 'complete', 'succeeded', 'success', 'done', 'finished']);
const FAILED = new Set(['failed', 'error', 'cancelled', 'canceled', 'timed_out', 'terminated']);

async function awaitJob(apiKey, jobId, mode, onTick) {
  const interval = mode === 'qpu' ? 10_000 : 500;
  const timeout = mode === 'qpu' ? 3 * 3600_000 : 90_000;
  const started = Date.now();
  for (;;) {
    const s = await api(apiKey, `/jobs/${jobId}/status`);
    const status = String(s.status || '').toLowerCase();
    onTick?.(status);
    if (DONE.has(status)) break;
    if (FAILED.has(status)) {
      const msg = s.error?.message || s.error?.type || (typeof s.error === 'string' ? s.error : '');
      throw new Error(`job ${shortId(jobId)} ${status}${msg ? `: ${msg}` : ''}`);
    }
    if (Date.now() - started > timeout) throw new Error(`job ${shortId(jobId)} timed out`);
    await sleep(interval);
  }
  const res = await api(apiKey, `/jobs/${jobId}/result`);
  return res.result ?? res;
}

export const shortId = (id) => String(id || '').slice(0, 8);

// ─── Result → corridor samples ──────────────────────────────────────────

const edgeKey = (a, b) => (a < b ? `${a}-${b}` : `${b}-${a}`);

/** Depth-limited search for the first value satisfying `test`. */
function findDeep(obj, test, depth = 6) {
  if (!obj || typeof obj !== 'object' || depth < 0) return undefined;
  if (test(obj)) return obj;
  for (const v of Array.isArray(obj) ? obj : Object.values(obj)) {
    const hit = findDeep(v, test, depth - 1);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/**
 * Turn an engine result into a list of samples, each a Set of OPEN corridor keys
 * (local room indices). Supports measurement bitstrings (labyrinth-v1 / graph-v1),
 * { nodes, edges } graphs, and adjacency matrices.
 */
export function extractSamples(result, couplingMap, numRooms) {
  const fromBits = (bits) => {
    const b = String(bits).replace(/[^01]/g, '');
    if (b.length < numRooms) throw new Error(`bitstring has ${b.length} bits, expected ${numRooms}`);
    return new Set(couplingMap.filter(([a, c]) => b[a] === b[c]).map(([a, c]) => edgeKey(a, c)));
  };

  // 1) Ranked measurements: [{ bitstring, count, probability }, …]
  const measurements = findDeep(result, (o) =>
    Array.isArray(o) && o.length > 0 && typeof o[0] === 'object' && o[0] !== null && 'bitstring' in o[0]);
  if (measurements) return measurements.map((m) => fromBits(m.bitstring));

  // 2) Single dominant outcome.
  const dom = findDeep(result, (o) => !Array.isArray(o) && typeof o.dominant_bitstring === 'string');
  if (dom) return [fromBits(dom.dominant_bitstring)];

  // 3) Graph { nodes, edges } — edges are the open corridors.
  const graph = findDeep(result, (o) => !Array.isArray(o) && Array.isArray(o.edges));
  if (graph) {
    return [new Set(graph.edges.map((e) => {
      const [a, b] = Array.isArray(e) ? e : [e.source ?? e.from ?? e.a, e.target ?? e.to ?? e.b];
      return edgeKey(Number(a), Number(b));
    }))];
  }

  // 4) Adjacency matrix (numRooms × numRooms, truthy = open).
  const matrix = findDeep(result, (o) =>
    Array.isArray(o) && o.length === numRooms && Array.isArray(o[0]) && o[0].length === numRooms);
  if (matrix) {
    return [new Set(couplingMap.filter(([a, b]) => Number(matrix[a][b]) > 0).map(([a, b]) => edgeKey(a, b)))];
  }

  const keys = result && typeof result === 'object' ? Object.keys(result).join(', ') : typeof result;
  throw new Error(`unrecognized result format (keys: ${keys})`);
}

// ─── Room graph ↔ tile grid ─────────────────────────────────────────────

/** Candidate corridors for the left-half room lattice, from a classical braided maze. */
function candidateEdges(rng = Math.random) {
  const tiles = generateLocalMaze({ rng });
  const edges = []; // [[cx, cy], [cx2, cy2]]
  for (let cy = 0; cy < ROOMS_Y; cy++) {
    for (let cx = 0; cx < HALF_X; cx++) {
      const x = 2 * cx + 1;
      const y = 2 * cy + 1;
      // Right neighbour (within the half; the center column mirrors itself).
      if (cx + 1 < HALF_X && (tiles[y][x + 1] === PATH || rng() < 0.3)) edges.push([[cx, cy], [cx + 1, cy]]);
      if (cy + 1 < ROOMS_Y && (tiles[y + 1][x] === PATH || rng() < 0.3)) edges.push([[cx, cy], [cx, cy + 1]]);
    }
  }
  return edges;
}

/** Tile grid from the set of open half-lattice corridors, mirrored and finalized. */
export function gridFromRooms(openEdges) {
  const grid = Array.from({ length: ROWS }, () => new Array(COLS).fill(WALL));
  const mirror = (x, y) => { grid[y][x] = PATH; grid[y][COLS - 1 - x] = PATH; };
  for (let cy = 0; cy < ROOMS_Y; cy++) for (let cx = 0; cx < HALF_X; cx++) mirror(2 * cx + 1, 2 * cy + 1);
  for (const [[ax, ay], [bx, by]] of openEdges) mirror(ax + bx + 1, ay + by + 1);
  return finalizeTopology(grid);
}

/** Split the half lattice into ≤20-qubit blocks with local room numbering. */
function planBlocks(edges) {
  const blocks = [];
  for (let r0 = 0; r0 < ROOMS_Y; r0 += BLOCK_ROWS) {
    const rows = Math.min(BLOCK_ROWS, ROOMS_Y - r0);
    const local = ([cx, cy]) => (cy - r0) * HALF_X + cx;
    const inside = ([, cy]) => cy >= r0 && cy < r0 + rows;
    const own = edges.filter(([a, b]) => inside(a) && inside(b));
    blocks.push({ r0, rows, cols: HALF_X, edges: own, couplingMap: own.map(([a, b]) => [local(a), local(b)]) });
  }
  // Corridors that cross block boundaries stay classical (always open if candidates).
  const crossing = edges.filter(([a, b]) => Math.floor(a[1] / BLOCK_ROWS) !== Math.floor(b[1] / BLOCK_ROWS));
  return { blocks, crossing };
}

// ─── Classical generator ────────────────────────────────────────────────

/**
 * Mirror-symmetric recursive-backtracker maze of exactly rows×cols tiles
 * (both odd). The left half is carved, then reflected across the center
 * column. With `braid`, dead ends are opened into loops (Pac-Man style).
 */
export function generateLocalMaze({ cols = COLS, rows = ROWS, rng = Math.random, loopRate = 0.1, braid = true } = {}) {
  const grid = Array.from({ length: rows }, () => new Array(cols).fill(WALL));
  const cellsY = (rows - 1) / 2;
  const halfX = Math.ceil((cols - 1) / 4);
  const mirror = (x, y, v) => { grid[y][x] = v; grid[y][cols - 1 - x] = v; };

  const visited = Array.from({ length: cellsY }, () => new Array(halfX).fill(false));
  const stack = [[0, 0]];
  visited[0][0] = true;
  mirror(1, 1, PATH);

  while (stack.length) {
    const [cx, cy] = stack[stack.length - 1];
    const options = NEIGHBORS
      .map(([dx, dy]) => [cx + dx, cy + dy, dx, dy])
      .filter(([nx, ny]) => nx >= 0 && ny >= 0 && nx < halfX && ny < cellsY && !visited[ny][nx]);
    if (!options.length) { stack.pop(); continue; }
    const [nx, ny, dx, dy] = options[Math.floor(rng() * options.length)];
    visited[ny][nx] = true;
    mirror(2 * cx + 1 + dx, 2 * cy + 1 + dy, PATH);
    mirror(2 * nx + 1, 2 * ny + 1, PATH);
    stack.push([nx, ny]);
  }

  const loops = Math.floor(halfX * cellsY * loopRate);
  for (let i = 0; i < loops; i++) {
    const x = 1 + Math.floor(rng() * ((cols - 1) / 2));
    const y = 1 + Math.floor(rng() * (rows - 2));
    if ((x % 2) !== (y % 2)) mirror(x, y, PATH);
  }

  if (braid) {
    for (let y = 1; y < rows - 1; y += 2) {
      for (let x = 1; x < cols - 1; x += 2) {
        const open = NEIGHBORS.filter(([dx, dy]) => grid[y + dy][x + dx] === PATH);
        if (open.length !== 1) continue;
        const walls = NEIGHBORS.filter(([dx, dy]) =>
          x + 2 * dx > 0 && x + 2 * dx < cols - 1 && y + 2 * dy > 0 && y + 2 * dy < rows - 1
          && grid[y + dy][x + dx] === WALL);
        if (!walls.length) continue;
        const [dx, dy] = walls[Math.floor(rng() * walls.length)];
        mirror(x + dx, y + dy, PATH);
      }
    }
  }
  return grid;
}

// ─── Topology sanity: zones, de-clutter, reachability ───────────────────
//
// Every topology — quantum or classical — goes through the same pipeline so the board
// always reads as clean Pac-Man corridors:
//   1. stamp the static zones (border, warp tunnels, ghost house + ring road, spawn)
//   2. braid: open dead ends into loops
//   3. flood-fill from Pac-Man's spawn; carve the nearest separating wall into every
//      unreachable pocket until 100% of floor tiles are reachable
//   4. width cap: no 3×3 open rooms — corridors stay 1–2 tiles wide
//   5. de-clutter: floating 1×1 wall blocks are joined to a neighbouring wall
// Any wall a pass adds is kept only if full reachability still holds, so the passes
// can never disconnect the maze. Edits are mirrored to keep the board symmetric.

const mirrorX = (x) => COLS - 1 - x;

function setMirrored(grid, x, y, v) {
  grid[y][x] = v;
  grid[y][mirrorX(x)] = v;
}

/** Static structural zones the quantum layer may not touch. */
export function isProtected(x, y) {
  if (x <= 0 || y <= 0 || x >= COLS - 1 || y >= ROWS - 1) return true; // outer border
  const t = LAYOUT.tunnelRow;
  if (y >= t - 1 && y <= t + 1 && (x <= 2 || x >= COLS - 3)) return true; // tunnel sleeve
  if ((y === t - 2 || y === t + 2) && (x === 1 || x === COLS - 2)) return true; // sleeve end caps
  if (y === t && (x === 3 || x === COLS - 4)) return true; // tunnel mouths
  const { x0, x1, y0, y1 } = LAYOUT.pen;
  if (x >= x0 - 2 && x <= x1 + 2 && y >= y0 - 2 && y <= y1 + 2) return true; // house + ring road
  const s = LAYOUT.pacSpawn;
  return x === s.x && y === s.y;
}

function stampZones(grid) {
  const { x0, x1, y0, y1 } = LAYOUT.pen;
  // Ring road around the pen, then the pen walls, interior, and door.
  for (let y = y0 - 2; y <= y1 + 2; y++) for (let x = x0 - 2; x <= x1 + 2; x++) grid[y][x] = PATH;
  for (let y = y0 - 1; y <= y1 + 1; y++) for (let x = x0 - 1; x <= x1 + 1; x++) {
    grid[y][x] = isLocked(x, y) ? WALL : PATH;
  }
  // Solid border.
  for (let x = 0; x < COLS; x++) grid[0][x] = grid[ROWS - 1][x] = WALL;
  for (let y = 0; y < ROWS; y++) grid[y][0] = grid[y][COLS - 1] = WALL;
  // Warp tunnels: a clean 1-wide sleeve from each edge into the maze.
  const t = LAYOUT.tunnelRow;
  for (let x = 0; x <= 2; x++) {
    setMirrored(grid, x, t - 1, WALL);
    setMirrored(grid, x, t + 1, WALL);
    setMirrored(grid, x, t, PATH);
  }
  setMirrored(grid, 3, t, PATH);
  // Cap the corridors that used to run into the sleeve's walled-off rooms.
  setMirrored(grid, 1, t - 2, WALL);
  setMirrored(grid, 1, t + 2, WALL);
  // Spawn cell and power-pellet corners are always open.
  grid[LAYOUT.pacSpawn.y][LAYOUT.pacSpawn.x] = PATH;
  for (const [x, y] of [[1, 1], [COLS - 2, 1], [1, ROWS - 2], [COLS - 2, ROWS - 2]]) grid[y][x] = PATH;
}

/** Flood fill over floor tiles (tunnels wrap). Returns a Uint8Array reach mask. */
function flood(grid, from) {
  const W = grid[0].length;
  const H = grid.length;
  const seen = new Uint8Array(W * H);
  if (grid[from.y]?.[from.x] !== PATH) return seen;
  const queue = [from.y * W + from.x];
  seen[queue[0]] = 1;
  for (let i = 0; i < queue.length; i++) {
    const k = queue[i];
    const kx = k % W;
    const ky = (k - kx) / W;
    for (const [dx, dy] of NEIGHBORS) {
      const nx = (kx + dx + W) % W;
      const ny = ky + dy;
      const n = ny * W + nx;
      if (grid[ny]?.[nx] === PATH && !seen[n]) { seen[n] = 1; queue.push(n); }
    }
  }
  return seen;
}

function fullyReachable(grid, anchor = LAYOUT.pacSpawn) {
  const seen = flood(grid, anchor);
  const W = grid[0].length;
  for (let y = 0; y < grid.length; y++) {
    for (let x = 0; x < W; x++) if (grid[y][x] === PATH && !seen[y * W + x]) return false;
  }
  return true;
}

/** Add walls (mirrored) only if every floor tile stays reachable; otherwise revert. */
function tryWalls(grid, tiles) {
  const saved = tiles.flatMap(({ x, y }) => [[x, y, grid[y][x]], [mirrorX(x), y, grid[y][mirrorX(x)]]]);
  for (const { x, y } of tiles) setMirrored(grid, x, y, WALL);
  if (fullyReachable(grid)) return true;
  for (const [x, y, v] of saved) grid[y][x] = v;
  return false;
}

const openCount = (grid, x, y) => NEIGHBORS.filter(([dx, dy]) => grid[y + dy]?.[x + dx] === PATH).length;

/** Open every dead-end room into a loop, preferring the least-connected neighbour room. */
function braidDeadEnds(grid) {
  let changed = 0;
  for (let y = 1; y < ROWS - 1; y += 2) {
    for (let x = 1; x <= COLS >> 1; x += 2) {
      if (grid[y][x] !== PATH || isProtected(x, y) || openCount(grid, x, y) !== 1) continue;
      if (braidRoom(grid, x, y)) changed++;
    }
  }
  return changed;
}

/**
 * Open one more connector out of room (x, y) toward an existing, unprotected room.
 * Prefers openings that don't create clutter; with `strict`, only clean openings
 * are allowed. `exclude` is a connector tile that must not be reopened.
 */
function braidRoom(grid, x, y, { strict = false, exclude = null } = {}) {
  const options = NEIGHBORS
    .filter(([dx, dy]) => grid[y + dy]?.[x + dx] === WALL && !isProtected(x + dx, y + dy)
      && !(exclude && exclude.x === x + dx && exclude.y === y + dy)
      && grid[y + 2 * dy]?.[x + 2 * dx] === PATH && !isProtected(x + 2 * dx, y + 2 * dy))
    .map(([dx, dy]) => ({ dx, dy, cost: openingCost(grid, x + dx, y + dy), deg: openCount(grid, x + 2 * dx, y + 2 * dy) }))
    .filter((o) => !strict || o.cost === 0)
    .sort((a, b) => a.cost - b.cost || a.deg - b.deg);
  if (!options.length) return false;
  const { dx, dy } = options[0];
  setMirrored(grid, x + dx, y + dy, PATH);
  return true;
}

/** How much clutter opening (x, y) would cause: new floating pillars + open 3×3 rooms. */
function openingCost(grid, x, y) {
  grid[y][x] = PATH;
  let cost = touchesOpenRoom(grid, x, y) ? 2 : 0;
  for (const [dx, dy] of NEIGHBORS) {
    const wx = x + dx;
    const wy = y + dy;
    if (grid[wy]?.[wx] === WALL && !isProtected(wx, wy) && openCount(grid, wx, wy) === 4) cost++;
  }
  grid[y][x] = WALL;
  return cost;
}

/** Stub corridors (a connector tile open on one side only) lead nowhere — wall them. */
function pruneStubs(grid) {
  let changed = 0;
  for (let y = 1; y < ROWS - 1; y++) {
    for (let x = 1; x <= COLS >> 1; x++) {
      if ((x % 2) === (y % 2) || grid[y][x] !== PATH || isProtected(x, y) || openCount(grid, x, y) !== 1) continue;
      if (tryWalls(grid, [{ x, y }])) changed++;
    }
  }
  return changed;
}

function isOpen3x3(grid, cx, cy) {
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    if (grid[cy + dy]?.[cx + dx] !== PATH) return false;
  }
  return true;
}

/** Break up open rooms: any fully open 3×3 window gets a wall at its center. */
function capCorridorWidth(grid) {
  let changed = 0;
  for (let y = 1; y < ROWS - 1; y++) {
    for (let x = 1; x <= COLS >> 1; x++) {
      if (isProtected(x, y) || !isOpen3x3(grid, x, y)) continue;
      if (tryWalls(grid, [{ x, y }])) changed++;
    }
  }
  return changed;
}

function touchesOpenRoom(grid, cx, cy) {
  for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
    if (isOpen3x3(grid, cx + ox, cy + oy)) return true;
  }
  return false;
}

/** Floating 1×1 wall blocks get joined to a neighbouring wall (else dissolved into floor). */
function joinFloatingWalls(grid) {
  let changed = 0;
  for (let y = 1; y < ROWS - 1; y++) {
    for (let x = 1; x <= COLS >> 1; x++) {
      if (grid[y][x] !== WALL || isProtected(x, y) || openCount(grid, x, y) !== 4) continue;
      // Extend toward a side whose far tile is already wall (a real join) when possible,
      // and never leave a room on either side of the join as a dead end.
      const options = NEIGHBORS
        .map(([dx, dy]) => ({ x: x + dx, y: y + dy, dx, dy, far: grid[y + 2 * dy]?.[x + 2 * dx] === WALL }))
        .filter((t) => !isProtected(t.x, t.y))
        .sort((a, b) => b.far - a.far);
      const joined = options.some((t) => {
        const snapshot = grid.map((row) => row.slice());
        if (!tryWalls(grid, [t])) return false;
        // Rooms flanking the new wall segment that became dead ends get a clean new opening.
        const flank = [[t.x + t.dy, t.y + t.dx], [t.x - t.dy, t.y - t.dx]];
        const ok = flank.every(([fx, fy]) => grid[fy]?.[fx] !== PATH || openCount(grid, fx, fy) >= 2
          || braidRoom(grid, fx, fy, { strict: true, exclude: t }));
        if (ok) return true;
        for (let yy = 0; yy < ROWS; yy++) grid[yy] = snapshot[yy];
        return false;
      });
      if (joined) { changed++; continue; }
      // Couldn't join safely — dissolve it unless that would open a 3×3 room.
      setMirrored(grid, x, y, PATH);
      if (touchesOpenRoom(grid, x, y)) setMirrored(grid, x, y, WALL);
      else changed++;
    }
  }
  return changed;
}

/** Stamp the static zones and run the full sanity pipeline. Mutates and returns grid. */
export function finalizeTopology(grid) {
  stampZones(grid);
  for (let round = 0; round < 4; round++) {
    const changed = pruneStubs(grid) + braidDeadEnds(grid) + connectAll(grid, LAYOUT.pacSpawn, { mirror: true })
      + capCorridorWidth(grid) + joinFloatingWalls(grid);
    if (!changed) break;
  }
  connectAll(grid, LAYOUT.pacSpawn, { mirror: true });
  return grid;
}

/**
 * Flood-fill reachability guarantee: every floor tile not reachable from `anchor`
 * gets connected by carving the shortest run of walls to the reachable region
 * (never through protected walls). Repeats until 100% reachable.
 * Returns the number of pockets joined. Mutates grid.
 */
export function connectAll(grid, anchor = LAYOUT.pacSpawn, { mirror = false } = {}) {
  const rows = grid.length;
  const cols = grid[0].length;
  let joined = 0;
  for (let guard = 0; guard < 64; guard++) {
    const reach = flood(grid, anchor);
    let pocket = -1;
    for (let k = 0; k < reach.length && pocket < 0; k++) {
      if (!reach[k] && grid[Math.floor(k / cols)][k % cols] === PATH) pocket = k;
    }
    if (pocket < 0) return joined;

    // The whole pocket (its own flood), then BFS outward through walls to the reachable region.
    const pocketMask = flood(grid, { x: pocket % cols, y: Math.floor(pocket / cols) });
    const prev = new Map();
    const queue = [];
    for (let k = 0; k < pocketMask.length; k++) if (pocketMask[k]) { prev.set(k, -1); queue.push(k); }
    let hit = -1;
    for (let i = 0; i < queue.length && hit < 0; i++) {
      const k = queue[i];
      const kx = k % cols;
      const ky = (k - kx) / cols;
      for (const [dx, dy] of NEIGHBORS) {
        const nx = kx + dx;
        const ny = ky + dy;
        if (nx < 1 || ny < 1 || nx >= cols - 1 || ny >= rows - 1 || isLocked(nx, ny)) continue;
        const n = ny * cols + nx;
        if (prev.has(n)) continue;
        prev.set(n, k);
        if (reach[n]) { hit = n; break; }
        queue.push(n);
      }
    }
    if (hit < 0) {
      // Pocket can't be reached without breaching a protected wall — fill it in.
      for (let k = 0; k < pocketMask.length; k++) if (pocketMask[k]) grid[Math.floor(k / cols)][k % cols] = WALL;
      joined++;
      continue;
    }
    for (let k = prev.get(hit); k !== undefined && k !== -1; k = prev.get(k)) {
      const x = k % cols;
      const y = Math.floor(k / cols);
      if (mirror) setMirrored(grid, x, y, PATH);
      else grid[y][x] = PATH;
    }
    joined++;
  }
  return joined;
}

/** Diagnostics for tests: counts of every defect the pipeline is meant to remove. */
export function auditTopology(grid, anchor = LAYOUT.pacSpawn) {
  const reach = flood(grid, anchor);
  const stats = { unreachable: 0, floatingWalls: 0, openRooms3x3: 0, deadEnds: 0, asymmetric: 0 };
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      if (grid[y][x] !== grid[y][mirrorX(x)]) stats.asymmetric++;
      if (grid[y][x] === PATH) {
        if (!reach[y * COLS + x]) stats.unreachable++;
        if (!isProtected(x, y) && openCount(grid, x, y) === 1) stats.deadEnds++;
      } else if (!isProtected(x, y) && openCount(grid, x, y) === 4) stats.floatingWalls++;
      if (!isProtected(x, y) && isOpen3x3(grid, x, y)) stats.openRooms3x3++;
    }
  }
  return stats;
}

// ─── Pre-fetch pipeline ─────────────────────────────────────────────────

const LOW_WATER = 4; // dispatch a new batch when fewer layouts than this are cached
const MAX_BUFFER = 24;
const RETRY_COOLDOWN_MS = 15_000;

/**
 * Keeps quantum layouts cached in memory so a collapse never waits on the network.
 * `take()` is synchronous: it returns a cached quantum layout, or — only if the
 * cache is empty — a classical one tagged with the reason. Every take re-arms the
 * background pipeline so the next layouts are already in flight.
 */
export class TopologyQueue {
  constructor({ getApiKey, getMode = () => 'emu', onStatus = () => {}, onEngine = () => {} }) {
    this.getApiKey = getApiKey;
    this.getMode = getMode;
    this.onStatus = onStatus;
    this.onEngine = onEngine;
    this.buffer = [];
    this.inflight = null;
    this.engine = null;
    this.engineError = null;
    this.cooldownUntil = 0;
    this.lastError = null;
    this.generation = 0; // bumps on key/engine reset so stale batches are dropped
  }

  /** (Re)discover the engine for the current key, then start filling the cache. */
  async connect() {
    const gen = ++this.generation;
    this.buffer = [];
    this.engine = null;
    this.engineError = null;
    this.lastError = null;
    this.cooldownUntil = 0;
    const apiKey = this.getApiKey();
    if (!apiKey) {
      this.engineError = 'no API key';
      this.onEngine(null, this.engineError);
      this.onStatus('No API key — classical layouts');
      return;
    }
    this.onStatus('Discovering Moth engines…');
    try {
      const engine = await discoverEngine(apiKey);
      if (gen !== this.generation) return;
      this.engine = engine;
      this.onEngine(engine, null);
      this.onStatus(`Engine ${engine.id} ready (${engine.kind} adapter)`);
      this.refill();
    } catch (err) {
      if (gen !== this.generation) return;
      console.warn('[moth] engine discovery failed:', err);
      this.engineError = `engine discovery failed: ${err.message}`;
      this.onEngine(null, this.engineError);
      this.onStatus(this.engineError);
    }
  }

  get fallbackReason() {
    if (this.engineError) return this.engineError;
    if (!this.engine) return 'engine discovery in progress';
    if (this.lastError) return this.lastError;
    if (this.inflight) return 'first quantum batch still in flight';
    return 'quantum cache empty';
  }

  local(reason = this.fallbackReason) {
    const grid = finalizeTopology(generateLocalMaze());
    return { grid, source: 'classical', engine: this.engine?.id || null, reason, jobIds: [] };
  }

  /** Instant: a cached quantum layout if one exists, else classical. Always re-arms the pipeline. */
  take() {
    const topo = this.buffer.shift() || this.local();
    this.refill();
    return topo;
  }

  refill() {
    if (this.inflight || this.buffer.length >= LOW_WATER) return;
    if (!this.engine || !this.getApiKey() || Date.now() < this.cooldownUntil) return;
    const gen = this.generation;
    this.inflight = this.#runBatch(gen)
      .then((layouts) => {
        if (gen !== this.generation) return;
        this.lastError = null;
        this.buffer.push(...layouts);
        this.buffer.splice(MAX_BUFFER);
        this.onStatus(`Cached ${this.buffer.length} quantum layouts (${this.engine.id})`);
      })
      .catch((err) => {
        if (gen !== this.generation) return;
        console.warn('[moth] quantum batch failed:', err);
        this.lastError = err.message;
        this.cooldownUntil = Date.now() + RETRY_COOLDOWN_MS;
        this.onStatus(`Quantum batch failed: ${err.message} — retrying in ${RETRY_COOLDOWN_MS / 1000}s`);
      })
      .finally(() => {
        if (gen !== this.generation) return;
        this.inflight = null;
        if (!this.lastError) this.refill();
      });
  }

  async #runBatch(gen) {
    const apiKey = this.getApiKey();
    const mode = this.getMode();
    const engine = this.engine;
    const { blocks, crossing } = planBlocks(candidateEdges());
    const t0 = performance.now();

    // One job per ≤20-qubit block, all in parallel.
    const done = new Array(blocks.length).fill(false);
    const results = await Promise.all(blocks.map(async (bl, i) => {
      if (bl.rows * bl.cols > MAX_QUBITS) throw new Error(`block ${i} exceeds ${MAX_QUBITS} qubits`);
      const sub = await submitJob(apiKey, engine, {
        rows: bl.rows, cols: bl.cols, couplingMap: bl.couplingMap, mode, name: `qpm-block-${i}`,
      });
      const jobId = sub.job_id;
      if (!jobId) throw new Error('submit response had no job_id');
      const report = (status) => {
        if (gen === this.generation) {
          this.onStatus(`Batch: ${done.filter(Boolean).length}/${blocks.length} jobs done · #${shortId(jobId)} ${status}`);
        }
      };
      report(sub.status || 'queued');
      const result = await awaitJob(apiKey, jobId, mode, report);
      done[i] = true;
      const samples = extractSamples(result, bl.couplingMap, bl.rows * bl.cols);
      if (!samples.length) throw new Error(`job #${shortId(jobId)} returned no samples`);
      return { jobId, samples };
    }));

    // Combine the i-th sample of each block into one layout (others shuffled for variety).
    const n = Math.max(...results.map((r) => r.samples.length));
    const layouts = [];
    for (let i = 0; i < n; i++) {
      const open = [...crossing];
      blocks.forEach((bl, b) => {
        const s = results[b].samples;
        const set = b === 0 ? s[i % s.length] : s[Math.floor(Math.random() * s.length)];
        const local = ([cx, cy]) => (cy - bl.r0) * HALF_X + cx;
        for (const e of bl.edges) if (set.has(edgeKey(local(e[0]), local(e[1])))) open.push(e);
      });
      layouts.push({
        grid: gridFromRooms(open),
        source: 'quantum',
        mode,
        engine: engine.id,
        jobIds: results.map((r) => r.jobId),
        reason: null,
      });
    }
    console.info(`[moth] batch: ${blocks.length} jobs → ${layouts.length} layouts in ${Math.round(performance.now() - t0)}ms`);
    return layouts;
  }
}
