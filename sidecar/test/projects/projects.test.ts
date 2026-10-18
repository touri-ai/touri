import type { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { init } from "../../src/projects"
import { runCommand } from "../../src/projects/git"
import { createCrasherFixture, createHarness, createServerFixture } from "./harness"

const json = async (response: Response): Promise<Record<string, unknown>> =>
  (await response.json()) as Record<string, unknown>

const createProject = async (
  harness: Awaited<ReturnType<typeof createHarness>>,
): Promise<{ id: string; path: string }> => {
  const response = await harness.request("/projects", {
    method: "POST",
    body: JSON.stringify({ path: harness.projectPath }),
    headers: { "Content-Type": "application/json" },
  })
  expect(response.status).toBe(201)
  const body = await json(response)
  const project = body.project as { id: string; path: string }
  return project
}

const waitFor = async (predicate: () => boolean, timeoutMs = 5000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await Bun.sleep(25)
  }
  expect(predicate()).toBe(true)
}

test("projects expose routes, hints, services, and git dirty state", async () => {
  const harness = await createHarness()
  try {
    const project = await createProject(harness)
    const projects = await json(await harness.request("/projects"))
    expect(projects.projects as Array<unknown>).toHaveLength(1)
    const info = await harness.runtime.kernel.services.use("projects.info")?.({ projectId: project.id })
    expect(info?.project.path).toBe(realpathSync(harness.projectPath))
    expect(info?.hints.map((hint) => hint.value)).toEqual(
      expect.arrayContaining([">=22.12", "pnpm@10", "MongoDB", "Redis"]),
    )
    writeFileSync(join(harness.projectPath, "dirty.txt"), "dirty")
    const git = await json(await harness.request(`/projects/${project.id}/git`))
    expect(git.dirty).toBe(true)
    const serviceInfo = await harness.runtime.kernel.services.use("projects.info")?.({ projectId: project.id })
    expect(serviceInfo?.git?.dirty).toBe(true)
  } finally {
    await harness.close()
  }
}, 30_000)

test("Git commands have a deadline and cancel only their owned process", async () => {
  const harness = await createHarness()
  try {
    let killed = 0
    const result = await runCommand({
      kernel: {
        ...harness.runtime.kernel,
        shellEnv: async () => ({}),
        spawnTree: () => ({
          success: true,
          pid: 123,
          pgid: 123,
          stdout: new ReadableStream({ start: (c) => c.close() }),
          stderr: new ReadableStream({ start: (c) => c.close() }),
          stdin: new WritableStream(),
          extra: [],
          exited: new Promise(() => {}),
          kill: () => {
            killed++
          },
        }),
      },
      cmd: "git",
      args: ["clone"],
      cwd: harness.projectPath,
      timeoutMs: 20,
    })
    expect(result).toMatchObject({ success: false, error: expect.stringContaining("prazo") })
    expect(killed).toBe(1)
  } finally {
    await harness.close()
  }
}, 30000)

test("connecting an existing source is idempotent; invalid paths and clone sources explain recovery", async () => {
  const harness = await createHarness()
  try {
    const project = await createProject(harness)
    const post = (body: unknown) =>
      harness.request("/projects", {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
      })
    const again = await post({ path: harness.projectPath, name: "readonly" })
    expect(again.status).toBe(200)
    expect((await json(again)).project).toMatchObject({ id: project.id })
    const git = await json(await harness.request(`/projects/${project.id}/git`))
    expect(git.commit).toMatch(/^[a-f0-9]{40}$/)
    for (const path of ["relative/path", join(harness.root, "missing"), join(harness.projectPath, "package.json")]) {
      const response = await post({ path })
      expect(response.status).toBe(400)
      expect((await json(response)).error).toContain("pasta")
    }
    const unsupported = await post({ gitUrl: "ftp://example.test/repo", parentDir: harness.root })
    expect(unsupported.status).toBe(400)
    expect((await json(unsupported)).error).toContain("HTTPS")
    expect(existsSync(join(harness.root, "repo"))).toBe(false)
  } finally {
    await harness.close()
  }
}, 30_000)

