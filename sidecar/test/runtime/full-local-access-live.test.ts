import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Bot, Message, Run, ToolCallPart } from "@touri/contracts"

// Opt-in only: the installed, signed-in Codex CLI makes real model calls. Like
// linux-folder-live.test.ts, exercise the production server with disposable data.
test.skipIf(process.platform !== "linux" || process.env.TOURI_LIVE_FULL_LOCAL_QA !== "1")(
  "full local Linux bot keeps writing after redundant setup, legacy grants and restart",
  async () => {
    const provider = Bun.which("codex")
    if (!provider) throw new Error("This opt-in regression requires the installed Codex CLI")
    const root = mkdtempSync(join(tmpdir(), "touri-full-local-live-"))
    const data = join(root, "data")
    const cwd = join(root, "workspace")
    const binary = join(root, "sidecar")
    const token = "full-local-fixture-token"
    mkdirSync(cwd)
    let child: ReturnType<typeof Bun.spawn> | undefined
    let address = ""
    const request = async <T>(
      path: string,
      body?: unknown,
      method = body === undefined ? "GET" : "POST",
    ): Promise<T> => {
      const response = await fetch(`${address}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Origin: "tauri://localhost",
          "Content-Type": "application/json",
          Connection: "close",
        },
        signal: AbortSignal.timeout(10_000),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      if (!response.ok) throw new Error(`Full local live API failed (${response.status})`)
      return (await response.json()) as T
    }
    const start = async () => {
      const handshake = join(data, "run/handshake.json")
      rmSync(handshake, { force: true })
      child = Bun.spawn([binary, "serve"], {
        cwd: root,
        env: {
          ...process.env,
          TOURI_APP_DATA: data,
          TOURI_UI_TOKEN: token,
          TOURI_HEADLESS: "1",
          TOURI_CODEX_BIN: provider,
          TOURI_DOCTOR_SKIP_PROVIDER_PROBES: "1",
          TOURI_PARENT_PID: String(process.pid),
        },
        stdin: "pipe",
        stdout: "ignore",
        stderr: "ignore",
      })
      const deadline = Date.now() + 30_000
      for (;;) {
        if (child.exitCode !== null || Date.now() > deadline) throw new Error("Full local live server did not start")
        if (existsSync(handshake)) {
          const info = JSON.parse(readFileSync(handshake, "utf8")) as { port: number }
          address = `http://127.0.0.1:${info.port}/api/v1`
          if (
            await request("/routines").then(
              () => true,
              () => false,
            )
          )
            return
        }
        await Bun.sleep(50)
      }
    }
    const stop = async () => {
      if (!child) return
      child.kill("SIGTERM")
      const timer = setTimeout(() => child?.kill("SIGKILL"), 12_000)
      try {
        await child.exited
      } finally {
        clearTimeout(timer)
        child = undefined
      }
    }
    try {
      // Compile only this worktree's server into temporary storage. No UI or
      // native build is needed for the API and MCP paths under test.
      const build = Bun.spawn(
        [process.execPath, "build", "--compile", join(import.meta.dir, "../../src/main.ts"), "--outfile", binary],
        { cwd: root, stdout: "ignore", stderr: "ignore" },
      )
      const buildTimer = setTimeout(() => build.kill("SIGKILL"), 60_000)
      try {
        expect(await build.exited).toBe(0)
      } finally {
        clearTimeout(buildTimer)
      }
      await start()
      const { bot } = await request<{ bot: Bot }>("/bots", {
        name: "Full local fixture",
        provider: "codex",
        machine: "local",
        access: "full",
        approvals: "never",
        cwd,
        browserEnabled: false,
        computerUse: false,
      })
      const thread = bot.mainThreadId
      if (!thread) throw new Error("Full local live bot has no main thread")
      const messages = () => request<{ messages: Message[] }>(`/threads/${thread}/messages`)
      const runs = () => request<{ runs: Run[] }>(`/threads/${thread}/runs`)
      const send = async (text: string) => {
        const before = (await runs()).runs.length
        const { run } = await request<{ run: Run }>(`/bots/${bot.id}/messages`, { text })
        const deadline = Date.now() + 180_000
        while (Date.now() < deadline) {
          const history = (await messages()).messages
          expect(history.flatMap((message) => message.parts).some((part) => part.type === "approval")).toBe(false)
          const current = (await runs()).runs.find((item) => item.id === run.id)
          if (current && ["succeeded", "failed", "canceled", "interrupted"].includes(current.status)) {
            expect(current.status).toBe("succeeded")
            // A redundant setup call must not enqueue an automatic continuation.
            await Bun.sleep(1500)
            expect((await runs()).runs).toHaveLength(before + 1)
            return (await messages()).messages.filter((message) => message.runId === run.id)
          }
          await Bun.sleep(100)
        }
        throw new Error("Full local live turn exceeded its deadline")
      }
      const setupCalls = (history: Message[]) =>
        history.flatMap((message) =>
          message.parts.filter(
            (part): part is ToolCallPart =>
              part.type === "tool_call" && /(?:folder_access_request|project_link)$/.test(part.tool),
          ),
        )
      const first = join(cwd, "first.txt")
      const direct = await send(
        `Create ${JSON.stringify(first)} containing exactly "synthetic-first", no trailing newline.`,
      )
      expect(setupCalls(direct)).toEqual([])
      expect(readFileSync(first, "utf8")).toBe("synthetic-first")
      const output = join(cwd, "missing-parent/output")
      expect(existsSync(output)).toBe(false)
      const setup = setupCalls(
        await send(
          `For this regression, first call touri project_link({path: ${JSON.stringify(output)}}) while that folder is absent, then folder_access_request({path: ${JSON.stringify(output)}, mode: "read-write"}). After both calls, create the folder and second.txt inside it containing exactly "synthetic-second", no trailing newline. Do not register a project through any other route.`,
        ),
      )
      expect(setup.filter((part) => part.tool.endsWith("project_link"))).toHaveLength(1)
      expect(setup.filter((part) => part.tool.endsWith("folder_access_request"))).toHaveLength(1)
      for (const part of setup) {
        expect(part.ok).toBe(true)
        const result = JSON.parse(part.outputJson ?? "null")
        expect(result.isError).not.toBe(true)
        expect(result).toMatchObject({
          structuredContent: {
            path: output,
            alreadyAccessible: true,
            unchanged: true,
            automaticContinuation: false,
            effective: "current-turn",
          },
        })
      }
      expect(readFileSync(join(output, "second.txt"), "utf8")).toBe("synthetic-second")
      const currentBot = async () => (await request<{ bots: Bot[] }>("/bots")).bots.find((item) => item.id === bot.id)
      expect(await currentBot()).toMatchObject({
        machine: "local",
        access: "full",
        approvals: "never",
        cwd,
        folders: [],
        anyFolderAccess: false,
        projectId: null,
      })
      expect(await request("/projects")).toEqual({ projects: [] })
      await stop()
      // Seed only this disposable database, with the server stopped. Full local
      // access must ignore both stale grants and a legacy broad-access setting.
      const folders = [
        { path: cwd, access: "read-only" },
        { path: join(root, "missing-grant"), access: "read-write" },
      ]
      const db = new Database(join(data, "touri.db"))
      try {
        const update = db.query("UPDATE bots SET folders_json = ?, any_folder_access = 1 WHERE id = ?")
        update.run(JSON.stringify(folders), bot.id)
      } finally {
        db.close()
      }
      await start()
      const third = join(cwd, "third.txt")
      await send(`Create ${JSON.stringify(third)} containing exactly "synthetic-third", no trailing newline.`)
      expect(readFileSync(third, "utf8")).toBe("synthetic-third")
      const greeting = await send("Reply with exactly: hello-proof. Do not use tools.")
      expect(greeting.some((message) => message.role === "assistant" && message.text.includes("hello-proof"))).toBe(
        true,
      )
      expect(await currentBot()).toMatchObject({ access: "full", approvals: "never", folders, anyFolderAccess: true })
    } finally {
      await stop()
      rmSync(root, { recursive: true, force: true })
    }
  },
  900_000,
)
