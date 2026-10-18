import { readdirSync } from "node:fs"

// A workflow/action or native-policy change must exercise every native job too.
export function needsNative(event: string, paths: string[]): boolean {
  return (
    event !== "pull_request" ||
    paths.some((path) =>
      /^(src-tauri\/|\.github\/|(?:.*\/)?Cargo\.(?:toml|lock)$|(?:.*\/)?rust-toolchain(?:\.toml)?$|(?:.*\/)?\.cargo\/|scripts\/(?:test-native-linux\.sh|test-rust-policy\.py)$)/.test(
        path,
      ),
    )
  )
}

export function testFiles(root = "sidecar/test"): string[] {
  return readdirSync(root, { recursive: true, encoding: "utf8" })
    .map((path) => path.replaceAll("\\", "/"))
    .filter((path) => /[._](?:test|spec)\.(?:[jt]sx?|[cm][jt]s)$/.test(path))
    .sort()
}

// Balance directory timings from the full suite: about 148/145/143 seconds.
// Unknown/new directories go in shard 3, so adding a test never drops it.
export function sidecarShard(path: string): number {
  const directory = path.split("/")[0]
  if (["runtime", "cli", "projects", "doctor", "notify", "approvals", "learning", "cloud"].includes(directory ?? ""))
    return 1
  if (
    ["vm", "kernel", "store", "mcp", "security", "computer", "importer", "groups", "reports"].includes(directory ?? "")
  )
    return 2
  return 3
}

export function linuxTests(paths: string[]): string[] {
  return paths.filter(
    (path) =>
      path === "kernel/sqlite-sync-benchmark.test.ts" ||
      path.startsWith("platform/") ||
      /(?:^|\/)(?:linux-|[^/]*(?:sandbox|confinement))/.test(path),
  )
}
