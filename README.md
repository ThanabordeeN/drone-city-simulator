# Drone City Simulator

A browser-based 3D drone simulator with a **procedural city**, **fixed-timestep flight dynamics**, **keyboard + gamepad control**, and a first-class **automation API** (`window.__DRONE_SIM__`) for AI agents, Playwright and automated regression tests.

The simulation core has **no dependency on Three.js, the DOM, or wall-clock time**. The renderer only ever reads it.

```text
Keyboard ─────┐
Gamepad ──────┼──> InputManager ──> DroneSimulation (source of truth)
Automation ───┘                          │
                                         │
                  ┌──────────────────────┴────────────────────┐
                  │                                           │
             SceneRenderer                              Automation API
```

---

## AI Control Module (Spec: AI Control)

Browser-only module (`src/agent/`) that lets an AI agent drive the drone
through the same public automation API a human uses:

```text
Human command  ->  CommandParser  ->  AgentController  ->  provider
                                                        (JEV Decisions API  /  chat completions  /  local reflex)
                                                        ->  validateAction
                                                        ->  window.__DRONE_SIM__.act()
```

- **Tab UI** — `[ SIMULATOR ] [ AI CONTROL ]`. The Three.js world keeps
  rendering no matter which tab is open; switching back to SIMULATOR stops the
  agent and returns control to keyboard/gamepad.
- **API key** — typed into a `type="password"` field, kept in a single runtime
  variable. Never written to `localStorage` / `sessionStorage` / cookies /
  URLs, and gone after a reload.
- **Decision loop** — `observe()` -> provider -> `validateAction()` -> `act()`
  at 5 Hz while the simulation keeps running at 60 Hz in real time. No
  `pause()`/`step()` is ever used by the agent.
- **JEV Decisions API** — the default model `typesafe/jev-1.13` does not
  generate text. Each cycle the module POSTs the drone state plus typed
  questions to `POST https://openrouter.ai/api/alpha/decisions`:

    pitch / strafe / yaw / vertical -> score (5-point ordered rubric -> [-1, +1])
    brake                           -> noul (brake when yes-probability > 0.7)

  When the model returns the full `probabilities` distribution, the expected
  rubric position is used for smoother control. Generic chat models
  (`openai/gpt-4o-mini`, ...) go through the OpenAI-compatible chat endpoint
  instead and are asked for a single strict-JSON action.
- **Safety** — 2 s action watchdog clears held input, STOP aborts the in-flight
  request, provider failures clear input and fail the session, `goalReached`
  completes the session, and response/session IDs guard against stale
  decisions.
- **Destination commands** ("`บินไปที่ x=400 y=50 z=-250`") are parsed and fed
  to `sim.setGoal()`; the agent then navigates on `goalDirection` /
  `goalDistance` / sensors. Survival and circle commands run without a goal.
- **Local reflex provider** — a built-in offline policy (Model: `local-reflex`)
  that needs no API key, useful for demos and tests.

### Quick start (AI Control)

```bash
npm run dev
```

1. Open the app and click **AI CONTROL**.
2. Provider = OpenRouter, paste **your OpenRouter API key** (memory only).
3. Model: `typesafe/jev-1.13` (Decisions API) — or pick `Local reflex (no API key)` to try it for free.
4. Type a command, e.g. `บินไปที่ x=400 y=50 z=-250 โดยห้ามชนตึก`, press **RUN**.
5. Watch the drone fly in real time; **STOP** at any point (input is cleared
   and manual control resumes).

---

## Live deployments

| Target | URL | Notes |
|---|---|---|
| **GitHub Pages** | https://thanabordeen.github.io/drone-city-simulator/ | Permanent. Redeploys on every push to `main` via `.github/workflows/deploy-pages.yml` (typecheck → unit tests → build → deploy). |
| **cloudflared quick tunnel** | see the terminal | Ephemeral, no uptime guarantee. Tied to the local process; the hostname changes on every run. |

### Re-expose locally with cloudflared

The build uses relative asset paths (`base: './'`), so the same `dist/` works at a
domain root, under a sub-path, and behind a tunnel.

```bash
npm run build

npm run serve     # terminal 1: vite preview on 127.0.0.1:4173
npm run tunnel    # terminal 2: cloudflared -> prints https://<random>.trycloudflare.com
```

