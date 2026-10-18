import { linuxTests, sidecarShard, testFiles } from "./selection"

const selection = process.argv[2]
const files = testFiles()
const selected =
  selection === "linux" ? linuxTests(files) : files.filter((file) => String(sidecarShard(file)) === selection)
if (selected.length === 0) throw new Error(`Empty or invalid sidecar selection: ${selection}`)
console.log(`Sidecar selection ${selection}: ${selected.length}/${files.length} files`)
const result = Bun.spawnSync(
  [
    process.execPath,
    "test",
    ...(selection === "linux" ? ["--timeout", "30000"] : []),
    ...selected.map((file) => `./sidecar/test/${file}`),
  ],
  { stdout: "inherit", stderr: "inherit" },
)
process.exitCode = result.exitCode
