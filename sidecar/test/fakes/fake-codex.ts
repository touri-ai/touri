import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs"

type RecordValue = Record<string, unknown>
type Scenario = {
  sessionId?: string
  rolloutPath?: string
  deltas?: Array<string>
  events?: Array<unknown>
  crashAt?: number
  stderr?: string
  startupStderr?: string
  authError?: boolean
  slowMs?: number
  ignoreInterrupt?: boolean
  exitOnInterrupt?: boolean
  toolPidPath?: string
  badResume?: boolean
  resumeExit?: { code: number; stderr: string }
  resumeError?: string
  waitForApproval?: boolean
  afterApproval?: Array<unknown>
  logPath?: string
  requestLogPath?: string
  pauseAfterFirstDelta?: string
  pauseBeforeTurnStart?: string
}

const record = (value: unknown): RecordValue | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as RecordValue) : null
const stringValue = (value: unknown): string | null => (typeof value === "string" ? value : null)

const loadScenario = (): Scenario => {
  const path = process.env.TOURI_FAKE_SCENARIO ?? process.env.FAKE_CODEX_SCENARIO
  if (!path || !existsSync(path)) return { deltas: ["one ", "two ", "three"] }
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown
    return record(value) as Scenario
  } catch {
    return { authError: true }
  }
}

