import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

type RecordValue = Record<string, unknown>
type Scenario = {
  sessionId?: string
  deltas?: Array<string>
  events?: Array<unknown>
  crashAt?: number
  authError?: boolean
  slowMs?: number
  ignoreInterrupt?: boolean
  signalLogPath?: string
  permissionCommand?: string
  executionMarker?: string
  permissionOutcome?: string
  startupStderr?: string
  resumeError?: string
}

const record = (value: unknown): RecordValue | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as RecordValue) : null
const stringValue = (value: unknown): string | null => (typeof value === "string" ? value : null)

const loadScenario = (): Scenario => {
  const path = process.env.TOURI_FAKE_SCENARIO ?? process.env.FAKE_CLAUDE_SCENARIO
  if (!path || !existsSync(path)) return { deltas: ["one ", "two ", "three"] }
  try {
    return record(JSON.parse(readFileSync(path, "utf8"))) as Scenario
  } catch {
    return { authError: true }
  }
}

const output = (value: unknown): void => {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}
const eventFrames = (event: unknown): Array<RecordValue> => {
  const item = record(event)
  if (!item) return []
  const type = stringValue(item.type) ?? ""
  if (type === "delta" || type === "text_delta")
    return [
      {
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: stringValue(item.delta) ?? "" } },
      },
    ]
  if (type === "tool")
    return [
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: stringValue(item.callId) ?? "tool-1",
              name: stringValue(item.name) ?? "fake_tool",
              input: item.input ?? {},
            },
          ],
        },
      },
    ]
  if (type === "approval")
    return [
      {
        type: "approval_request",
        approval_id: stringValue(item.approvalId) ?? "approval-1",
        tool_use_id: stringValue(item.toolUseId) ?? "tool-approval",
        input: item.input ?? {},
      },
    ]
  if (type === "fail")
    return [{ type: "result", is_error: true, subtype: "error", result: stringValue(item.message) ?? "fake failure" }]
  if (type === "complete") return [{ type: "result", is_error: false, subtype: "success", result: "" }]
  return [item]
}

if (process.argv.includes("--version")) {
  process.stdout.write("2.1.0\n")
  process.exit(0)
}

const scenario = loadScenario()
if (scenario.resumeError && process.argv.includes("--resume")) {
  process.stderr.write(scenario.resumeError.slice(0, 24))
  await Bun.sleep(10)
  await Bun.write(Bun.stderr, scenario.resumeError.slice(24))
  process.exit(1)
}
if (scenario.ignoreInterrupt || scenario.signalLogPath) {
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.on(signal, () => {
      if (scenario.signalLogPath) writeFileSync(scenario.signalLogPath, signal)
      if (!scenario.ignoreInterrupt) process.exit(0)
    })
}
if (scenario.startupStderr) {
  process.stderr.write(scenario.startupStderr.slice(0, 24))
  setTimeout(() => process.stderr.write(scenario.startupStderr?.slice(24) ?? ""), 10)
}
const sessionId = scenario.sessionId ?? "fake-claude-session"
let buffer = ""
let sequence = 0
let interrupted = false
let pendingPermission = false

// Model the documented settings merge and ask-before-allow ordering for the security integration test.
const permissionRequired = (command: string): boolean => {
  const argv = process.argv
  const option = (flag: string) => {
    const assigned = argv.find((arg) => arg.startsWith(`${flag}=`))
    if (assigned !== undefined) return assigned.slice(flag.length + 1)
    const index = argv.indexOf(flag)
    return index < 0 ? undefined : argv[index + 1]
  }
  const sources = option("--setting-sources")?.split(",") ?? ["user", "project", "local"]
  const configs: Array<RecordValue> = []
  for (const [source, path] of [
    ["user", join(process.env.HOME ?? "", ".claude/settings.json")],
    ["project", join(process.cwd(), ".claude/settings.json")],
    ["local", join(process.cwd(), ".claude/settings.local.json")],
  ]) {
    if (source && path && sources.includes(source) && existsSync(path))
      configs.push(JSON.parse(readFileSync(path, "utf8")) as RecordValue)
  }
  const settings = option("--settings")
  if (settings)
    configs.push(JSON.parse(existsSync(settings) ? readFileSync(settings, "utf8") : settings) as RecordValue)
  const matches = (rule: unknown) => {
    if (rule === "Bash" || rule === "Bash(*)") return true
    if (typeof rule !== "string") return false
    const prefix = /^Bash\((.*):\*\)$/.exec(rule)?.[1]
    return prefix !== undefined && (command === prefix || command.startsWith(`${prefix} `))
  }
  const permissions = configs.map((config) => record(config.permissions) ?? {})
  if (permissions.some((rules) => Array.isArray(rules.ask) && rules.ask.some(matches))) return true
  if (permissions.some((rules) => Array.isArray(rules.allow) && rules.allow.some(matches))) return false
  return true
}

const finishPermission = (allowed: boolean): void => {
  if (allowed && scenario.executionMarker) writeFileSync(scenario.executionMarker, scenario.permissionCommand ?? "")
  output({ type: "result", is_error: false, subtype: "success", result: allowed ? "executed" : "denied" })
}

const emitTurn = async (): Promise<void> => {
  if (scenario.authError) {
    output({ type: "result", is_error: true, subtype: "error", result: "login required" })
    return
  }
  output({ type: "system", subtype: "init", session_id: sessionId })
  if (scenario.permissionCommand) {
    if (permissionRequired(scenario.permissionCommand)) {
      pendingPermission = true
      output({
        type: "approval_request",
        approval_id: "settings-approval",
        tool_use_id: "settings-tool",
        input: { command: scenario.permissionCommand },
      })
    } else finishPermission(true)
    return
  }
  const events = scenario.events ?? [
    ...(scenario.deltas ?? ["one ", "two ", "three"]).map((delta) => ({ type: "delta", delta })),
    { type: "complete" },
  ]
  for (const event of events) {
    if (interrupted) {
      output({ type: "result", is_error: true, subtype: "error", result: "interrupted" })
      interrupted = false
      return
    }
    sequence += 1
    if (scenario.crashAt === sequence) process.exit(17)
    for (const frame of eventFrames(event)) output(frame)
    if ((scenario.slowMs ?? 0) > 0) await Bun.sleep(scenario.slowMs ?? 0)
  }
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
      continue
    }
    if (request.type === "control_request") {
      if (record(request.request)?.subtype === "initialize") {
        output({ type: "control_response", response: { subtype: "success", request_id: request.request_id } })
        continue
      }
      if (!scenario.ignoreInterrupt) interrupted = true
      continue
    }
    if (request.type === "user") {
      if (pendingPermission) {
        const content = record(request.message)?.content
        const result = Array.isArray(content) ? record(content[0]) : null
        if (result?.type === "tool_result") {
          if (scenario.permissionOutcome) writeFileSync(scenario.permissionOutcome, String(result.content))
          pendingPermission = false
          finishPermission(result.is_error !== true)
          continue
        }
      }
      void emitTurn()
    }
  }
})
