import { existsSync } from "node:fs"
import { resolve } from "node:path"

const env: NodeJS.ProcessEnv = {
  ...process.env,
  TOURI_VM_INTEGRATION: "0",
  TOURI_E2E_REAL_CLI: "0",
  TOURI_OPENCODE_REAL: "0",
  TOURI_DOCTOR_SKIP_PROVIDER_PROBES: "1",
}
if (process.platform === "win32" && !env.TOURI_DESKTOP_HELPER) {
  const helper = resolve("src-tauri/target/debug/touri.exe")
  if (!existsSync(helper))
    throw new Error("Build the native desktop helper with cargo test before running Windows sidecar tests")
  env.TOURI_DESKTOP_HELPER = helper
}
// OS service/permission/signal fixtures remain in the full Unix suite. These
// tests use inert providers and real loopback transports on every CI platform.
const result = Bun.spawnSync(
  [
    process.execPath,
    "test",
    "--timeout",
    "60000",
    "sidecar/test/platform",
    "sidecar/test/kernel/async-files.test.ts",
    "sidecar/test/kernel/linux-file-io-fsync.test.ts",
    "sidecar/test/cli/auth-writer.test.ts",
    "sidecar/test/kernel/host-client.test.ts",
    "sidecar/test/kernel/host-loopback.test.ts",
    "sidecar/test/mcp/transport.test.ts",
  ],
  { env, stdout: "inherit", stderr: "inherit" },
)
process.exitCode = result.exitCode
