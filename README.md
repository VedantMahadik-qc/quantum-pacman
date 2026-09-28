# 🕹️ Quantum Pac-Man: The Dynamic Labyrinth

[![Live Demo](https://img.shields.io/badge/Live_Demo-quantum--pacman--alpha.vercel.app-ffe000?style=for-the-badge&logo=vercel&logoColor=black)](https://quantum-pacman-alpha.vercel.app)
[![Built with Vite](https://img.shields.io/badge/Built_with-Vite-646CFF?style=for-the-badge&logo=vite&logoColor=white)](https://vite.dev)
[![Moth Atlas](https://img.shields.io/badge/Engine-Moth_Atlas_labyrinth--v1-2ef2ff?style=for-the-badge)](https://api.mothquantum.com/docs)

Classic Pac-Man, except the maze won't hold still. Every **6 seconds** the labyrinth's superposition collapses into a new corridor layout sampled from a quantum circuit on the [Moth Atlas](https://api.mothquantum.com/docs) `labyrinth-v1` engine. The pellets you haven't eaten stay put if a corridor still runs through them. The ghosts re-plan their routes straight away.

### ▶ [Play it now — quantum-pacman-alpha.vercel.app](https://quantum-pacman-alpha.vercel.app)

No account or API key needed. Without a key the game plays on classical mazes, and adding a Moth key switches it to quantum ones.

---

## ⚛️ How the quantum maze works

### 1. Lattice qubit mapping (≤ 20 qubits per sub-graph)

The board is a **19 × 25** tile grid built from a **9 × 12 lattice of rooms**. Each room is a node and each possible corridor between neighbouring rooms is an edge. **One qubit represents one room.**

The Moth emulator handles at most **20 qubits** per job, so the lattice is split into modular sub-graphs:

```
 left half = 5 × 12 rooms = 60 qubits
 ┌───────────┐
 │ block 0   │  5 × 4 rooms = 20 qubits  → job A
 ├───────────┤
 │ block 1   │  5 × 4 rooms = 20 qubits  → job B      (all three run in parallel)
 ├───────────┤
 │ block 2   │  5 × 4 rooms = 20 qubits  → job C
 └───────────┘
 right half = mirror image (classic symmetric Pac-Man board)
```

Each block is sent as a `level_data` payload: `grid_size`, `num_qubits`, and a `coupling_map` listing the candidate corridors. The engine prepares a ZZ-correlated state across those couplings, samples it, and returns the most probable measurement bitstrings, with qubit 0 as the leftmost character. Corridors that cross from one block into the next are left as classical links.

### 2. Parity-driven corridors

Each candidate corridor links two rooms, *a* and *b*. After measurement, the corridor's fate depends on the parity of those two qubits:

| Measured bits (a, b) | Parity | Result |
|:---:|:---:|:---|
| `00` or `11` | even (the bits agree) | 🟦 **Open hallway**: the corridor survives |
| `01` or `10` | odd (the bits disagree) | 🧱 **Wall**: the corridor collapses shut |

The engine's ZZ preparation makes coupled rooms tend to agree, so most corridors survive. A random, entanglement-shaped fraction collapses on each sample, and every measured bitstring gives a different maze.

### 3. Zero-latency asynchronous pre-fetching

Network round-trips would stall a 6-second loop, so the game never waits on the API:

- One **batch** is 3 parallel jobs, one per block. Each job returns up to `top_n = 16` measured bitstrings, and combining sample *i* from every block gives up to **16 complete topologies per batch**, about 96 seconds of play.
- These are cached in memory. When fewer than **4** remain, the next batch is sent in the background straight away.
- At each collapse the game pulls the next cached grid with a synchronous call, **measured at ≈ 0.25 ms**. No `await` sits on the gameplay path.
- If the cache is ever empty or the API fails, the game swaps in a local maze and shows the reason on screen. After a failure it waits 15 seconds before retrying.

### 4. Topological safety

Raw quantum samples can be messy, so every topology, quantum or classical, goes through a sanity pipeline before it's shown:

- **Protected zones.** The outer border, the left and right **warp tunnels**, and the central **ghost house** with its surrounding road are stamped in fixed form every time. The quantum layer only shapes the corridors between them.
- **Anti-trap zone.** At each collapse the full **3 × 3 block around Pac-Man** is forced open, along with the tile he's moving into, so a wall can never land on him or seal his exits. Tiles under ghosts become floor as well.
- **BFS flood-fill reachability guarantee.** A breadth-first flood fill runs from Pac-Man's position. Any unreachable pocket gets its nearest separating wall carved open, repeating until **100% of floor tiles are reachable**. Carving never cuts through the protected walls.
- **Corridor polish.** Dead ends are opened into loops, 3 × 3 open rooms are split so corridors stay 1–2 tiles wide, and floating 1 × 1 wall blocks are joined to a neighbouring wall.
- **Safe edits only.** A wall added by any pass is kept only if full reachability still holds afterwards, so no pass can disconnect the maze. Edits are mirrored to keep the board symmetric.

In testing across 2,500 generated mazes, including samples where 95% of corridors collapsed, the pipeline left **zero** unreachable tiles, floating walls, open rooms or dead ends, at about 0.2 ms per maze.

---

## 🎮 Controls

### Desktop

| Key | Action |
|:---|:---|
| `W` `A` `S` `D` / `↑` `←` `↓` `→` | Move. A turn pressed early is taken at the next opening. |
| `Space` | Force an instant quantum collapse (or start the game) |
| `Esc` / `P` | Pause / resume |
| `Enter` | Start / play again |

### Mobile & touch

| Gesture | Action |
|:---|:---|
| Swipe ↑ ↓ ← → | Steer Pac-Man. You can chain turns without lifting your finger. |
| Tap | Start the game, or resume when paused |
| Double-tap | Force a quantum collapse |
| ⚡ button (corner of the screen) | Force a quantum collapse |
| ⏸ button (top bar) | Pause / resume |

Swipes on the game screen don't scroll the page, zoom, or trigger pull-to-refresh.

---

## ✨ Features

- **A new maze every 6 seconds.** The collapse plays a screen-shake and glitch effect, and pellets are kept wherever a corridor still runs through them.
- **Classic Pac-Man rules.** Pellets are worth +10, the four corner power pellets +50, and eating a frightened ghost +200. There are 3 lives and wrap-around tunnels.
- **Three ghosts with different behaviour, using BFS pathfinding:**
  - **Blinky** chases you directly.
  - **Pinky** aims four tiles ahead of you.
  - **Inky** flanks, using Blinky's position.
  - All three re-plan their routes the moment the maze changes.
- **Arcade cabinet look.** Neon-blue walls, glowing pellets, CRT scanlines and a *Press Start 2P* pixel font. Desktop uses a landscape cabinet with side panels, and phones get a compact stacked layout.
- **Sharp at any size.** The maze is drawn at a whole number of screen pixels per tile, adjusted for high-density displays.
- **Start screen and pause.** Pausing freezes the collapse timer, the movement and all animations. The game also pauses itself when you switch tabs.
- **Works without an API key.** The game uses a local generator (a mirror-symmetric maze with dead ends removed) and runs through the same safety pipeline, so it's fully playable with no key or no network.
- **Clear status reporting.** A badge always shows the engine, whether mazes are coming from the emulator or real hardware (EMU / QPU), the current job ID, or the exact reason the game fell back to local mazes.

---

## 🚀 Local development

Requires **Node.js 20.19+** (or 22.12+), as needed by Vite 7.

```bash
git clone https://github.com/VedantMahadik-qc/quantum-pacman.git
cd quantum-pacman
npm install
npm run dev      # dev server at http://localhost:5173 (with the /moth-api proxy)
npm run build    # production build → dist/
npm run preview  # serve the production build locally (proxy included)
```

### Project structure

```
src/
  mothLabyrinth.js  Moth engine discovery, job pipeline, bitstring → corridor
                    mapping, pre-fetch queue, maze generator, topology sanity pipeline
  game.js           Game states, movement/collision, ghost AI, collapse logic, touch input
  canvas.js         Arcade renderer: walls, sprites, overlays, glitch effect, sharp scaling
  main.js           UI wiring, HUD, engine badge, responsive sizing
  style.css         Cabinet layout (desktop landscape + mobile stacked)
vite.config.js      Dev proxy: /moth-api → https://api.mothquantum.com
vercel.json         Production proxy (same rewrite on Vercel)
```

---

## 🔑 Moth Atlas API configuration

1. Get an API key from [Moth Quantum](https://api.mothquantum.com/docs).
2. Paste it into the **MOTH API KEY** field in the game. It's saved in your browser's `localStorage` and only ever sent as a `Bearer` token to the Moth API through the `/moth-api` proxy.
3. Choose a **quantum backend**:
   - **EMU** (default): Moth's simulator. It handles up to 20 qubits and returns in seconds, which suits the 6-second collapse loop.
   - **QPU**: real IBM quantum hardware. The queue can take minutes to hours, so the game keeps playing on cached or local mazes until results arrive.

When a key is set, the game:

- calls `GET /api/v1/engines` and logs the full list to the browser console as `[MOTH ENGINE LIST]`;
- picks `labyrinth-v1`, or otherwise the first engine whose name contains *labyrinth*, *maze* or *graph*;
- reads that engine's `params_schema` (logged as `[MOTH ENGINE SELECTED]`) and shapes its requests to match. Both `labyrinth-v1` and `graph-v1` payload formats are supported.

### Proxying

The browser calls a same-origin `/moth-api/*` path, which is rewritten to `https://api.mothquantum.com/*`:

| Environment | Where the proxy is configured |
|:---|:---|
| `npm run dev` / `npm run preview` | `vite.config.js` (`server.proxy`) |
| Vercel | `vercel.json` (`rewrites`) |

To host somewhere other than Vercel, add the same rewrite on that platform. Without it, the game still works on classical mazes and the badge shows the HTTP error.

---

## 📄 License

Released under the **MIT License**.
