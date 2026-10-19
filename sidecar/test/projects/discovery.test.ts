import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { createKernel } from "../../src/kernel"
import { discoverProjects } from "../../src/projects/discovery"
import { createProjectStore } from "../../src/projects/repository"
import { createProjectRoutes } from "../../src/projects/routes"
import { createSupervisor } from "../../src/projects/supervisor"

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const close of cleanups.splice(0)) close()
})
const fixture = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "touri-discovery-")))
  const home = join(root, "home")
  mkdirSync(home)
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const repo = (relative: string, modified = 1_000, worktree = false) => {
    const path = join(home, relative)
    mkdirSync(path, { recursive: true })
    if (worktree) writeFileSync(join(path, ".git"), "gitdir: /unused/worktree")
    else mkdirSync(join(path, ".git"))
    utimesSync(path, modified, modified)
    return { path, name: basename(path), lastModified: modified * 1_000 }
  }
  return { root, home, repo }
}

test("discovers Git repositories newest first, skipping linked worktrees, nested folders, registered and heavy/hidden trees", async () => {
  const f = fixture()
  const older = f.repo("javascript/older", 1_000)
  f.repo("code/newer/packages/nested", 7_000)
  const newer = f.repo("code/newer", 2_000)
  f.repo("code/linked-worktree", 6_000, true)
  const registered = f.repo("Projects/registered", 3_000)
  const deepest = f.repo("dev/one/two/depth-four", 1_500)
  f.repo("dev/one/two/three/too-deep", 4_000)
  for (const path of ["Library", "node_modules", ".cache", ".Trash", ".hidden", "vendor", "target"])
    f.repo(`${path}/skipped`, 5_000)
  mkdirSync(join(f.home, "plain"))
  symlinkSync(join(f.home, "code"), join(f.home, "alias"))
  expect(await discoverProjects({ home: f.home, registeredPaths: [registered.path] })).toEqual([newer, deepest, older])
})

test("caps results at 50 while retaining newer repositories encountered later", async () => {
  const f = fixture()
  const repositories = Array.from({ length: 60 }, (_, index) => f.repo(`repo-${index}`, 1_000 + index))
  expect(await discoverProjects({ home: f.home })).toEqual(repositories.reverse().slice(0, 50))
})

test("explicit grants never scan home, common-root symlinks or retargeted grants", async () => {
  const f = fixture()
  const allowed = f.repo("granted/repository")
  const outside = f.repo("outside/repository")
  const granted = join(f.home, "granted")
  symlinkSync(join(f.home, "outside"), join(granted, "code"))
  expect(await discoverProjects({ home: f.home, roots: [] })).toEqual([])
  expect(await discoverProjects({ home: f.home, roots: [granted] })).toEqual([allowed])
  expect(await discoverProjects({ roots: [granted], registeredPaths: [allowed.path] })).toEqual([])
  rmSync(granted, { recursive: true })
  symlinkSync(join(f.home, "outside"), granted)
  expect(await discoverProjects({ home: f.home, roots: [granted] })).toEqual([])
  expect(await discoverProjects({ home: f.home })).toEqual([outside])
})

test("discovery tolerates missing homes and honors cancellation and a short deadline", async () => {
  const f = fixture()
  expect(await discoverProjects({ home: join(f.home, "missing") })).toEqual([])
  f.repo("code/repo")
  expect(await discoverProjects({ home: f.home, signal: AbortSignal.abort() })).toEqual([])
  const started = performance.now()
  await discoverProjects({ home: f.home, timeoutMs: 1 })
  expect(performance.now() - started).toBeLessThan(500)
})

test("authenticated discovery route scans a temp home and excludes projects registered between requests", async () => {
  const f = fixture()
  const repository = f.repo("src/repository")
  const runtime = createKernel({ appData: join(f.root, "app") })
  // Stop the kernel before removing its database and socket files.
  cleanups.unshift(() => runtime.stop())
  const store = createProjectStore({ kernel: runtime.kernel })
  const supervisor = createSupervisor({ kernel: runtime.kernel, store })
  runtime.kernel.registerRoutes(
    createProjectRoutes({ kernel: runtime.kernel, store, supervisor, discoveryHome: f.home }),
  )
  const url = `http://127.0.0.1:${runtime.handshake.port}/api/v1/projects/discover`
  expect((await fetch(url)).status).toBe(401)
  const request = () => fetch(url, { headers: { Authorization: "Bearer dev-ui-token", Origin: "tauri://localhost" } })
  const response = await request()
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ repositories: [repository] })
  await store.createProject({
    id: "registered",
    name: repository.name,
    path: repository.path,
    gitRemote: null,
    defaultBranch: null,
    dataDir: join(f.root, "data"),
    now: Date.now(),
  })
  expect(await (await request()).json()).toEqual({ repositories: [] })
})
