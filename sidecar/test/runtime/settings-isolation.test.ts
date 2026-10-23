import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Bot, Kernel, ProviderEvent, ProviderSession, StartTurnArgs, Thread } from "@touri/contracts"
import { createKernel } from "../../src/kernel"
import { folderGuestPath } from "../../src/kernel/bot-folders"
import { folderAccessUnavailable, refreshHostFolderAccess } from "../../src/kernel/folder-capability"
import { createClaudeAdapter } from "../../src/runtime/claude/adapter"
import { readOnlyAllow, readOnlyDeny } from "../../src/runtime/claude/settings"
import { createCodexAdapter } from "../../src/runtime/codex/adapter"
import { writePrivateFile } from "../../src/runtime/utils"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close()
})

const fixture = (vm = false, provider: "claude" | "codex" = "claude") => {
  const root = mkdtempSync(join(tmpdir(), "touri-settings-"))
  const runtime = createKernel({ appData: join(root, "data") })
  const workspace = join(root, "project")
  const home = join(root, "user")
  mkdirSync(join(workspace, ".claude"), { recursive: true })
  mkdirSync(join(home, ".claude"), { recursive: true })
  mkdirSync(join(home, ".codex"), { recursive: true })
  writeFileSync(join(home, ".codex/auth.json"), "{}", { mode: 0o600 })
  const permissive = { permissions: { allow: ["Bash(*)"], defaultMode: "auto" } }
  for (const path of [
    join(home, ".claude/settings.json"),
    join(workspace, ".claude/settings.json"),
    join(workspace, ".claude/settings.local.json"),
  ])
    writeFileSync(path, JSON.stringify(permissive))
  const scenario = join(root, "scenario.json")
  writeFileSync(
    scenario,
    JSON.stringify({ events: [{ type: "delta", delta: "Synthetic response." }, { type: "complete" }] }),
  )
  const calls: Array<Parameters<Kernel["spawnTree"]>[0]> = []
  const spawn: Kernel["spawnTree"] = (input) => {
    if (input.cmd === "cat") return runtime.kernel.spawnTree({ ...input, cmd: "/bin/cat" })
    calls.push(input)
    return runtime.kernel.spawnTree({
      ...input,
      cmd: process.execPath,
      env: { ...input.env, TOURI_FAKE_SCENARIO: scenario },
      args: [
        "run",
        join(import.meta.dir, `../fakes/fake-${provider}.ts`),
        ...(input.cmd === "/usr/bin/sandbox-exec"
          ? input.args.slice(3)
          : /\/bwrap$/.test(input.cmd)
            ? input.args.slice(input.args.indexOf("--") + 2)
            : input.args),
      ],
    })
  }
  const createAdapter = provider === "claude" ? createClaudeAdapter : createCodexAdapter
  const adapter = createAdapter({ kernel: { ...runtime.kernel, spawnTree: spawn }, command: process.execPath })
  const events: ProviderEvent[] = []
  const args: StartTurnArgs = {
    bot: {
      provider,
      access: "full",
      approvals: "on-request",
      homeDir: home,
      model: null,
      reasoningEffort: null,
    } as Bot,
    thread: { id: "thread-settings" } as Thread,
    session: null,
    fingerprint: { cwd: workspace } as StartTurnArgs["fingerprint"],
    input: [{ type: "text", text: "run the command" }],
    developerInstructions: "Test permissions.",
    handoffPacket: null,
    mcp: { command: process.execPath, args: [], env: {} },
    env: {
      HOME: home,
      CLAUDE_CONFIG_DIR: join(home, ".claude"),
      CODEX_HOME: join(home, ".codex"),
      TOURI_RUN_DIR: runtime.kernel.paths.runDir,
      TOURI_FAKE_SCENARIO: scenario,
    },
    signal: new AbortController().signal,
    onEvent: (event) => events.push(event),
    ...(vm ? { execution: { spawn, writeFile: async (file) => writePrivateFile({ ...file, root }) } } : {}),
  }
  cleanups.push(async () => {
    await adapter.shutdown()
    await runtime.stop()
    rmSync(root, { recursive: true, force: true })
  })
  return { root, adapter, args, calls, events, scenario, workspace, home, kernel: runtime.kernel }
}