const output = (value: unknown): void => {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

const eventFrame = (event: unknown, turnId: string): RecordValue | null => {
  const item = record(event)
  if (!item) return null
  const type = stringValue(item.type) ?? ""
  if (type === "delta" || type === "text_delta")
    return { method: "item/agentMessage/delta", params: { itemId: "agent", delta: stringValue(item.delta) ?? "" } }
  if (type === "reasoning_delta")
    return {
      method: "item/reasoning/summaryTextDelta",
      params: { itemId: "reasoning", delta: stringValue(item.delta) ?? "" },
    }
  if (type === "command")
    return {
      method: "item/completed",
      params: {
        item: {
          type: "commandExecution",
          id: stringValue(item.callId) ?? "command-1",
          command: stringValue(item.command) ?? "echo fake",
          cwd: stringValue(item.cwd) ?? process.cwd(),
          exitCode: typeof item.exitCode === "number" ? item.exitCode : 0,
          output: stringValue(item.output) ?? "",
        },
      },
    }
  if (type === "file_change")
    return {
      method: "item/completed",
      params: {
        item: {
          type: "fileChange",
          id: stringValue(item.callId) ?? "change-1",
          paths: Array.isArray(item.paths) ? item.paths : [],
          diff: stringValue(item.diff) ?? "",
        },
      },
    }
  if (type === "approval")
    return {
      id: 99,
      method: "item/commandExecution/requestApproval",
      params: {
        approvalId: stringValue(item.approvalId) ?? "approval-1",
        command: stringValue(item.command) ?? "echo fake",
      },
    }
  if (type === "usage") return { method: "turn/usage", params: { usage: item.usage ?? {} } }
  if (type === "complete") return { method: "turn/completed", params: { status: "succeeded", turnId } }
  if (type === "fail")
    return {
      method: "turn/completed",
      params: { status: "failed", errorMessage: stringValue(item.message) ?? "fake failure", turnId },
    }
  if (type === "sleep") return null
  return item
}

if (process.argv.includes("--version")) {
  process.stdout.write("0.160.0\n")
  process.exit(0)
}

const scenario = loadScenario()
if (scenario.startupStderr) {
  process.stderr.write(scenario.startupStderr.slice(0, 24))
  setTimeout(() => process.stderr.write(scenario.startupStderr?.slice(24) ?? ""), 10)
}
const sessionId = scenario.sessionId ?? "fake-codex-session"
let sequence = 0
let buffer = ""
let interrupted = false
let turnCount = 0
let waitingForApproval = false

const emitTurn = async (): Promise<void> => {
  const scenario = loadScenario()
  const turnId = `fake-turn-${++turnCount}`
  if (scenario.authError) {
    output({ method: "error", params: { message: "login required" } })
    return
  }
  output({ method: "turn/started", params: { turnId } })
  if (scenario.toolPidPath) {
    const tool = Bun.spawn({
      cmd: [
        process.execPath,
        "-e",
        'process.on("SIGTERM", () => {}); process.stdout.write("ready"); setInterval(() => {}, 1000)',
      ],
      stdin: "ignore",
      stdout: "pipe",
      stderr: "inherit",
    })
    await tool.stdout.getReader().read()
    writeFileSync(scenario.toolPidPath, String(tool.pid))
  }
  const events = scenario.events ?? [
    ...(scenario.deltas ?? ["one ", "two ", "three"]).map((delta) => ({ type: "delta", delta })),
    { type: "complete" },
  ]
  for (const event of events) {
    if (interrupted) {
      output({ method: "turn/completed", params: { status: "interrupted", turnId } })
      interrupted = false
      return
    }
    sequence += 1
    if (scenario.crashAt === sequence) {
      if (scenario.stderr) process.stderr.write(`${scenario.stderr}\n`)
      process.exit(17)
    }
    const frame = eventFrame(event, turnId)
    if (frame) {
      output(frame)
      if (sequence === 1 && scenario.pauseAfterFirstDelta)
        while (!existsSync(scenario.pauseAfterFirstDelta)) await Bun.sleep(10)
      if (record(event)?.type === "approval" && scenario.waitForApproval) {
        waitingForApproval = true
        return
      }
    }
    const delay = scenario.slowMs ?? (record(event)?.type === "sleep" ? 1_000 : 0)
    if (delay > 0) await Bun.sleep(delay)
  }
}

const invalidInputItem = (request: RecordValue): boolean => {
  const params = request.params as { input?: Array<RecordValue> } | undefined
  return (params?.input ?? []).some((item) => {
    if (item.type === "text") return typeof item.text !== "string"
    if (item.type === "image") return typeof item.url !== "string" && typeof item.fileId !== "string"
    if (item.type === "localImage") return typeof item.path !== "string"
    return true
  })
}

process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk: string) => {
  buffer += chunk
  let newline = buffer.indexOf("\n")
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim()
    buffer = buffer.slice(newline + 1)
    newline = buffer.indexOf("\n")
    if (!line) continue
    let request: RecordValue
    try {
      request = JSON.parse(line) as RecordValue
    } catch {
      output({ method: "error", params: { message: "malformed JSON" } })
      continue
    }
    const method = stringValue(request.method) ?? ""
    const id = typeof request.id === "number" ? request.id : null
    if (scenario.requestLogPath) appendFileSync(scenario.requestLogPath, `${JSON.stringify(request)}\n`)
    if (scenario.logPath) {
      try {
        const prior = existsSync(scenario.logPath) ? readFileSync(scenario.logPath, "utf8") : ""
        Bun.write(scenario.logPath, `${prior}${method}\n`)
      } catch {
        // Fixture logging is best effort.
      }
    }
    if (method === "initialize" && id !== null)
      output({ jsonrpc: "2.0", id, result: { serverInfo: { name: "fake-codex", version: "0.160.0" } } })
    else if (method === "thread/start" && id !== null)
      output({ jsonrpc: "2.0", id, result: { thread: { id: sessionId, path: scenario.rolloutPath ?? null } } })
    else if (method === "thread/resume" && id !== null) {
      if (scenario.resumeExit) {
        process.stderr.write(`${scenario.resumeExit.stderr}\n`)
        process.exit(scenario.resumeExit.code)
      }
      if (scenario.resumeError) output({ method: "error", params: { message: scenario.resumeError } })
      else if (scenario.badResume) output({ jsonrpc: "2.0", id, error: { message: "rollout not found" } })
      else output({ jsonrpc: "2.0", id, result: { thread: { id: sessionId, path: scenario.rolloutPath ?? null } } })
    } else if (method === "turn/start" && invalidInputItem(request)) {
      if (id !== null)
        output({
          jsonrpc: "2.0",
          id,
          error: { message: "Invalid request: data did not match any variant of untagged enum ImageReference" },
        })
    } else if (method === "turn/start") {
      void (async () => {
        if (scenario.pauseBeforeTurnStart) while (!existsSync(scenario.pauseBeforeTurnStart)) await Bun.sleep(10)
        if (id !== null) output({ jsonrpc: "2.0", id, result: { turn: { id: `fake-turn-${turnCount + 1}` } } })
        await emitTurn()
      })()
    } else if (method === "turn/interrupt") {
      if (scenario.exitOnInterrupt) process.exit(0)
      if (!scenario.ignoreInterrupt) interrupted = true
    } else if (waitingForApproval && id === 99) {
      waitingForApproval = false
      for (const event of scenario.afterApproval ?? []) {
        const frame = eventFrame(event, `fake-turn-${turnCount}`)
        if (frame) output(frame)
      }
      output({ method: "turn/completed", params: { status: "succeeded", turnId: `fake-turn-${turnCount}` } })
    } else if (id !== null) output({ jsonrpc: "2.0", id, result: {} })
  }
})