`server.allowedHosts` / `preview.allowedHosts` allow `.trycloudflare.com` so the
tunnel's `Host` header is accepted. Add your own domain there if you use a named
tunnel.

### Deploy to GitHub Pages yourself

```bash
gh repo create <name> --public --source=. --remote=origin --push
gh api -X POST repos/<owner>/<name>/pages -f build_type=workflow
```

Push to `main` and the workflow publishes the site. Because the repo is a project
site it is served from `/<name>/`, which the relative asset base handles.

---

## Quick start

```bash
npm install
npm run dev          # http://localhost:5173
```

Production:

```bash
npm run build        # tsc --noEmit && vite build
npm run preview      # http://localhost:4173
```

Tests:

```bash
npm test             # Vitest: 94 headless unit tests (no browser needed)
npm run test:e2e     # Playwright: 25 browser automation tests
npm run typecheck    # tsc --noEmit
```

### เริ่มใช้งานเร็ว (Thai)

```bash
npm install
npm run dev
```

เปิด `http://localhost:5173` แล้วบินด้วย `W A S D` + `Shift` (ขึ้น) + `Control` (ลง) + `Q E` (หัน) + `Space` (เบรก)

---

## Controls

| Key | Action |
|---|---|
| `W` / `S` | Pitch forward / backward (move along Z) |
| `A` / `D` | Roll left / right (move along X) |
| `Shift` | Ascend |
| `Control` | Descend |
| `Q` / `E` | Yaw left / right |
| `Space` | Brake / hover |
| `R` | Reset drone (no page reload) |
| `C` | Cycle camera: chase → FPV → free |
| `P` | Pause / resume simulation |
| `B` | Toggle debug panel |
| `H` | Toggle the controls help panel |

Simultaneous keys are supported: `W + D + Shift` = forward + right + ascend.

### Gamepad

Two profiles, selectable in the HUD/debug panel (`?profile=…`):

**Drone Mode 2** (default, RC-style)

```text
Left stick  X → yaw            Y → ascend / descend
Right stick X → roll           Y → pitch forward / backward
A/Cross → brake    B/Circle → reset    Y/Triangle → camera    Start → pause
```

**Game Controller** (twin-stick)

```text
Left stick  X → strafe         Y → forward / backward
Right stick X → yaw            LT → descend   RT → ascend
```

Deadzone (default `0.08`), per-axis inversion (`invertPitch`, `invertVertical`, `invertYaw`, `invertRoll`) and a fully custom axis map are configurable. Controller connection/disconnection is detected and shown in the HUD.

---

## URL parameters

```text
/?seed=123
/?testMode=1
/?buildings=1000
/?camera=fpv

/?seed=42&testMode=1&buildings=800&camera=chase
```

| Parameter | Meaning |
|---|---|
| `seed` | Deterministic city seed. Same seed → identical layout, every reload. |
| `testMode=1` | Fixed seed (12345), starts **paused**, all decorative animation frozen. |
| `buildings=N` | Building budget, 600–1500 (landmarks are never trimmed). |
| `camera=chase\|fpv\|free` | Initial camera mode. |
| `debug=1` | Open the debug panel on load. |
| `control=automation` | Start with human input disabled. |
| `profile=droneMode2\|gameController\|custom` | Gamepad profile. |

---

## Architecture

```text
src/
├── main.ts                     # bootstrap: URL params, frame loop, wiring
│
├── simulation/                 # pure core — no three.js, no DOM
│   ├── DroneSimulation.ts      # orchestration, observation, episodes, goals
│   ├── DroneState.ts           # state + DroneConfig (the source of truth)
│   ├── DroneController.ts      # dynamics: attitude, thrust, drag, braking
│   ├── CollisionSystem.ts      # drone↔building, drone↔ground, sensors
│   ├── FixedTimestep.ts        # 60 Hz accumulator
│   └── vec3.ts                 # small math helpers
│
├── world/                      # procedural city (deterministic, DOM-free)
│   ├── CityGenerator.ts        # seeded layout: blocks, lots, landmarks
│   ├── BuildingSystem.ts       # building records + 50 m spatial grid
│   ├── RoadSystem.ts           # road grid, intersections, ground texture
│   └── SpawnSystem.ts          # safe spawns + building approach corridors
│
├── input/
│   ├── InputManager.ts         # priority: automation ▸ gamepad ▸ keyboard
│   ├── KeyboardInput.ts        # held-key set (simultaneous keys)
│   ├── GamepadInput.ts         # 2 profiles, deadzone, invert, status
│   └── AutomationInput.ts      # machine channel (works headless)
│
├── rendering/                  # reads state, never writes it
│   ├── SceneRenderer.ts        # instanced city, sky, ground, metrics
│   ├── DroneRenderer.ts        # low-poly quadcopter
│   ├── CameraController.ts     # chase / fpv / free
│   └── HUD.ts                  # flight readout, input viz, debug panel
│
└── automation/
    ├── AutomationAPI.ts        # window.__DRONE_SIM__
    └── SimulationSnapshot.ts   # JSON-safe serialization boundary
```