test("process start detects a random HTTP port, publishes preview, and stops the process group", async () => {
  const harness = await createHarness()
  try {
    const project = await createProject(harness)
    createServerFixture({ projectPath: harness.projectPath })
    const defined = await harness.tool(
      "process_define",
      { name: "web", command: "bun server.ts", ready: { logRegex: "READY" }, autostart: false },
      project.id,
    )
    expect(defined.success).toBe(true)
    const started = await harness.tool("process_start", { name: "web", waitMs: 10_000 }, project.id)
    expect(started).toMatchObject({ success: true })
    if (!started.success) return
    const run = started.structured as { pid: number; pgid: number; ports: Array<{ port: number }> }
    expect(run.ports.length).toBeGreaterThan(0)
    let previews = await json(await harness.request(`/previews?projectId=${project.id}`))
    const previewDeadline = Date.now() + 10_000
    while (
      !(previews.previews as Array<{ url: string }>).some((preview) => preview.url.startsWith("http://127.0.0.1:")) &&
      Date.now() < previewDeadline
    ) {
      await Bun.sleep(25)
      previews = await json(await harness.request(`/previews?projectId=${project.id}`))
    }
    expect(
      (previews.previews as Array<{ url: string }>).some((preview) => preview.url.startsWith("http://127.0.0.1:")),
    ).toBe(true)
    const opened = await harness.tool("preview_open", { path: "/health" }, project.id)
    expect(opened.success).toBe(true)
    const stopped = await harness.tool("process_stop", { name: "web" }, project.id)
    expect(stopped.success).toBe(true)
    expect(Bun.spawnSync({ cmd: ["pgrep", "-g", String(run.pgid)], stdout: "pipe", stderr: "pipe" }).exitCode).not.toBe(
      0,
    )
    const grouped = await harness.tool("process_define", { name: "grouped", command: "sleep 30 & wait" }, project.id)
    expect(grouped.success).toBe(true)
    const groupStart = await harness.tool("process_start", { name: "grouped", waitMs: 5000 }, project.id)
    expect(groupStart.success).toBe(true)
    if (!groupStart.success) return
    const groupRun = groupStart.structured as { pgid: number }
    expect(
      Bun.spawnSync({ cmd: ["pgrep", "-g", String(groupRun.pgid)], stdout: "pipe", stderr: "pipe" }).exitCode,
    ).toBe(0)
    await harness.tool("process_stop", { name: "grouped" }, project.id)
    expect(
      Bun.spawnSync({ cmd: ["pgrep", "-g", String(groupRun.pgid)], stdout: "pipe", stderr: "pipe" }).exitCode,
    ).not.toBe(0)
  } finally {
    await harness.close()
  }
}, 30_000)

test("process dependencies are ordered and cycles are rejected", async () => {
  const harness = await createHarness()
  try {
    const project = await createProject(harness)
    const first = await harness.tool(
      "process_define",
      { name: "first", command: "touch dependency-marker; exec sleep 30" },
      project.id,
    )
    expect(first.success).toBe(true)
    const second = await harness.tool(
      "process_define",
      { name: "second", command: "test -f dependency-marker && exec sleep 30", dependsOn: ["first"] },
      project.id,
    )
    expect(second.success).toBe(true)
    const started = await harness.tool("process_start", { name: "second", waitMs: 10_000 }, project.id)
    expect(started).toMatchObject({ success: true })
    expect(existsSync(join(harness.projectPath, "dependency-marker"))).toBe(true)
    const cycle = await harness.tool(
      "process_define",
      { name: "first", command: "sh mark.sh", dependsOn: ["second"] },
      project.id,
    )
    expect(cycle).toMatchObject({ success: false, errorCode: "PROCESS_CYCLE" })
  } finally {
    await harness.close()
  }
}, 30_000)

