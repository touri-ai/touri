import { appendFileSync, readFileSync } from "node:fs"
import { needsNative } from "./selection"

const event = process.env.GITHUB_EVENT_NAME ?? "workflow_dispatch"
let paths: string[] = []
if (event === "pull_request") {
  const { pull_request: pr } = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH ?? "", "utf8"))
  const result = Bun.spawnSync(["git", "diff", "--name-only", "-z", `${pr.base.sha}...${pr.head.sha}`])
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  paths = result.stdout.toString().split("\0").filter(Boolean)
}
const native = needsNative(event, paths)
appendFileSync(process.env.GITHUB_OUTPUT ?? "/dev/stdout", `native=${native}\n`)
console.log(`${paths.length} changed paths; native checks: ${native}`)