### Simulation timing

Physics runs at a fixed **60 Hz** (`dt = 1/60 s`), decoupled from the renderer. Whether the page renders at 30, 60, 144 or a variable frame rate, the same input over the same wall-clock duration produces the same trajectory — and the same *number* of fixed ticks (the accumulator is epsilon-tolerant so floating-point drift cannot silently drop a step).

Automation can bypass real time entirely:

```js
sim.pause();
sim.setInput({ vertical: 1 });
sim.step(120);          // exactly 120 fixed ticks, on any machine
sim.clearInput();
sim.getState();
```

### Flight dynamics

Simplified arcade/semi-realistic model — attitude-based thrust with inertia, drag, speed limits, active braking and auto-level. Defaults (all configurable via `sim.setConfig()`):

```js
{
  maxHorizontalSpeed: 20,   maxVerticalSpeed: 10,
  horizontalAcceleration: 14, verticalAcceleration: 10,
  yawSpeed: 1.8,
  drag: 0.92,               verticalDrag: 0.86,
  maxPitch: 0.45,           maxRoll: 0.45,
  autoLevel: true,
  brakeAcceleration: 26,
  radius: 0.8,              crashSpeedThreshold: 8
}
```

Coordinate convention: `Y+` up, `X+` right, `Z-` forward.

### City

- `2000 m × 2000 m`, `20 × 20` blocks, **600–1500 buildings**, heights **10–150 m**.
- 100 % deterministic from the seed (mulberry32 PRNG, no `Math.random`).
- Landmarks for navigation: tall towers, large offices, parking buildings, open plazas and parks, plus a guaranteed central tower.
- Buildings never overlap a road corridor.
- Rendered with **`InstancedMesh` groups** (one per building type + roof details + landmark beacons), so draw calls stay flat (~10–15) whether the city has 600 or 1500 buildings.

### Collision

Sphere (drone, `r = 0.8 m`) vs AABB (buildings) and vs the ground plane, resolved with a minimum-translation vector. Only buildings in the drone's **50 m spatial-grid neighbourhood** are tested — never the whole city.

- `state.collided` latches until `reset()` (Spec §34 treats collision state as reset-scoped).
- `state.grounded` is live contact with the ground.
- Impacts above `crashSpeedThreshold` (8 m/s) set `state.crashed`, which kills thrust.
- A gentle touchdown sets `grounded` but neither `collided` nor `crashed`.

---

## Automation API

Available after initialisation as `window.__DRONE_SIM__`:

```js
await window.__DRONE_SIM__.ready();
```

### Core (§18)

```ts
getState(): DroneState
getInput(): DroneControlInput
setInput(input: Partial<DroneControlInput>): void
clearInput(): void
reset(options?: { seed?, position?, spawn? }): void
pause(): void
resume(): void
step(frames?: number): void
teleport(position): void
setRotation({ pitch?, yaw?, roll? }): void
setCameraMode("chase" | "fpv" | "free"): void
getNearbyBuildings(radius?): BuildingSnapshot[]
getWorldInfo(): WorldInfo
getMetrics(): SimulationMetrics
```

### Sensors, observation, action, episodes, goals (§25–§29)

```ts
getSensors(): { altitude, velocity, heading, frontDistance, backDistance,
                leftDistance, rightDistance, downDistance }

observe(): { tick, position[], velocity[], rotation[], altitude, speed, heading,
             sensors: { front, back, left, right, down },
             collision, crashed, grounded,
             goalDistance, goalDirection, goalReached }

act(action): void                       // normalized action → next step()
startEpisode({ seed?, spawn? }): EpisodeStats
endEpisode(): EpisodeStats              // { ticks, duration, distanceTravelled,
                                        //   collisions, crashed }
setGoal({ x, y, z, radius? }): Goal     // reached when radius < 5 m
getGoal(): Goal | null
isGoalReached(): boolean
```