for (const vm of [false, true])
  for (const provider of ["claude", "codex"] as const)
    test(`A15 telemetry off overrides hostile ${provider} ${vm ? "VM" : "native"} environment`, async () => {
      const f = fixture(vm, provider)
      f.kernel.services.provide("store.settings", () => ({ cliTelemetry: "off" }) as never)
      Object.assign(f.args.env, {
        DISABLE_TELEMETRY: "0",
        DISABLE_ERROR_REPORTING: "0",
        DO_NOT_TRACK: "0",
        CLAUDE_CODE_ENABLE_TELEMETRY: "1",
        OTEL_TRACES_EXPORTER: "otlp",
        OTEL_METRICS_EXPORTER: "otlp",
        OTEL_LOGS_EXPORTER: "otlp",
      })
      expect((await f.adapter.startTurn(f.args)).success).toBe(true)
      const env = f.calls[0]?.env
      expect(env?.DISABLE_TELEMETRY).toBe("1")
      expect(env?.DISABLE_ERROR_REPORTING).toBe("1")
      expect(env?.CLAUDE_CODE_ENABLE_TELEMETRY).toBe(
        provider === "codex" && /\/bwrap$/.test(f.calls[0]?.cmd ?? "") ? undefined : "0",
      )
      for (const key of ["OTEL_TRACES_EXPORTER", "OTEL_METRICS_EXPORTER", "OTEL_LOGS_EXPORTER"])
        expect(env?.[key]).toBe("none")
    })

for (const vm of [false, true])
  for (const provider of ["claude", "codex"] as const)
    test(`A15 explicit CLI-default preserves ${provider} ${vm ? "VM" : "native"} reporting configuration`, async () => {
      const f = fixture(vm, provider)
      f.kernel.services.provide("store.settings", () => ({ cliTelemetry: "cli-default" }) as never)
      Object.assign(f.args.env, {
        DISABLE_TELEMETRY: "0",
        CLAUDE_CODE_ENABLE_TELEMETRY: "1",
        OTEL_METRICS_EXPORTER: "otlp",
      })
      expect((await f.adapter.startTurn(f.args)).success).toBe(true)
      expect(f.calls[0]?.env.DISABLE_TELEMETRY).toBe("0")
      expect(f.calls[0]?.env.OTEL_METRICS_EXPORTER).toBe("otlp")
      if (provider === "codex") expect(f.calls[0]?.args).not.toContain("analytics.enabled=false")
    })

