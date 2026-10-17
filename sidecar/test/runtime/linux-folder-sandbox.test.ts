import { afterEach, expect, spyOn, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Kernel, StartTurnArgs } from "@touri/contracts"
import { refreshHostFolderAccess } from "../../src/kernel/folder-capability"
import { linuxFolderSandbox } from "../../src/runtime/linux-folder-sandbox"

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})
const available = process.platform === "linux" && (await refreshHostFolderAccess())

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "touri-linux-folders-"))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const home = join(root, "home")
  const appData = join(home, "app")
  const runDir = join(appData, "run")
  const workspace = join(appData, "bots/current")
  const ro = join(home, "reference")
  const rw = join(home, "output")
  const providerHome = join(appData, "provider/current")
  for (const path of [
    runDir,
    workspace,
    ro,
    rw,
    providerHome,
    join(home, ".ssh"),
    join(appData, "bots/other"),
    join(runDir, "turn-temp"),
  ])
    mkdirSync(path, { recursive: true })
  writeFileSync(join(ro, "reference.txt"), "reference")
  writeFileSync(join(appData, "credential"), "private")
  writeFileSync(join(appData, "bots/other/memory"), "private")
  writeFileSync(join(home, ".ssh/key"), "private")
  const kernel = { paths: { appData, runDir } } as Kernel
  const args = {
    bot: {
      provider: "codex",
      machine: "local",
      homeDir: workspace,
      access: "workspace-write",
      folders: [
        { path: ro, access: "read-only" },
        { path: rw, access: "read-write" },
      ],
    },
    thread: { id: "current-thread" },
    fingerprint: { cwd: workspace },
    env: { HOME: home, CODEX_HOME: providerHome, TMPDIR: join(runDir, "turn-temp") },
  } as unknown as StartTurnArgs
  const shell = (script: string, ...values: string[]) =>
    Bun.spawnSync({
      cmd: [
        "/usr/bin/bwrap",
        ...linuxFolderSandbox(kernel, args, args.env, home),
        "--",
        "/bin/sh",
        "-c",
        script,
        "test",
        ...values,
      ],
      cwd: workspace,
      env: args.env,
      timeout: 5000,
    })
  return { root, home, appData, workspace, ro, rw, kernel, args, shell }
}

test.skipIf(!available)(
  "Linux permits granted reads and writes but RO wins over full access and shell approvals",
  () => {
    const f = fixture()
    for (const access of ["workspace-write", "full"] as const) {
      f.args.bot.access = access
      expect(f.shell('cat "$1"', join(f.ro, "reference.txt")).stdout.toString()).toBe("reference")
      const denied = f.shell('printf changed > "$1"', join(f.ro, "reference.txt"))
      expect(denied.exitCode).not.toBe(0)
      expect(readFileSync(join(f.ro, "reference.txt"), "utf8")).toBe("reference")
      expect(f.shell('printf saved > "$1"', join(f.rw, "saved.txt")).exitCode).toBe(0)
      expect(readFileSync(join(f.rw, "saved.txt"), "utf8")).toBe("saved")
    }
  },
)

test.skipIf(!available)(
  "Linux hides API credentials and other bots while this bot and its runtime remain usable",
  () => {
    const f = fixture()
    expect(
      f.shell(
        'printf memory > "$1"; printf temp > "$TMPDIR/probe"; printf state > "$CODEX_HOME/state"',
        join(f.workspace, "memory"),
      ).exitCode,
    ).toBe(0)
    for (const path of [join(f.appData, "credential"), join(f.appData, "bots/other/memory"), join(f.home, ".ssh/key")])
      expect(f.shell('cat "$1"', path).exitCode).not.toBe(0)
    f.args.bot.anyFolderAccess = true
    expect(f.shell('cat "$1"', join(f.appData, "credential")).exitCode).not.toBe(0)
    expect(f.shell('printf bad > "$1"', join(f.ro, "reference.txt")).exitCode).not.toBe(0)
  },
)

test.skipIf(!available)("Linux read-only bot keeps user files immutable and runtime writable", () => {
  const f = fixture()
  f.args.bot.access = "read-only"
  expect(f.shell('printf state > "$CODEX_HOME/state"').exitCode).toBe(0)
  for (const path of [join(f.rw, "bad"), join(f.workspace, "bad")]) {
    expect(f.shell('printf bad > "$1"', path).exitCode).not.toBe(0)
    expect(existsSync(path)).toBe(false)
  }
})

test.skipIf(!available)(
  "Linux keeps a temporary MCP executable readable without exposing other temporary files",
  () => {
    const f = fixture()
    const executable = join(f.root, "mcp-helper")
    writeFileSync(executable, "#!/bin/sh\nprintf helper-ready", { mode: 0o700 })
    f.args.mcp = { command: executable, args: [], env: {} }
    expect(f.shell('"$1"', executable).stdout.toString()).toBe("helper-ready")
    expect(f.shell('printf bad > "$1"', executable).exitCode).not.toBe(0)
  },
)

test.skipIf(!available)(
  "Linux confines subprocesses, symlink writes, process-root aliases and remount attempts",
  () => {
    const f = fixture()
    // Create the link inside the namespace, after the grant's validation.
    expect(
      f.shell(
        'ln -s "$1" "$2/link"; /bin/sh -c \'printf bad > "$1/link"\' test "$2"',
        join(f.ro, "reference.txt"),
        f.rw,
      ).exitCode,
    ).not.toBe(0)
    rmSync(join(f.rw, "link"))
    expect(f.shell('printf bad > "/proc/self/root$1"', join(f.ro, "reference.txt")).exitCode).not.toBe(0)
    expect(f.shell('mount -o remount,rw "$1"', f.ro).exitCode).not.toBe(0)
    expect(
      f.shell(
        'unshare -Urnm -- /bin/sh -c \'mount -o remount,rw "$1" && printf bad > "$1/reference.txt"\' test "$1"',
        f.ro,
      ).exitCode,
    ).not.toBe(0)
    expect(readFileSync(join(f.ro, "reference.txt"), "utf8")).toBe("reference")
    symlinkSync(f.ro, join(f.rw, "escape"))
    expect(() => linuxFolderSandbox(f.kernel, f.args, f.args.env, f.home)).toThrow()
  },
)

test.skipIf(!available)(
  "a RO home grant keeps managed bookkeeping writable and ignores unrelated provider environment",
  () => {
    const f = fixture()
    f.args.bot.folders = [{ path: f.home, access: "read-only" }]
    f.args.env.XDG_DATA_HOME = f.home
    expect(f.shell('printf state > "$CODEX_HOME/state"').exitCode).toBe(0)
    expect(f.shell('printf bad > "$1"', join(f.ro, "reference.txt")).exitCode).not.toBe(0)
    expect(f.shell('cat "$1"', join(f.appData, "credential")).exitCode).not.toBe(0)
  },
)

test("Linux capability fails closed when namespaces are unavailable even with bwrap installed", async () => {
  if (process.platform !== "linux") return
  const probe = spyOn(Bun, "spawn").mockImplementation(() => {
    throw new Error("namespaces unavailable")
  })
  try {
    expect(await refreshHostFolderAccess()).toBe(false)
  } finally {
    probe.mockRestore()
  }
})
