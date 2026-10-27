import { expect, mock, test } from "bun:test"
import { getBrowserSandboxCheck } from "../../src/cli/browserSandboxCheck"

test("doctor warns about an explicit sandbox opt-out without probing namespaces", async () => {
  const run = mock(async () => ({ code: 0, stdout: "", stderr: "" }))

  const check = await getBrowserSandboxCheck({ env: { TOURI_BROWSER_NO_SANDBOX: "1" }, platform: "linux", run })

  expect(check.level).toBe("warn")
  expect(check.detail).toContain("credenciais")
  expect(run).not.toHaveBeenCalled()
})

test("doctor diagnoses denied namespaces without printing subprocess output", async () => {
  const run = mock(async () => ({ code: 1, stdout: "", stderr: "private diagnostic" }))

  const check = await getBrowserSandboxCheck({ env: {}, platform: "linux", run })

  expect(check.level).toBe("warn")
  expect(check.detail).toContain("hostUsers: false")
  expect(check.detail).not.toContain("private diagnostic")
  expect(run).toHaveBeenCalledWith("unshare", ["--user", "--map-root-user", "--net", "true"])
})

test("doctor leaves other platforms alone and recognizes a successful Linux probe", async () => {
  const run = mock(async () => ({ code: 0, stdout: "", stderr: "" }))

  const desktop = await getBrowserSandboxCheck({ env: {}, platform: "darwin", run })
  const linux = await getBrowserSandboxCheck({ env: {}, platform: "linux", run })

  expect(desktop.level).toBe("ok")
  expect(linux.level).toBe("ok")
  expect(run).toHaveBeenCalledTimes(1)
})
