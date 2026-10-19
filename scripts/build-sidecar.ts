import { assertBunToolchain } from "./bun-toolchain"

/** Bun target -> Tauri externalBin target triple. Never infer a target from the build host when cross-compiling. */
const targets: Record<string, { bun: string; triple: string }> = {
  "darwin-arm64": { bun: "bun-darwin-arm64", triple: "aarch64-apple-darwin" },
  "darwin-x64": { bun: "bun-darwin-x64", triple: "x86_64-apple-darwin" },
  "linux-x64": { bun: "bun-linux-x64", triple: "x86_64-unknown-linux-gnu" },
  "linux-arm64": { bun: "bun-linux-arm64", triple: "aarch64-unknown-linux-gnu" },
  "windows-x64": { bun: "bun-windows-x64", triple: "x86_64-pc-windows-gnu" },
  "windows-msvc-x64": { bun: "bun-windows-x64", triple: "x86_64-pc-windows-msvc" },
}
const name = process.argv[2] ?? `${process.platform === "win32" ? "windows-msvc" : process.platform}-${process.arch}`
const target = targets[name]
if (!target) throw new Error(`Unsupported sidecar target: ${name}`)
assertBunToolchain()
const child = Bun.spawnSync(
  [
    process.execPath,
    "build",
    "--compile",
    `--target=${target.bun}`,
    "./sidecar/src/main.ts",
    "./sidecar/src/file-io-worker-entry.ts",
    "./sidecar/src/auth-writer-worker-entry.ts",
    "./sidecar/src/atomic-download-worker-entry.ts",
    "--outfile",
    `src-tauri/binaries/touri-sidecar-${target.triple}${name.startsWith("windows") ? ".exe" : ""}`,
  ],
  { stdout: "inherit", stderr: "inherit" },
)
process.exitCode = child.exitCode
