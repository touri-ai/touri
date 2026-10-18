import { afterEach, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
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
const fixtureRoot = join(tmpdir(), `touri-ci-sandbox-${randomUUID()}`)
const workflow = Bun.YAML.parse(
  readFileSync(new URL("../../../.github/workflows/ci.yml", import.meta.url), "utf8"),
) as { jobs: { linux: { steps: Step[] } } }
const steps = workflow.jobs.linux.steps

afterEach(() => rmSync(fixtureRoot, { recursive: true, force: true }))

test("Linux CI verifies confinement before both suite selections and preserves native builds and artifacts", () => {
  const setup = getRequiredStep((step) => step.uses === "./.github/actions/setup-bun")
  const dependencies = getRequiredStep((step) => step.name === "Install Linux dependencies")
  const confinement = getRequiredStep((step) => step.name === "Verify Linux folder confinement")
  const fullSuite = getRunStep("bun test --timeout 30000 sidecar/test")
  const platformSuite = getRunStep("bun .github/ci/sidecar-tests.ts linux")
  const build = getRunStep("bun run build:sidecar:linux")
  const native = [
    getRunStep("cargo fmt --manifest-path src-tauri/Cargo.toml --check"),
    getRunStep("cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings"),
    getRunStep("dbus-run-session -- bash scripts/test-native-linux.sh"),
  ]
  const smoke = getRunStep("bun run test:sidecar:smoke")
  const packaging = getRunStep("bunx tauri build --bundles appimage,deb")
  const artifact = getRequiredStep((step) => step.uses?.startsWith("actions/upload-artifact@") === true)
  const ordered = [
    setup,
    dependencies,
    getRunStep("bun run typecheck"),
    getRunStep("bun run lint"),
    confinement,
    fullSuite,
    platformSuite,
    build,
  ].concat(native, [smoke, packaging, artifact])
  const indices = ordered.map((step) => steps.indexOf(step))
  const setupAction = Bun.YAML.parse(
    readFileSync(new URL("../../../.github/actions/setup-bun/action.yml", import.meta.url), "utf8"),
  ) as { runs: { steps: Step[] } }

  expect(indices.every((index, position) => index > (indices[position - 1] ?? -1))).toBe(true)
  ordered.forEach((step) => {
    expect(step["continue-on-error"]).not.toBe(true)
  })
  const unconditional = [setup, dependencies, confinement, smoke]
  unconditional.forEach((step) => {
    expect(step.if).toBeUndefined()
  })
  expect(dependencies.run).toContain("packages=(bubblewrap)")
  expect(dependencies.run).toMatch(/apt-get[^\n]*install -y "\$\{packages\[@\]\}"/)
  expect(setupAction.runs.steps.some((step) => step.run === "bun install --frozen-lockfile" && !step.if)).toBe(true)
  expect(fullSuite.if).toBe("github.event_name != 'pull_request'")
  expect(platformSuite.if).toBe("github.event_name == 'pull_request'")
  expect(build.if).toBe("steps.sidecar-binary.outputs.cache-hit != 'true'")
  native.forEach((step) => {
    expect(step.if).toBe("needs.changes.outputs.native == 'true'")
  })
  expect(packaging.if).toBe("github.event_name != 'pull_request'")
  expect(artifact.if).toBe(packaging.if)
  expect(artifact.with).toMatchObject({ name: "touri-linux-x64" })
  expect(artifact.with?.path).toContain("src-tauri/target/release/bundle/appimage/*.AppImage")
  expect(artifact.with?.path).toContain("src-tauri/target/release/bundle/deb/*.deb")
})

const namespaceCases = [
  { name: "restricted AppArmor", available: 0, writeExit: 0, exit: 0, writes: true },
  { name: "no AppArmor sysctl", available: 1, writeExit: 0, exit: 0, writes: false },
  { name: "permission change denied", available: 0, writeExit: 1, exit: 1, writes: true },
]

namespaceCases.forEach(({ name, available, writeExit, exit, writes }) => {
  test.skipIf(process.platform === "win32")(`CI namespace setup handles ${name} without hiding failures`, () => {
    const log = makeNamespaceFixture()

    const result = Bun.spawnSync({
      cmd: ["/bin/bash", "-e", "-o", "pipefail", "-c", getConfinementScripts().setup],
      env: {
        PATH: `${fixtureRoot}:/usr/bin:/bin`,
        TOURI_CI_LOG: log,
        TOURI_CI_SYSCTL_EXIT: String(available),
        TOURI_CI_WRITE_EXIT: String(writeExit),
      },
    })

    expect(result.exitCode).toBe(exit)
    const expected = ["kernel.apparmor_restrict_unprivileged_userns"].concat(
      writes ? ["-w kernel.apparmor_restrict_unprivileged_userns=0"] : [],
    )
    expect(readFileSync(log, "utf8").trim().split("\n")).toEqual(expected)
  })
})

const namespaceExitCodes = [0, 1]

namespaceExitCodes.forEach((probeExit) => {
  test.skipIf(process.platform !== "linux")(
    `CI uses the production capability probe and propagates namespace exit ${probeExit}`,
    () => {
      const probe = getConfinementScripts().probe
      expect(probe).toContain('from "./sidecar/src/kernel/folder-capability.ts"')

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
      if (probeExit !== 0) expect(result.stderr.toString()).toContain("Linux folder confinement is unavailable")
    },
    30_000,
  )
})

const getRequiredStep = (matches: (step: Step) => boolean): Step => {
  const step = steps.find(matches)
  if (!step) throw new Error("Missing required Linux CI step")

  return step
}

const getRunStep = (command: string): Step => getRequiredStep((step) => step.run?.startsWith(command) === true)

const getConfinementScripts = () => {
  const step = getRequiredStep((step) => step.name === "Verify Linux folder confinement")
  const match = step.run?.match(/bun -e '([\s\S]*)'\s*$/)
  if (!step.run || !match?.[1] || match.index === undefined) throw new Error("Missing Linux confinement probe")

  return { setup: step.run.slice(0, match.index), probe: match[1] }
}

const makeNamespaceFixture = (): string => {
  mkdirSync(fixtureRoot, { recursive: true })
  const log = join(fixtureRoot, "sysctl.log")
  writeFileSync(
    join(fixtureRoot, "sysctl"),
    '#!/bin/sh\nprintf "%s\\n" "$*" >> "$TOURI_CI_LOG"\nif [ "$1" = "-w" ]; then exit "$TOURI_CI_WRITE_EXIT"; fi\nexit "$TOURI_CI_SYSCTL_EXIT"\n',
    { mode: 0o700 },
  )
  writeFileSync(join(fixtureRoot, "sudo"), '#!/bin/sh\nexec "$@"\n', { mode: 0o700 })

  return log
}
