import { opendir, realpath, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, join } from "node:path"
import type { DiscoveredProject } from "@touri/contracts"

const skipped = new Set([
  "node_modules",
  "Library",
  "Applications",
  "Movies",
  "Music",
  "Pictures",
  "vendor",
  "dist",
  "build",
  "target",
])
const CODE_ROOTS = [
  "javascript",
  "code",
  "Code",
  "Projects",
  "projects",
  "src",
  "dev",
  "Developer",
  "repos",
  "github",
  "workspace",
]

/** Best-effort, bounded discovery. Never follow directory symlinks or execute Git. */
export const discoverProjects = async ({
  home = homedir(),
  roots: grantedRoots,
  isAllowed,
  registeredPaths = [],
  signal,
  timeoutMs = 2_000,
}: {
  home?: string
  roots?: string[]
  isAllowed?: (path: string) => boolean
  registeredPaths?: string[]
  signal?: AbortSignal
  timeoutMs?: number
} = {}): Promise<DiscoveredProject[]> => {
  const found: DiscoveredProject[] = []
  const deadline = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(timeoutMs)])
  const scan = async () => {
    const excluded = new Set(await Promise.all(registeredPaths.map((path) => realpath(path).catch(() => path))))
    const pending = (grantedRoots ?? []).map((path) => ({ path, depth: 0 }))
    if (!grantedRoots) {
      const root = await realpath(home)
      // Common code roots first for the user-driven UI search only.
      const roots = await Promise.all(
        CODE_ROOTS.map((name) =>
          realpath(join(root, name))
            .then((path) => ({ path, depth: 1 }))
            .catch(() => null),
        ),
      )
      pending.push(...roots.filter((item): item is { path: string; depth: number } => item !== null), {
        path: root,
        depth: 0,
      })
    }
    const visited = new Set<string>()
    let entries = 0
    while (pending.length && !deadline.aborted && entries < 20_000) {
      const directory = pending.shift()
      if (!directory || visited.has(directory.path)) continue
      visited.add(directory.path)
      try {
        if (isAllowed && !isAllowed(directory.path)) continue
        // Explicit grants are stored as canonical paths. A replaced ancestor
        // or code-root symlink must not expand discovery beyond that grant.
        if (grantedRoots && (await realpath(directory.path)) !== directory.path) continue
        const children: string[] = []
        let repository = false
        const handle = await opendir(directory.path)
        for await (const entry of handle) {
          if (deadline.aborted || ++entries > 20_000) break
          if (entry.name === ".git" && entry.isDirectory()) repository = true
          else if (entry.isDirectory() && !entry.name.startsWith(".") && !skipped.has(entry.name))
            children.push(join(directory.path, entry.name))
        }
        if (deadline.aborted) break
        if (repository) {
          if (!excluded.has(directory.path)) {
            const info = await stat(directory.path)
            if (deadline.aborted) break
            found.push({ path: directory.path, name: basename(directory.path), lastModified: info.mtimeMs })
            found.sort((a, b) => b.lastModified - a.lastModified || a.path.localeCompare(b.path))
            if (found.length > 50) found.pop()
          }
          // A repository's own folders are not separate projects.
          continue
        }
        if (directory.depth < 4) for (const path of children) pending.push({ path, depth: directory.depth + 1 })
      } catch {
        // Unreadable or disappearing folders must not hide other repositories.
      }
    }
  }
  // A slow filesystem must not hold the HTTP request past the deadline. The
  // walker checks the same signal before scheduling further filesystem work.
  let stop: () => void = () => {}
  const stopped = new Promise<void>((resolve) => {
    stop = resolve
    deadline.addEventListener("abort", stop, { once: true })
    if (deadline.aborted) resolve()
  })
  try {
    await Promise.race([scan().catch(() => {}), stopped])
    return [...found]
  } finally {
    deadline.removeEventListener("abort", stop)
  }
}