test("crash restart policy stops after five failures and orphan cleanup restarts autostart processes", async () => {
  const previousBackoff = process.env.TOURI_TEST_PROCESS_BACKOFF_MS
  process.env.TOURI_TEST_PROCESS_BACKOFF_MS = "10"
  const harness = await createHarness()
  try {
    const project = await createProject(harness)
    createCrasherFixture({ projectPath: harness.projectPath })
    expect(
      (
        await harness.tool(
          "process_define",
          { name: "crasher", command: "bun crasher.ts", restart: "on-failure" },
          project.id,
        )
      ).success,
    ).toBe(true)
    await harness.tool("process_start", { name: "crasher", waitMs: 100 }, project.id)
    const database = harness.runtime.kernel.db as Database
    await waitFor(() => {
      const row = database
        .query(
          "SELECT count(*) AS count FROM process_runs WHERE process_id = (SELECT id FROM processes WHERE name = 'crasher')",
        )
        .get() as { count: number }
      return row.count >= 5
    }, 3000)
    const crashCount = database
      .query(
        "SELECT count(*) AS count FROM process_runs WHERE process_id = (SELECT id FROM processes WHERE name = 'crasher')",
      )
      .get() as { count: number }
    expect(crashCount.count).toBe(5)

    createServerFixture({ projectPath: harness.projectPath })
    const defined = await harness.tool(
      "process_define",
      // The previous supervisor is still alive in this harness. A real restart
      // leaves no old monitor to race the new supervisor's autostart.
      { name: "autoweb", command: "bun server.ts", autostart: true, restart: "never", ready: { logRegex: "READY" } },
      project.id,
    )
    expect(defined.success).toBe(true)
    await harness.tool("process_start", { name: "autoweb", waitMs: 5000 }, project.id)
    const before = database
      .query(
        "SELECT count(*) AS count FROM process_runs WHERE process_id = (SELECT id FROM processes WHERE name = 'autoweb')",
      )
      .get() as { count: number }
    const previous = database
      .query(
        "SELECT pid FROM process_runs WHERE process_id = (SELECT id FROM processes WHERE name = 'autoweb') AND status IN ('running','ready')",
      )
      .get() as { pid: number }
    await init(harness.runtime.kernel)
    await waitFor(() => {
      try {
        process.kill(previous.pid, 0)
        return false
      } catch {
        return true
      }
    })
    await waitFor(() => {
      const row = database
        .query(
          "SELECT count(*) AS count FROM process_runs WHERE process_id = (SELECT id FROM processes WHERE name = 'autoweb')",
        )
        .get() as { count: number }
      return row.count > before.count
    }, 5000)
    const statuses = database
      .query(
        "SELECT status FROM process_runs WHERE process_id = (SELECT id FROM processes WHERE name = 'autoweb') ORDER BY started_at",
      )
      .all() as Array<{ status: string }>
    expect(statuses).toEqual([{ status: "stopped" }, { status: "ready" }])
  } finally {
    await harness.close()
    if (previousBackoff === undefined) delete process.env.TOURI_TEST_PROCESS_BACKOFF_MS
    else process.env.TOURI_TEST_PROCESS_BACKOFF_MS = previousBackoff
  }
}, 30_000)

