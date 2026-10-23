import { afterEach, expect, test } from "bun:test"
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const roots = new Set<string>()

afterEach(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true })
  roots.clear()
})

test.each(["queued", "starting", "running"])("a %s turn defers a timed-out deployment", async (status) => {
  const result = await getRestartResult(JSON.stringify({ runs: [{ status }] }))

  expect(result.code).toBe(75)
  expect(result.stdout).not.toContain("RESTARTED")
  expect(result.stderr).toContain("ainda há tarefas em andamento")
})

test.each(["process_exited", "event_timeout"])("confirmed %s zombies do not block deployment", async (staleReason) => {
  const runs = [{ status: "running", activity: { active: false, processAlive: false, lastEventAt: 1, staleReason } }]

  const result = await getRestartResult(JSON.stringify({ runs }))

  expect(result.code).toBe(0)
  expect(result.stdout).toBe("RESTARTED\n")
})

test("a live turn still blocks deployment beside a zombie", async () => {
  const runs = [
    { status: "running", activity: { active: false } },
    { status: "running", activity: { active: true } },
  ]

  const result = await getRestartResult(JSON.stringify({ runs }))

  expect(result.code).toBe(75)
  expect(result.stdout).not.toContain("RESTARTED")
})

test.each([{}, { active: "false" }, false])("malformed activity defers safely: %j", async (activity) => {
  const result = await getRestartResult(JSON.stringify({ runs: [{ status: "running", activity }] }))

  expect(result.code).toBe(75)
  expect(result.stderr).toContain("não foi possível verificar")
})

test("terminal turns do not consume the deployment wait", async () => {
  const runs = ["succeeded", "failed", "canceled", "interrupted"].map((status) => ({ status }))

  const result = await getRestartResult(JSON.stringify({ runs }))

  expect(result.code).toBe(0)
  expect(result.stdout).toBe("RESTARTED\n")
})

test.each(["", "{}", '{"runs":[{"status":"unexpected"}]}', '{"runs":null}'])(
  "an invalid active-work response defers safely: %s",
  async (payload) => {
    const result = await getRestartResult(payload)

    expect(result.code).toBe(75)
    expect(result.stdout).not.toContain("RESTARTED")
    expect(result.stderr).toContain("não foi possível verificar")
  },
)

test("an HTTP failure defers instead of looking like an idle server", async () => {
  const result = await getRestartResult('{"runs":[]}', 22)

  expect(result.code).toBe(75)
  expect(result.stdout).not.toContain("RESTARTED")
})

const getRestartResult = async (payload: string, curlExit = 0) => {
  const root = await mkdtemp(join(tmpdir(), "touri-safe-restart-"))
  roots.add(root)
  const cookieFile = join(root, "cookie")
  const response = join(root, "response.json")
  const curl = join(root, "curl")
  await writeFile(cookieFile, "synthetic-device-cookie")
  await writeFile(response, payload)
  await writeFile(curl, '#!/bin/sh\ncat >/dev/null\ncat "$DEMO_RESPONSE"\nexit "$DEMO_CURL_EXIT"\n')
  await chmod(curl, 0o700)

  const child = Bun.spawn(
    ["bash", resolve(import.meta.dir, "../../../scripts/safe-restart.sh"), "0", "--", "printf", "RESTARTED\n"],
    {
      env: {
        PATH: `${root}:/usr/bin:/bin`,
        TOURI_DEVICE_COOKIE_FILE: cookieFile,
        DEMO_RESPONSE: response,
        DEMO_CURL_EXIT: String(curlExit),
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])

  return { stdout, stderr, code }
}
