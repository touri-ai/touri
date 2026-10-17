export type PsResult = { exitCode: number | null; stdout: string }

const spawnPs = (args: Array<string>) => {
  try {
    return Bun.spawn({
      cmd: ["/bin/ps", ...args],
      env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    })
  } catch {
    // A sandboxed process (macOS Seatbelt) may not be allowed to exec the setuid ps.
    return null
  }
}

/**
 * Runs `/bin/ps` without blocking the event loop.
 *
 * Never use `Bun.spawnSync` in the sidecar: Bun 1.2 keeps ticking the main event loop while a
 * synchronous child runs, so timers and HTTP/WebSocket callbacks re-enter in the middle of the
 * request that called it. uWS then parses and uncorks sockets out of order, which shows up as
 * spurious `400 Bad Request` replies and a segfault in `AsyncSocket::uncork` (#121).
 */
export const runPs = async (args: Array<string>, timeoutMs: number): Promise<PsResult | null> => {
  const child = spawnPs(args)
  if (!child) return null
  const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs)
  try {
    const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited])
    return { exitCode, stdout }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}