for (const vm of [false, true]) {
  for (const [access, approvals, mode] of [
    ["read-only", "on-request", "dontAsk"],
    ["workspace-write", "on-request", "default"],
    ["workspace-write", "never", "acceptEdits"],
    ["full", "on-request", "default"],
    ["full", "never", "bypassPermissions"],
  ] as const) {
    for (const resumed of [false, true]) {
      test(`Claude isolates ${vm ? "VM" : "host"} ${access}/${approvals} ${resumed ? "resume" : "new"}`, async () => {
        const f = fixture(vm)
        f.args.bot.access = access
        f.args.bot.approvals = approvals
        if (resumed) f.args.session = { externalSessionId: "old-session" } as ProviderSession
        const result = await f.adapter.startTurn(f.args)
        expect(result).toMatchObject({ success: true })
        const call = f.calls[0]
        if (!call) throw new Error("Missing spawn")
        const option = (flag: string) => call.args[call.args.indexOf(flag) + 1]
        expect(call.args).toContain("--setting-sources=")
        const settings = JSON.parse(readFileSync(option("--settings") ?? "", "utf8"))
        expect(settings.permissions).toEqual({
          allow: access === "read-only" ? readOnlyAllow : [],
          deny: access === "read-only" ? readOnlyDeny : [],
          ask: approvals === "on-request" && access !== "read-only" ? ["Bash"] : [],
        })
        expect(Object.keys(settings)).toEqual(["permissions", "hooks"])
        for (const event of ["PostToolUse", "PostToolUseFailure"]) {
          expect(settings.hooks[event]).toEqual([
            {
              hooks: [
                {
                  type: "mcp_tool",
                  server: "touri",
                  tool: "approval_context",
                  timeout: 10,
                  input: {
                    // biome-ignore lint/suspicious/noTemplateCurlyInString: Claude hook field substitutions
                    tool_name: "${tool_name}",
                    // biome-ignore lint/suspicious/noTemplateCurlyInString: Claude hook field substitutions
                    tool_use_id: "${tool_use_id}",
                    // biome-ignore lint/suspicious/noTemplateCurlyInString: Claude hook field substitutions
                    input: "${tool_input}",
                    hook_event_name: event,
                  },
                },
              ],
            },
          ])
        }
        expect(option("--permission-mode")).toBe(mode)
        if (access === "read-only") {
          expect(option("--permission-mode")).not.toBe("plan")
          expect(settings.permissions.allow).toContain("mcp__touri__*")
          for (const tool of ["Bash", "Write", "Edit", "NotebookEdit"])
            expect(settings.permissions.deny).toContain(tool)
        }
        expect(call.args.includes("--permission-prompt-tool")).toBe(
          approvals === "on-request" && access !== "read-only",
        )
        expect(call.env.HOME).toBe(/\/bwrap$/.test(call.cmd) ? "/touri/home" : f.home)
        expect(call.cwd).toBe(f.workspace)
        expect(call.args).toContain(resumed ? "--resume" : "--session-id")
        expect(readFileSync(join(f.home, ".claude/settings.json"), "utf8")).toContain("auto")
      })
    }
  }
}

for (const vm of [false, true]) {
  test(`Claude preserves only user authentication settings on ${vm ? "VM" : "host"}`, async () => {
    const f = fixture(vm)
    writeFileSync(
      join(f.home, ".claude/settings.json"),
      JSON.stringify({
        apiKeyHelper: "my-credential-helper",
        forceLoginOrgUUID: ["user-org"],
        permissions: { allow: ["Bash(*)"], defaultMode: "auto" },
        hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "auto-approve" }] }] },
        env: { ANTHROPIC_API_KEY: "settings-credential", CLAUDE_CODE_PERMISSION_MODE: "bypassPermissions" },
      }),
    )
    expect((await f.adapter.startTurn(f.args)).success).toBe(true)
    const argv = f.calls[0]?.args ?? []
    expect(argv.join(" ")).not.toContain("settings-credential")
    expect(f.calls[0]?.env.ANTHROPIC_API_KEY).toBe("settings-credential")
    expect(f.calls[0]?.env.CLAUDE_CODE_PERMISSION_MODE).toBeUndefined()
    const settingsPath = argv[argv.indexOf("--settings") + 1] ?? ""
    expect(statSync(settingsPath).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toMatchObject({
      apiKeyHelper: "my-credential-helper",
      forceLoginOrgUUID: ["user-org"],
      permissions: { allow: [], deny: [], ask: ["Bash"] },
    })
    expect(JSON.parse(readFileSync(settingsPath, "utf8")).hooks.PreToolUse).toBeUndefined()
  })
}

for (const vm of [false, true]) {
  for (const command of ["gh pr merge 123", "git push origin main", "rm protected.txt", "gh pr list"]) {
    test(`hostile settings cannot bypass ${vm ? "VM" : "host"} approval: ${command}`, async () => {
      const f = fixture(vm)
      const marker = join(f.root, "executed")
      writeFileSync(f.scenario, JSON.stringify({ permissionCommand: command, executionMarker: marker }))
      f.args.onEvent = (event) => {
        f.events.push(event)
        if (event.type === "approval_request") {
          expect(existsSync(marker)).toBe(false)
          void f.adapter.answerApproval({ approvalId: event.approvalId, decision: "denied" })
        }
      }
      const result = await f.adapter.startTurn(f.args)
      expect(result).toMatchObject({ success: true })
      expect(f.events.filter((event) => event.type === "approval_request")).toHaveLength(1)
      expect(existsSync(marker)).toBe(false)
    })
  }
}

