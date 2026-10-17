import { expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import type { ApprovalPart, Bot, Message, Run } from "@touri/contracts"

// Opt-in: uses the signed-in local provider, a compiled sidecar, and disposable data.
test.skipIf(process.platform !== "linux" || process.env.TOURI_LIVE_FOLDER_QA !== "1")(
  "live Linux provider survives RO and RW approvals and a server restart",
  async () => {
    const binary = process.env.TOURI_LIVE_SIDECAR
    if (!binary) throw new Error("Set TOURI_LIVE_SIDECAR to the compiled sidecar")
    const data = mkdtempSync(join(tmpdir(), "touri-folder-live-"))
    const workspace = mkdtempSync(join(homedir(), "touri-folder-live-"))
    const marker = `read-proof-${randomUUID()}`
    const folder = join(workspace, "reference")
    mkdirSync(folder)
    writeFileSync(join(folder, "reference.txt"), marker)
    let child: ReturnType<typeof Bun.spawn> | undefined
    let address = ""
    let token = ""
    const approvals: Array<{ mode: string; decision: string }> = []
    const log = process.env.TOURI_LIVE_LOG ? openSync(process.env.TOURI_LIVE_LOG, "w", 0o600) : undefined
    const start = async () => {
      const handshake = join(data, "run/handshake.json")
      rmSync(handshake, { force: true })
      child = Bun.spawn([binary, "serve"], {
        env: { ...process.env, TOURI_APP_DATA: data, TOURI_HEADLESS: "1" },
        stdin: "pipe",
        stdout: "ignore",
        stderr: log ?? "ignore",
      })
      const deadline = Date.now() + 30_000
      while (!existsSync(handshake)) {
        if (Date.now() > deadline || child.exitCode !== null) throw new Error("Live server did not start")
        await Bun.sleep(50)
      }
      const info = JSON.parse(readFileSync(handshake, "utf8")) as { port: number; token: string }
      address = `http://127.0.0.1:${info.port}/api/v1`
      token = info.token
      // The private handshake is written before modules register their routes.
      while (
        !(await request("/routines")
          .then(() => true)
          .catch(() => false))
      ) {
        if (Date.now() > deadline || child.exitCode !== null) throw new Error("Live routes did not become ready")
        await Bun.sleep(50)
      }
    }
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
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      if (!response.ok)
        throw new Error(
          `Live API failed: ${method} ${path.replace(/\/[A-Z0-9]{26}/g, "/:id")} (${response.status}): ${await response.text()}`,
        )
      return (await response.json()) as T
    }
    const stop = async () => {
      child?.kill("SIGTERM")
      await child?.exited
      child = undefined
    }
    try {
      await start()
      expect((await request<{ canGrant: boolean }>(`/folders?path=${encodeURIComponent(workspace)}`)).canGrant).toBe(
        true,
      )
      const created = await request<{ path: string }>("/folders", { path: workspace, name: "output" })
      expect(existsSync(created.path)).toBe(true)
      const { bot } = await request<{ bot: Bot }>("/bots", {
        name: "Arquivos",
        provider: "codex",
        approvals: "on-request",
        access: "workspace-write",
        instructions:
          "Execute as solicitações usando as ferramentas disponíveis. Não invente resultados. Use folder_access_request quando for necessário. Depois da aprovação, encerre o turno para a continuação automática.",
      })
      const thread = bot.mainThreadId
      if (!thread) throw new Error("Live bot has no main thread")
      const messages = () =>
        request<{ messages: Message[]; activeLeafId: string | null }>(`/threads/${thread}/messages`)
      const send = async (text: string, decision: "approved" | "denied" = "approved") => {
        const previous = await messages()
        const { run } = await request<{ run: Run }>(`/threads/${thread}/messages`, {
          threadId: thread,
          parentId: previous.activeLeafId,
          text,
          attachmentIds: [],
        })
        const deadline = Date.now() + 180_000
        let settled = 0
        while (Date.now() < deadline) {
          const history = await messages()
          const pending = history.messages.flatMap((message) =>
            message.parts.filter(
              (part): part is ApprovalPart => part.type === "approval" && part.decision === "pending",
            ),
          )
          for (const card of pending) {
            const jsonStart = card.detail.indexOf("{")
            const detail = JSON.parse(jsonStart >= 0 ? card.detail.slice(jsonStart) : "{}") as { mode?: string }
            if (detail.mode === "read-write") expect(existsSync(join(folder, "saved.txt"))).toBe(false)
            approvals.push({ mode: detail.mode ?? card.scope?.tool ?? "command", decision })
            await request(`/approvals/${card.approvalId}`, { decision })
          }
          const { runs } = await request<{ runs: Run[] }>(`/threads/${thread}/runs`)
          const relevant = runs.filter((item) => item.queuedAt >= run.queuedAt)
          if (relevant.some((item) => item.status === "failed" || item.status === "interrupted")) {
            writeFileSync(join(data, "failure.json"), JSON.stringify({ runs: relevant, messages: history.messages }), {
              mode: 0o600,
            })
            throw new Error(
              `Live turn failed: ${relevant.find((item) => item.status === "failed")?.errorClass ?? "interrupted"}`,
            )
          }
          if (relevant.length && relevant.every((item) => item.status === "succeeded") && !pending.length) {
            settled ||= Date.now()
            if (Date.now() - settled > 1500)
              return history.messages.filter((message) => message.createdAt >= run.queuedAt)
          } else settled = 0
          await Bun.sleep(100)
        }
        throw new Error("Live provider turn exceeded its deadline")
      }
      const read = await send(
        `Solicite acesso somente de leitura com folder_access_request à pasta ${JSON.stringify(folder)}. Depois da aprovação e retomada automática, leia reference.txt e mostre o conteúdo exato.`,
      )
      expect(approvals.some((item) => item.mode === "read" && item.decision === "approved")).toBe(true)
      expect(read.some((message) => message.role === "assistant" && message.text.includes(marker))).toBe(true)
      const blocked = join(folder, "blocked.txt")
      const blockedMessages = await send(
        `Tente uma única vez escrever "blocked" no arquivo ${JSON.stringify(blocked)} usando printf no terminal. O teste deve mostrar a recusa de escrita pelo sistema. Não solicite upgrade, não use outra pasta e não repita a escrita.`,
        "denied",
      )
      expect(existsSync(blocked)).toBe(false)
      expect(
        blockedMessages.some((message) =>
          message.parts.some((part) => part.type === "command" && part.exitCode !== null && part.exitCode !== 0),
        ),
      ).toBe(true)
      const saved = join(folder, "saved.txt")
      await send(
        `Solicite acesso de leitura e escrita à pasta ${JSON.stringify(folder)} usando folder_access_request. Após a aprovação e retomada automática, crie ${JSON.stringify(saved)} com o conteúdo exato "saved-proof".`,
      )
      expect(approvals.some((item) => item.mode === "read-write" && item.decision === "approved")).toBe(true)
      expect(readFileSync(saved, "utf8")).toBe("saved-proof")
      const beforeRestart = await send("oi. Responda apenas: Oi! Não use ferramentas.")
      expect(beforeRestart.some((message) => message.role === "assistant" && message.text.includes("Oi!"))).toBe(true)
      await stop()
      await start()
      const greeting = await send("oi. Responda apenas: Oi! Não use ferramentas.")
      expect(greeting.some((message) => message.role === "assistant" && message.text.includes("Oi!"))).toBe(true)
      console.log(
        "Live Linux: picker/create, RO approval/read, blocked RO write, RW approval/write, restart/greeting: passed",
      )
    } finally {
      await stop()
      rmSync(workspace, { recursive: true, force: true })
      rmSync(data, { recursive: true, force: true })
      if (log !== undefined) closeSync(log)
    }
  },
  600_000,
)
