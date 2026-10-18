import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

type Step = {
  name?: string
  run?: string
  uses?: string
  if?: string
  "continue-on-error"?: boolean
  with?: { name?: string; path?: string }
}

const root = fileURLToPath(new URL("../../../", import.meta.url))
const workflow = Bun.YAML.parse(
  readFileSync(new URL("../../../.github/workflows/ci.yml", import.meta.url), "utf8"),
) as {
  jobs: { linux: { steps: Step[] } }
}
const steps = workflow.jobs.linux.steps
const requiredRun = (name: string): string => {
  const step = steps.find((step) => step.name === name)
  if (!step?.run) throw new Error(`Missing CI step: ${name}`)
  return step.run
}

test("Linux CI requires a real sandbox before the full suite and preserves native builds and artifacts", () => {
  expect(requiredRun("Install Linux build dependencies")).toMatch(/apt-get install[^\n]*\bbubblewrap\b/)
  const ordered = [
    requiredRun("Install Linux build dependencies"),
    requiredRun("Allow unprivileged namespaces for sandbox tests"),
    "bun install --frozen-lockfile",
    requiredRun("Require Linux folder sandbox"),
    "bun run typecheck",
    "bun run lint",
    "bun test --timeout 30000 sidecar/test",
    "bun run build:sidecar:linux",
    "cargo fmt --manifest-path src-tauri/Cargo.toml --check",
    "cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings",
    "dbus-run-session -- bash scripts/test-native-linux.sh",
    "bun run test:sidecar:smoke",
    "bunx tauri build --bundles appimage,deb",
  ]
  let previous = -1
  for (const run of ordered) {
    const index = steps.findIndex((step) => step.run === run)
    expect(index).toBeGreaterThan(previous)
    expect(steps[index]?.if).toBeUndefined()
    expect(steps[index]?.["continue-on-error"]).not.toBe(true)
    previous = index
  }
  const artifact = steps.findIndex((step) => step.uses === "actions/upload-artifact@v4")
  expect(artifact).toBeGreaterThan(previous)
  expect(steps[artifact]?.with).toMatchObject({ name: "touri-linux-x64" })
  expect(steps[artifact]?.with?.path).toContain("src-tauri/target/release/bundle/appimage/*.AppImage")
  expect(steps[artifact]?.with?.path).toContain("src-tauri/target/release/bundle/deb/*.deb")
})

test.skipIf(process.platform === "win32").each([
  { name: "restricted AppArmor", available: 0, writeExit: 0, exit: 0, writes: true },
  { name: "no AppArmor sysctl", available: 1, writeExit: 0, exit: 0, writes: false },
  { name: "permission change denied", available: 0, writeExit: 1, exit: 1, writes: true },
])("CI namespace setup handles $name without hiding failures", ({ available, writeExit, exit, writes }) => {
  const dir = mkdtempSync(join(tmpdir(), "touri-ci-sandbox-"))
  const log = join(dir, "sysctl.log")
  try {
    writeFileSync(
      join(dir, "sysctl"),
      '#!/bin/sh\nprintf "%s\\n" "$*" >> "$TOURI_CI_LOG"\nif [ "$1" = "-w" ]; then exit "$TOURI_CI_WRITE_EXIT"; fi\nexit "$TOURI_CI_SYSCTL_EXIT"\n',
      { mode: 0o700 },
    )
    writeFileSync(join(dir, "sudo"), '#!/bin/sh\nexec "$@"\n', { mode: 0o700 })
    const result = Bun.spawnSync({
      cmd: ["/bin/bash", "-e", "-o", "pipefail", "-c", requiredRun("Allow unprivileged namespaces for sandbox tests")],
      env: {
        ...process.env,
        PATH: `${dir}:/usr/bin:/bin`,
        TOURI_CI_LOG: log,
        TOURI_CI_SYSCTL_EXIT: String(available),
        TOURI_CI_WRITE_EXIT: String(writeExit),
      },
    })
    expect(result.exitCode).toBe(exit)
    expect(readFileSync(log, "utf8").trim().split("\n")).toEqual([
      "kernel.apparmor_restrict_unprivileged_userns",
      ...(writes ? ["-w kernel.apparmor_restrict_unprivileged_userns=0"] : []),
    ])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test.skipIf(process.platform !== "linux").each([0, 1])(
  "CI uses the production capability probe and propagates namespace exit %i",
  (probeExit) => {
    const probe = requiredRun("Require Linux folder sandbox").match(/^\s*bun -e '([\s\S]*)'\s*$/)?.[1]
    expect(probe).toContain('from "./sidecar/src/kernel/folder-capability"')
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        "-e",
        `Bun.which = () => "/usr/bin/bwrap";
         Bun.spawn = (input) => {
           if (!input.cmd.includes("--unshare-user") || !input.cmd.includes("--unshare-pid")) {
             throw new Error("The capability probe must exercise user and PID namespaces");
           }
           return { exited: Promise.resolve(${probeExit}), kill() {} };
         };
         ${probe}`,
      ],
      cwd: root,
    })
    expect(result.exitCode).toBe(probeExit)
    if (probeExit !== 0)
      expect(result.stderr.toString()).toContain("Linux CI requires working bubblewrap user and PID namespaces")
  },
)