test("an approved command executes through the isolated CLI stub", async () => {
  const f = fixture()
  const marker = join(f.root, "executed")
  writeFileSync(f.scenario, JSON.stringify({ permissionCommand: "git push origin main", executionMarker: marker }))
  f.args.onEvent = (event) => {
    if (event.type === "approval_request")
      void f.adapter.answerApproval({ approvalId: event.approvalId, decision: "approved" })
  }
  expect((await f.adapter.startTurn(f.args)).success).toBe(true)
  expect(readFileSync(marker, "utf8")).toBe("git push origin main")
})

for (const vm of [false, true]) {
  for (const access of ["read-only", "workspace-write", "full"] as const) {
    for (const approvals of ["on-request", "never"] as const) {
      for (const resumed of [false, true]) {
        test(`Codex explicitly sets ${vm ? "VM" : "host"} ${access}/${approvals} ${resumed ? "resume" : "new"} policy`, async () => {
          const f = fixture(vm, "codex")
          f.args.bot.access = access
          f.args.bot.approvals = approvals
          if (resumed) f.args.session = { externalSessionId: "old-session", rolloutPath: null } as ProviderSession
          const requestLogPath = join(f.root, "requests.jsonl")
          writeFileSync(
            f.scenario,
            JSON.stringify({
              events: [{ type: "delta", delta: "Synthetic response." }, { type: "complete" }],
              requestLogPath,
            }),
          )
          expect((await f.adapter.startTurn(f.args)).success).toBe(true)
          const call = f.calls[0]
          if (!call) throw new Error("Missing spawn")
          // These bots have no extra grants. Linux keeps the provider's boundary;
          // bounded macOS turns inherit Seatbelt, and full access launches directly.
          const inherited = !vm && access !== "full" && process.platform === "darwin"
          const directCommand = vm ? "codex" : process.execPath
          expect(call.cmd).toBe(inherited ? "/usr/bin/sandbox-exec" : directCommand)
          const outer = call.cmd === "/usr/bin/sandbox-exec" || /\/bwrap$/.test(call.cmd)
          expect(call.args).toContain('approvals_reviewer="user"')
          if (access === "full") {
            expect(call.args).toContain('sandbox_mode="danger-full-access"')
            expect(call.args).toContain(`approval_policy=${JSON.stringify(approvals)}`)
          } else if (access === "read-only")
            expect(call.args).toContain(outer ? 'sandbox_mode="danger-full-access"' : 'sandbox_mode="read-only"')
          const requests = readFileSync(requestLogPath, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as { method: string; params: Record<string, unknown> })
          const session = requests.find((request) => request.method === (resumed ? "thread/resume" : "thread/start"))
          expect(session?.params).toMatchObject({
            cwd: f.workspace,
            // An inherited host boundary replaces the provider's inner sandbox.
            sandbox: access === "full" || outer ? "danger-full-access" : access,
            approvalPolicy: access === "read-only" ? "never" : approvals,
            approvalsReviewer: "user",
          })
        })
      }
    }
  }
}

