import { expect, test } from "bun:test"

// The policy runs in a standalone operational process, never in a live sidecar callback.
test("offline watchdog respects routine deadlines and cancellation outcomes", async () => {
  const child = Bun.spawn(["python3", "-B", "scripts/test_watchdog_policy.py"], {
    cwd: new URL("../../..", import.meta.url).pathname,
    timeout: 4000,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])

  expect({ code, output: stdout + stderr }).toEqual({
    code: 0,
    output: expect.stringContaining("OK"),
  })
})
