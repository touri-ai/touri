import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join, relative } from "node:path"
import { resolveTouriVersion } from "../sidecar/src/version"
import { assertBunToolchain } from "./bun-toolchain"

const root = join(import.meta.dir, "..")
const uiDist = join(root, "ui", "dist")
const stubPath = join(root, "sidecar", "src", "cli", "web", "embeddedUi.ts")
const targets = ["bun-linux-x64", "bun-linux-x64-baseline", "bun-darwin-arm64"] as const
type Target = (typeof targets)[number]

const listFiles = (dir: string): Array<string> =>
  readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    return statSync(full).isDirectory() ? listFiles(full) : [full]
  })

const generateEmbedded = (): string => {
  const files = listFiles(uiDist).map((full) => ({ full, key: relative(uiDist, full) }))
  const imports = files.map(({ full }, index) => `import f${index} from ${JSON.stringify(full)} with { type: "file" }`)
  const entries = files.map(({ key }, index) => `  ${JSON.stringify(key)}: f${index},`)
  return `${imports.join("\n")}\n\nexport const embeddedUi: Record<string, string> = {\n${entries.join("\n")}\n}\n`
}

const run = (cmd: Array<string>, cwd: string): void => {
  const result = Bun.spawnSync(cmd, { cwd, stdout: "inherit", stderr: "inherit" })
  if (result.exitCode !== 0) throw new Error(`${cmd.join(" ")} failed with ${result.exitCode}`)
}

const parseTargets = (args: Array<string>): Array<Target> => {
  if (args.length === 0) return [...targets]
  return args.map((arg) => {
    const full = `bun-${arg}` as Target
    if (!targets.includes(full))
      throw new Error(`Unknown target ${arg}; use linux-x64, linux-x64-baseline (CPUs without AVX2) or darwin-arm64`)
    return full
  })
}

const main = (): void => {
  assertBunToolchain()
  const selected = parseTargets(process.argv.slice(2))
  const version = resolveTouriVersion(process.env)
  run(["bun", "run", "build"], join(root, "ui"))
  const original = readFileSync(stubPath, "utf8")
  writeFileSync(stubPath, generateEmbedded())
  try {
    for (const target of selected) {
      const name = target.replace("bun-", "")
      run(
        [
          process.execPath,
          "build",
          "--compile",
          `--target=${target}`,
          `--define=process.env.TOURI_VERSION=${JSON.stringify(version)}`,
          "sidecar/src/cli/main.ts",
          "sidecar/src/cli/file-io-worker-entry.ts",
          "sidecar/src/cli/auth-writer-worker-entry.ts",
          "sidecar/src/cli/atomic-download-worker-entry.ts",
          "--outfile",
          `dist/touri-${name}`,
        ],
        root,
      )
    }
  } finally {
    writeFileSync(stubPath, original)
  }
}

main()
