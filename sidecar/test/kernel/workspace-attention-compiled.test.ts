import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openDatabase } from "../../src/kernel/db"

const cleanups = new Set<() => void | Promise<void>>()

afterEach(async () => {
  const pending = Array.from(cleanups).reduce<Array<() => void | Promise<void>>>(
    (tasks, task) => [task].concat(tasks),
    [],
  )
  for (const cleanup of pending) await cleanup()
  cleanups.clear()
})

test("the compiled server embeds and completes historical attention backfill", async () => {
  const root = await mkdtemp(join(tmpdir(), "touri-attention-compiled-"))
  cleanups.add(() => rm(root, { recursive: true, force: true }))
  const appData = join(root, "data")
  const database = openDatabase({ filename: join(appData, "touri.db") })
  cleanups.add(() => database.close())
  database.exec(`INSERT INTO bots(id,name,provider,home_dir,created_at,updated_at,paused,browser_enabled)
    VALUES ('bot','Synthetic','codex','.',1,1,1,0);
    INSERT INTO threads(id,bot_id,title,created_at,updated_at) VALUES ('thread','bot','Synthetic',1,1);
    INSERT INTO messages(id,thread_id,role,kind,status,parts_json,created_at,updated_at)
    VALUES ('message','thread','assistant','approval','complete',
      '[{"type":"approval","approvalId":"synthetic","decision":"pending"}]',1,1);
    DELETE FROM workspace_message_attention;
    INSERT INTO workspace_attention_backfill(id,cursor) VALUES(1,1)`)
  const binary = join(root, process.platform === "win32" ? "server.exe" : "server")
  const cli = join(import.meta.dir, "../../src/cli")

  const compiled = await Bun.build({
    entrypoints: [
      "main.ts",
      "file-io-worker-entry.ts",
      "auth-writer-worker-entry.ts",
      "atomic-download-worker-entry.ts",
      "workspace-attention-worker-entry.ts",
    ].map((file) => join(cli, file)),
    compile: { outfile: binary },
    target: "bun",
  })

  expect(compiled.success).toBe(true)
  const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null, { status: 404 }) })
  const port = listener.port
  listener.stop(true)
  if (!port) throw new Error("Synthetic listener did not allocate a port")
  const child = Bun.spawn([binary, "serve", "--port", String(port), "--data-dir", appData], {
    stdout: "pipe",
    stderr: "pipe",
  })
  cleanups.add(async () => {
    child.kill()
    await child.exited
  })
  const stdout = new Response(child.stdout).text()
  const stderr = new Response(child.stderr).text()
  const deadline = performance.now() + 15_000
  while (
    database.query("SELECT 1 FROM workspace_attention_backfill").get() &&
    performance.now() < deadline &&
    child.exitCode === null
  )
    await Bun.sleep(20)

  expect(child.exitCode).toBeNull()
  expect(database.query("SELECT 1 FROM workspace_attention_backfill").get()).toBeNull()
  expect(database.query("SELECT approval_id FROM workspace_message_attention").all()).toEqual([
    { approval_id: "synthetic" },
  ])
  const ready = Bun.file(join(appData, "run", "serve.json"))
  while (!(await ready.exists()) && performance.now() < deadline && child.exitCode === null) await Bun.sleep(20)
  expect(await ready.exists()).toBe(true)
  await Bun.sleep(100)
  child.kill("SIGTERM")
  expect(await child.exited).toBe(0)
  expect(await stdout).toContain("listening on")
  await stderr
}, 60_000)