for (const vm of [false, true]) {
  test(`Codex runs touri tools without its own ${vm ? "VM" : "host"} prompt and never leaves a server request unanswered`, async () => {
    const f = fixture(vm, "codex")
    f.args.bot.access = "workspace-write"
    f.args.bot.approvals = "on-request"
    const requestLogPath = join(f.root, "requests.jsonl")
    const elicitation = {
      id: 7,
      method: "mcpServer/elicitation/request",
      params: {
        serverName: "touri",
        mode: "form",
        message: 'Allow the touri MCP server to run tool "browser_open"?',
        requestedSchema: { type: "object", properties: {} },
        _meta: { codex_approval_kind: "mcp_tool_call" },
      },
    }
    const unknown = { id: 8, method: "item/tool/requestUserInput", params: {} }
    writeFileSync(
      f.scenario,
      JSON.stringify({ events: [elicitation, unknown, { type: "sleep" }, { type: "complete" }], requestLogPath }),
    )
    const started = Date.now()
    expect((await f.adapter.startTurn(f.args)).success).toBe(true)
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(f.calls[0]?.args.join(" ")).toContain('default_tools_approval_mode="approve"')
    const frames = readFileSync(requestLogPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { id?: number; method?: string; params?: Record<string, unknown> })
    const session = frames.find((frame) => frame.method === "thread/start")
    expect(session?.params).toMatchObject({
      config: { mcp_servers: { touri: { default_tools_approval_mode: "approve" } } },
    })
    expect(frames.find((frame) => frame.id === 7 && !frame.method)).toMatchObject({ result: { action: "decline" } })
    expect(frames.find((frame) => frame.id === 8 && !frame.method)).toMatchObject({ error: { code: -32601 } })
  })
}

for (const provider of ["claude", "codex"] as const)
  for (const vm of [false, true])
    test(`${provider} folder grants preserve CLI policy and require ${vm ? "guest execution" : "a host sandbox"}`, async () => {
      const f = fixture(vm, provider)
      const ro = join(f.root, "reference")
      const rw = join(f.root, "writable")
      mkdirSync(ro)
      mkdirSync(rw)
      // macOS temp roots may be spelled /var rather than /private/var.
      const { realpathSync } = await import("node:fs")
      f.args.bot.access = "workspace-write"
      f.args.bot.folders = [
        { path: realpathSync(ro), access: "read-only" },
        { path: realpathSync(rw), access: "read-write" },
      ]
      const requestLogPath = join(f.root, "folder-requests.jsonl")
      writeFileSync(
        f.scenario,
        JSON.stringify({
          events: [{ type: "delta", delta: "Synthetic response." }, { type: "complete" }],
          requestLogPath,
        }),
      )
      const available =
        process.platform === "darwin" || (process.platform === "linux" && (await refreshHostFolderAccess()))
      const result = await f.adapter.startTurn(f.args)
      if (!vm && !available) {
        expect(result).toMatchObject({ success: false, errorCode: "cli_crash" })
        if (!result.success) expect(result.error).toBe(folderAccessUnavailable)
        expect(f.calls).toHaveLength(0)
        return
      }
      expect(result).toMatchObject({ success: true })
      if (!vm && process.platform === "linux") expect(f.calls[0]?.cmd).toMatch(/\/bwrap$/)
      else expect(f.calls[0]?.cmd).toBe(vm ? provider : "/usr/bin/sandbox-exec")
      const grantedRO = vm ? folderGuestPath(realpathSync(ro)) : realpathSync(ro)
      const grantedRW = vm ? folderGuestPath(realpathSync(rw)) : realpathSync(rw)
      if (provider === "claude") {
        const cli = f.calls[0]?.args ?? []
        expect(cli).toContain(grantedRO)
        expect(cli).toContain(grantedRW)
        const added = cli.flatMap((arg, i) => (arg === "--add-dir" ? [cli[i + 1]] : []))
        expect(added).toContain(grantedRO)
        expect(added).toContain(grantedRW)
      } else {
        const requests = readFileSync(requestLogPath, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
        const request = requests.find((request) => request.method === "thread/start")
        if (!vm) {
          expect(request.params.sandbox).toBe("danger-full-access")
          if (process.platform === "darwin") {
            const profile = f.calls[0]?.args[1] ?? ""
            expect(profile).toContain(`(subpath ${JSON.stringify(grantedRW)})`)
            expect(profile).toContain(`(deny file-write* (subpath ${JSON.stringify(grantedRO)}))`)
          }
        } else {
          expect(request.params.config.sandbox_workspace_write.writable_roots).toContain(grantedRW)
          expect(request.params.config.sandbox_workspace_write.writable_roots).not.toContain(grantedRO)
        }
      }
    })