test("secrets never leave the host, env files require git-ignore, values are redacted, and paths cannot escape", async () => {
  const harness = await createHarness()
  try {
    const project = await createProject(harness)
    const secretRoute = await harness.request(`/projects/${project.id}/secrets/API_KEY`, {
      method: "PUT",
      body: JSON.stringify({ usage: { env: true, browser: false } }),
      headers: { "Content-Type": "application/json" },
    })
    expect(secretRoute.status).toBe(200)
    harness.host.keychain.set(`${project.id}/API_KEY`, "hunter2-secret")
    const listed = await harness.tool("secret_list", {}, project.id)
    expect(JSON.stringify(listed)).not.toContain("hunter2-secret")
    expect([...harness.host.keychain.values()]).toContain("hunter2-secret")
    harness.host.methods["secret.prompt"] = async () => ({ values: { API_KEY: "prompted-secret" } })
    const requested = await harness.tool(
      "secret_request",
      { name: "API_KEY", reason: "Configure the fixture" },
      project.id,
    )
    expect(requested.success).toBe(true)
    expect(JSON.stringify(requested)).not.toContain("prompted-secret")
    expect(harness.host.keychain.get(`${project.id}/API_KEY`)).toBe("prompted-secret")
    const notIgnored = await harness.tool(
      "env_write_file",
      { path: "plain.env", entries: { API_KEY: { secret: "API_KEY" } } },
      project.id,
    )
    expect(notIgnored).toMatchObject({ success: false, errorCode: "NOT_GITIGNORED" })
    const written = await harness.tool(
      "env_write_file",
      { path: ".env", entries: { API_KEY: { secret: "API_KEY" }, MODE: "development" } },
      project.id,
    )
    expect(written.success).toBe(true)
    expect(JSON.stringify(written)).not.toContain("hunter2-secret")
    expect(readFileSync(join(harness.projectPath, ".env"), "utf8")).toContain("API_KEY=prompted-secret")
    expect(lstatSync(join(harness.projectPath, ".env")).mode & 0o777).toBe(0o600)
    const outside = join(harness.root, "outside.env")
    writeFileSync(outside, "outside")
    symlinkSync(outside, join(harness.projectPath, "linked.env"))
    expect(
      await harness.tool("env_write_file", { path: "../outside.env", entries: { X: "value" } }, project.id),
    ).toMatchObject({ success: false, errorCode: "PATH_OUTSIDE_PROJECT" })
    expect(
      await harness.tool("env_write_file", { path: "linked.env", entries: { X: "value" } }, project.id),
    ).toMatchObject({ success: false, errorCode: "PATH_OUTSIDE_PROJECT" })

    const logProcess = await harness.tool(
      "process_define",
      {
        name: "secret-log",
        command: "printf '%s\\n' \"$API_KEY\"; exec sleep 30",
        env: { API_KEY: { secret: "API_KEY" } },
        ready: { logRegex: "REDACTED" },
      },
      project.id,
    )
    expect(logProcess.success).toBe(true)
    const started = await harness.tool("process_start", { name: "secret-log", waitMs: 5000 }, project.id)
    expect(started.success).toBe(true)
    const logs = await harness.tool("process_logs", { name: "secret-log" }, project.id)
    expect(JSON.stringify(logs)).toContain("[REDACTED]")
    expect(JSON.stringify(logs)).not.toContain("hunter2-secret")
  } finally {
    await harness.close()
  }
}, 30_000)

test("clone local bare repository and process logs are available through routes", async () => {
  const harness = await createHarness()
  try {
    const source = join(harness.root, "source")
    const bare = join(harness.root, "source.git")
    const parent = join(harness.root, "clones")
    mkdirSync(source)
    mkdirSync(parent)
    writeFileSync(join(source, "README.md"), "fixture")
    const run = (args: Array<string>, cwd: string): void => {
      const result = Bun.spawnSync({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "pipe" })
      if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr))
    }
    run(["init", "-q"], source)
    run(["config", "user.email", "test@example.com"], source)
    run(["config", "user.name", "Test"], source)
    run(["add", "."], source)
    run(["commit", "-qm", "fixture"], source)
    run(["clone", "--bare", source, bare], harness.root)
    const response = await harness.request("/projects", {
      method: "POST",
      body: JSON.stringify({ gitUrl: bare, parentDir: parent }),
      headers: { "Content-Type": "application/json" },
    })
    expect(response.status).toBe(201)
    const body = await json(response)
    const project = body.project as { path: string }
    expect(existsSync(join(project.path, "README.md"))).toBe(true)
    expect(readFileSync(join(project.path, "README.md"), "utf8")).toBe("fixture")
  } finally {
    await harness.close()
  }
}, 30_000)

test("project tools that return lists expose structuredContent as an object", async () => {
  const harness = await createHarness()
  try {
    const project = await createProject(harness)
    await harness.tool("process_define", { name: "lister", command: "sleep 30" }, project.id)
    const listed = await harness.tool("process_list", {}, project.id)
    const logs = await harness.tool("process_logs", { name: "lister" }, project.id)
    const names = await harness.tool("secret_list", {}, project.id)
    const info = await harness.tool("project_info", {}, project.id)
    for (const result of [listed, logs, names, info]) {
      expect(result.success).toBe(true)
      if (!result.success) return
      expect(typeof result.structured).toBe("object")
      expect(Array.isArray(result.structured)).toBe(false)
    }
    if (listed.success) expect(Array.isArray((listed.structured as { processes: unknown }).processes)).toBe(true)
  } finally {
    await harness.close()
  }
})