### Control priority (§32)

```js
sim.setControlMode("automation");  // human input disabled; automation owns the sticks
sim.setControlMode("manual");      // keyboard + gamepad combine, automation overrides per-axis
```

### Examples

Take off:

```js
const sim = window.__DRONE_SIM__;
await sim.ready();

sim.pause();
sim.setInput({ vertical: 1 });
sim.step(120);
sim.clearInput();
sim.getState();          // → altitude ≈ 15.5 m, crashed: false
```

Fly forward (§20):

```js
sim.reset({ seed: 123 });
sim.pause();
sim.setInput({ pitch: 1 });
sim.step(180);
sim.clearInput();
const state = sim.getState();
state.speed > 0 && state.position.z < 0;   // true
```

Agent loop (§27) — works headlessly too:

```js
for (let i = 0; i < 1000; i++) {
  const obs = sim.observe();
  const action = policy(obs);      // your agent
  sim.act(action);
  sim.step(1);
}
```

World query for non-visual navigation (§24):

```js
sim.getNearbyBuildings(50);
// [{ id: "building-122",
//    position: { x: 20, y: 18, z: -42 },
//    size: { x: 12, y: 36, z: 18 },
//    distance: 27.3, ... }]
```

Playwright (§21) — no synthetic keyboard events required:

```ts
const state = await page.evaluate(() => {
  const sim = window.__DRONE_SIM__;
  sim.pause();
  sim.setInput({ vertical: 1 });
  sim.step(120);
  sim.clearInput();
  return sim.getState();
});
expect(state.altitude).toBeGreaterThan(5);
expect(state.crashed).toBe(false);
```

---

## Tests

### Vitest — headless, no browser

```
tests/unit/simulation.test.ts   Spec §37 tests 1–7, fixed timestep, reset
tests/unit/world.test.ts        determinism, layout constraints, spatial grid, spawns
tests/unit/input.test.ts        keyboard map, gamepad profiles, input priority
tests/unit/automation.test.ts   the full §17–§35 API surface
```

These import the simulation core directly. If they pass, the core genuinely runs without a renderer.

### Playwright — browser level

```
tests/e2e/automation.spec.ts    §33 URL params, §21 API flight, determinism,
                                collision, episodes, metrics, HUD, cameras
tests/e2e/keyboard.spec.ts      §22 full KeyboardEvent → Drone movement stack
```

Keyboard tests wait on the **fixed tick counter**, not wall-clock time, so they are stable under a software rasterizer.

### Test environment notes (sandboxed / headless Linux)

Playwright needs a Chromium build and a handful of system libraries. In a restricted environment where `~/.cache` is not writable:

```bash
PLAYWRIGHT_BROWSERS_PATH=./.playwright-browsers npx playwright install chromium
PLAYWRIGHT_BROWSERS_PATH=./.playwright-browsers \
LD_LIBRARY_PATH=$PWD/.playwright-deps/usr/lib/x86_64-linux-gnu \
npx playwright test
```

`scripts/screenshot.mjs` captures chase/FPV/free/debug screenshots plus render metrics for a quick visual smoke check.

---

## Performance

Target: **1920×1080, 600–1500 buildings, ≥ 60 FPS.**

- Buildings are instanced; draw calls do not scale with building count.
- Collision only touches the 3×3 spatial-grid neighbourhood.
- The HUD is plain DOM updated once per frame; no canvas text.
- Shadows are off by default (a 2 km shadow map costs more than it adds).

Live metrics:

```js
sim.getMetrics();
// { fps, frameTimeMs, drawCalls, triangles, buildingCount, tick,
//   simulationHz, fixedDtMs, paused, droneSpeed, altitude, ... }
```

---

## Extending

`observe()` → `act()` → `step()` → `reset()` is the stable interface, so the simulator is ready to grow into an AI/robotics environment: autonomous agents, depth/LiDAR sensors, GPS/IMU, wind, path planning, multi-drone racing, RL environments, a WebSocket bridge (§30) or a Python/ROS SDK. `AutomationAPI` is a thin façade over `DroneSimulation`, so a WebSocket or Python bridge only needs to expose the same calls.
