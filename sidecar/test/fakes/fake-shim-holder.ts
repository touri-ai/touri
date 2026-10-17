import { registerShim } from "../../src/mcp/shim-registry"

await registerShim({ runDir: process.env.TOURI_RUN_DIR ?? "", thread: "holder" })
setInterval(() => undefined, 1_000)
