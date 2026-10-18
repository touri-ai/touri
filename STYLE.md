# Code style

Every contributor — human or coding agent — reads this before writing code in this repository.
Biome enforces formatting (`bunx biome check .`); this file covers what a formatter cannot.

The goal is code a new reader understands top to bottom on the first pass: small functions, data in, data out, no surprises.

## 1. Functional by default

- Prefer pure functions that take data and return data. Side effects (I/O, DB, network, timers) live at the edges and are named for what they do.
- Transform collections with `map`, `filter`, `reduce`, `flatMap`, `some`, `every`, `find`. Use `for … of` only when you need `await` in sequence or an early `break`.
- Compose small helpers instead of one long function. A function that needs a comment per block is several functions.

```ts
// avoid
const names: string[] = []
for (const bot of bots) {
  if (bot.enabled) names.push(bot.name.trim())
}

// prefer
const names = bots.filter((bot) => bot.enabled).map((bot) => bot.name.trim())
```

## 2. Do not mutate — build new values

- `const` everywhere; `let` only when a value really changes in a tight scope (Biome `useConst` is on).
- Never mutate arguments, shared objects or module state. Return a new object with spreads.
- Prefer `[...items, next]`, `{ ...bot, name }`, `items.filter(...)`, `toSorted`/`toReversed` over `push`, `splice`, `sort`, `reverse`, `delete` and property assignment.
- Do not reassign globals (`globalThis.fetch`, `process.env.X = …`) to change behaviour. Pass the dependency in (a `fetch`, an `env`, a clock) and default it to the real one.

```ts
// avoid
function rename(bot: Bot, name: string) {
  bot.name = name
  bot.updatedAt = Date.now()
  return bot
}

// prefer
const rename = (bot: Bot, name: string, now = Date.now()): Bot => ({ ...bot, name, updatedAt: now })
```

## 3. Name reads with `get…`

- A function that reads or derives a value is `getX` (`getBotSettings`, `getMem0Url`), takes everything it needs as arguments, and returns the value — it never also writes.
- Writers say what they change: `saveX`, `setX`, `deleteX`, `sendX`, `startX`.
- Booleans read as questions: `isEnabled`, `hasAccess`, `canWrite`.
- Lookups that can miss return `undefined` (or `null` where the API already does) and the caller handles it with an early return.

```ts
const getMem0Url = (env: Env) => env.TOURI_MEM0_PLATFORM_URL ?? MEM0_DEFAULT_URL

const getBotMemory = (db: Database, botId: string) =>
  db.query("SELECT value_json FROM settings WHERE key = ?").get(`mem0:${botId}`) as { value_json: string } | null
```

## 4. Early return, no nesting

- Handle invalid input, missing data and errors first, then `return`. The happy path stays at the left margin at the end of the function.
- No `else` after `return`/`throw`. At most two levels of indentation inside a function body.
- Replace nested ternaries with early returns or a lookup object.

```ts
// avoid
function getReply(turn?: Turn) {
  if (turn) {
    if (turn.status === "done") {
      return turn.text
    } else {
      return ""
    }
  }
  return ""
}

// prefer
function getReply(turn?: Turn) {
  if (!turn) return ""
  if (turn.status !== "done") return ""

  return turn.text
}
```

## 5. Readability and spacing

- One idea per line. Split long expressions into well-named `const`s instead of chaining everything.
- Separate logical steps with one blank line: **arrange / act / assert**, **read / decide / write**. No blank lines inside a single step, never two in a row.
- Put the exported, high-level function first and its helpers below it, so the file reads top-down.
- Name things for the domain (`bot`, `turn`, `grant`), not the type (`obj`, `data`, `arr`). No single-letter names outside tiny lambdas.
- No leading-semicolon tricks (`;(x as Y).foo()`), no inline `import("…")` types, no `as unknown as`. Give the value a typed `const` first.
- Comments explain *why*, never *what*. Delete commented-out code.
- Avoid `any`; avoid non-null `!` (Biome errors on it). Narrow with an early return instead.

## 6. Tests

- Each test reads as arrange → act → assert, separated by blank lines.
- Build fixtures with small `get…` / `make…` helpers that return fresh objects; never share mutable fixtures across tests.
- Inject fakes (fetch, clock, env, host calls) as arguments instead of patching globals; if a global must be patched, do it in one helper that returns its own restore function.
- Cleanup goes in `afterEach`, not in a `try/finally` around the whole test body.

```ts
// avoid: globals patched in the body, casts, cleanup in finally
try {
  process.env.TOURI_MEM0_PLATFORM_URL = "http://localhost:8888"
  globalThis.fetch = (async (url) => { destinations.push(String(url)); return memories([]) }) as typeof fetch
  ;(runtime.kernel.db as import("bun:sqlite").Database).query("INSERT …").run(`mem0:${botId}`, "…")
  await runtime.kernel.services.use("mem0.api")?.recall({ botId, query: "Qual a minha cidade?" })
  expect(destinations).toEqual(["https://api.mem0.ai/v3/memories/search/"])
} finally {
  globalThis.fetch = originalFetch
  // …
}

// prefer: injected dependencies, helpers, cleanup in afterEach
afterEach(() => runtime.stop())

test("production key ignores a local platform URL", async () => {
  const destinations: string[] = []
  const fetch = getRecordingFetch(destinations, memories([]))
  const runtime = await startRuntime({ env: { TOURI_MEM0_PLATFORM_URL: "http://localhost:8888" }, fetch })
  const bot = await createBot(runtime, { name: "memoria" })
  saveMem0Settings(runtime.db, bot.id, { enabled: true, hasKey: true })

  await getMem0(runtime).recall({ botId: bot.id, query: "Qual a minha cidade?" })

  expect(destinations).toEqual(["https://api.mem0.ai/v3/memories/search/"])
})
```

## 7. When to break a rule

Performance-critical loops, streaming parsers and code that must mutate for an external API may use `let`, `push` or in-place updates. Keep the mutation local to one function and say why in a one-line comment. Existing code is not rewritten just for style; apply this file to the code you touch.
