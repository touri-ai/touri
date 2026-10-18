# Measuring UI memory

The opt-in `desktop-memory` browser benchmark measures a production build at one and five minutes.
Run it through the shared test gate, with one worker. Set `TOURI_TEST_GATE` to the gate executable.
Install dependencies separately in each worktree with `bun install --frozen-lockfile`.

```sh
TOURI_TEST_ONLY=desktop-memory \
TOURI_E2E_WORKERS=1 \
TOURI_DESKTOP_MEMORY_PHASE=before \
"$TOURI_TEST_GATE" e2e
```

Repeat in the changed worktree with `TOURI_DESKTOP_MEMORY_PHASE=after` and
`TOURI_DESKTOP_MEMORY_EXPECT_NO_WASM=1`. For a baseline without the benchmark, copy only
`ui/test/e2e/desktop-memory*` into the baseline worktree. Keep its application source unchanged.
The default generated workload has 30 bots, 60 selected messages, 30 code fences in ten languages,
and a distinct large reply every second in one of 29 background conversations.

The output directory defaults to `node_modules/.cache/desktop-memory`. It contains two heap snapshots,
a JSON report, and a screenshot of the generated transcript. `TOURI_DESKTOP_MEMORY_OUTPUT` overrides
the directory; `TOURI_DESKTOP_MEMORY_MS` overrides the observation period for diagnosis.
`TOURI_DESKTOP_MEMORY_REUSE_BUILD=1` is only for repeating a measurement with the same built source.

For a real server, set `TOURI_DESKTOP_MEMORY_URL` to its URL and `TOURI_DESKTOP_MEMORY_DATA` to its
local data directory. The benchmark pairs through `touri pair`, blocks UI API writes, reads the existing
workspace and revokes its own device afterward. It does not capture a real-workspace screenshot.
`TOURI_DESKTOP_MEMORY_LOCAL_UI=1` serves the worktree's frontend assets to that browser context while
keeping the real server and its bots unchanged. A direct loopback listener can be used when the proxy
is unreachable from the measurement host; record the route used in the evidence.
The browser context grants local-network access to that origin so its WebSocket can connect when
frontend assets are fulfilled locally. This permission belongs only to the benchmark context.

Each sample forces collection before reading JavaScript heap, DOM/listener counts, pending animation
frames, interval timers, active CSS animations, SVG counts, image dimensions and canvas dimensions.
Image/canvas byte counts are dimension estimates. They do not measure graphics-process memory.
Heap-snapshot summaries also count detached nodes, native array-buffer bytes and native compiled
WebAssembly modules. These native buffers can be much larger than the reported JavaScript heap.

Inspect the largest native buffer's retaining path in the snapshot as well as the JavaScript summary.
For the code-fence regression, the old path was module context → `HEAPU8` → `ArrayBuffer` → backing store.
Use workspace-store arrays to distinguish the selected transcript from bounded activity summaries.
The browser regression `markdown-memory` checks that code is highlighted without instantiating the
persistent native runtime; unit tests cover registry recycling, idle disposal and canceled updates.

Real-workspace snapshots contain conversation strings and stay local. Publish generated screenshots
and aggregate numbers. Retained allocations are not RSS: native shell, networking, graphics processes,
allocator capacity and diagnostic overhead require a separate visible native desktop measurement.
The total desktop RSS target in #360 remains 150 MB over at least five minutes of background activity.
