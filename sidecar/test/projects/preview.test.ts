import type { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import type { PreviewTarget, Project } from "@touri/contracts"
import { saveProcessOwner } from "../../src/projects/ownership"
import { createHarness, createServerFixture } from "./harness"

const waitForPreview = async (previews: PreviewTarget[]): Promise<void> => {
  const deadline = Date.now() + 5000
  while (previews.length === 0) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for an HTTP-confirmed Preview")
    await Bun.sleep(10)
  }
}

test("an unlinked bot receives the exact approval and process steps instead of Preview success", async () => {
  const harness = await createHarness()
  try {
    const previews: PreviewTarget[] = []
    const unsubscribe = harness.runtime.kernel.subscribe(({ event }) => {
      if (event.type === "preview.available") previews.push(event.preview)
    })
    const result = await harness.tool("preview_open", { port: 61488 }, null)
    expect(result).toMatchObject({ success: false, errorCode: "PROJECT_REQUIRED" })
    if (result.success) throw new Error("Unexpected Preview success")
    for (const instruction of [
      "Nenhum Preview foi criado",
      "project_link({path})",
      "aprovação explícita",
      "process_define/process_start",
      "preview_open",
      "terminal não aparece no Preview",
    ])
      expect(result.error).toContain(instruction)
    expect(previews).toEqual([])
    expect((harness.runtime.kernel.db as Database).query("SELECT id FROM projects").all()).toEqual([])
    unsubscribe()
  } finally {
    await harness.close()
  }
}, 30_000)

test("Preview success returns a published HTTP target owned by this bot; foreign and stopped processes fail", async () => {
  const harness = await createHarness()
  try {
    const response = await harness.request("/projects", {
      method: "POST",
      body: JSON.stringify({ path: harness.projectPath }),
      headers: { "Content-Type": "application/json" },
    })
    const { project } = (await response.json()) as { project: Project }
    createServerFixture({ projectPath: harness.projectPath })
    expect(
      await harness.tool(
        "process_define",
        { name: "web", command: "bun server.ts", ready: { logRegex: "READY" }, restart: "never" },
        project.id,
      ),
    ).toMatchObject({ success: true })
    const published: PreviewTarget[] = []
    const unsubscribe = harness.runtime.kernel.subscribe(({ event }) => {
      if (event.type === "preview.available") published.push(event.preview)
    })
    expect(await harness.tool("process_start", { name: "web", waitMs: 10_000 }, project.id)).toMatchObject({
      success: true,
    })
    // Log readiness precedes the asynchronous HTTP probe that publishes the target.
    await waitForPreview(published)
    const opened = await harness.tool("preview_open", { process: "web", path: "/hello" }, project.id)
    expect(opened.success).toBe(true)
    if (!opened.success) throw new Error(opened.error)
    const target = opened.structured as PreviewTarget
    expect(target.url).toBe(`http://127.0.0.1:${target.port}/hello`)
    expect(await (await fetch(target.url)).text()).toBe("ok")
    expect(published).toContainEqual(target)
    expect(opened.content).toContainEqual({
      type: "text",
      text: expect.stringContaining("Preview disponível no touri. Abra o painel Preview"),
    })
    expect(await harness.tool("preview_open", { port: target.port }, project.id)).toMatchObject({ success: true })
    published.length = 0
    for (const path of ["//example.com", "/\\example.com", "/\n/example.com", "https://example.com/"]) {
      expect(await harness.tool("preview_open", { port: target.port, path }, project.id)).toMatchObject({
        success: false,
        errorCode: "INVALID_ARGS",
      })
    }
    if (!target.processId) throw new Error("Missing process")
    saveProcessOwner(harness.runtime.kernel, target.processId, { botId: "another-bot", machine: "local" })
    for (const args of [{}, { process: "web" }, { port: target.port }]) {
      expect(await harness.tool("preview_open", args, project.id)).toMatchObject({
        success: false,
        errorCode: "PREVIEW_NOT_FOUND",
      })
    }
    expect(published).toEqual([])
    saveProcessOwner(harness.runtime.kernel, target.processId, { botId: "bot-test", machine: "local" })
    expect(await harness.tool("process_stop", { name: "web" }, project.id)).toMatchObject({ success: true })
    expect(await harness.tool("preview_open", { port: target.port }, project.id)).toMatchObject({
      success: false,
      errorCode: "PREVIEW_NOT_FOUND",
    })
    expect(published).toEqual([])
    unsubscribe()
  } finally {
    await harness.close()
  }
}, 30_000)

test("an explicitly selected listening TCP port is not a Preview until HTTP is confirmed", async () => {
  const harness = await createHarness()
  try {
    const response = await harness.request("/projects", {
      method: "POST",
      body: JSON.stringify({ path: harness.projectPath }),
      headers: { "Content-Type": "application/json" },
    })
    const { project } = (await response.json()) as { project: Project }
    writeFileSync(
      join(harness.projectPath, "tcp.ts"),
      'const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data(socket) { socket.end("not HTTP"); } } }); console.log("READY http://127.0.0.1:" + server.port); setInterval(() => {}, 1000)\n',
    )
    expect(
      await harness.tool(
        "process_define",
        { name: "tcp", command: "bun tcp.ts", ready: { logRegex: "READY" }, restart: "never" },
        project.id,
      ),
    ).toMatchObject({ success: true })
    const started = await harness.tool("process_start", { name: "tcp", waitMs: 10_000 }, project.id)
    expect(started.success).toBe(true)
    if (!started.success) throw new Error(started.error)
    const run = started.structured as { ports: Array<{ port: number }> }
    const port = run.ports[0]?.port
    expect(port).toBeGreaterThan(0)
    for (const args of [{}, { process: "tcp" }, { port }]) {
      expect(await harness.tool("preview_open", args, project.id)).toMatchObject({
        success: false,
        errorCode: "PREVIEW_NOT_FOUND",
      })
    }
    const available = (await (await harness.request(`/previews?projectId=${project.id}`)).json()) as {
      previews: PreviewTarget[]
    }
    expect(available.previews).toEqual([])
  } finally {
    await harness.close()
  }
}, 30_000)
