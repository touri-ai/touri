import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const roots = new Set<string>()
afterEach(async () => {
  await Promise.all(Array.from(roots, (root) => rm(root, { recursive: true, force: true })))
  roots.clear()
})

test("container build context excludes local environment files while preserving application sources", async () => {
  const ignore = await readFile(join(import.meta.dir, "../../../.dockerignore"), "utf8")
  const rules = ignore.split("\n").filter((rule) => rule && !rule.startsWith("#"))
  const getIncluded = (path: string) =>
    rules.reduce((included, rule) => {
      const negated = rule.startsWith("!")
      const pattern = negated ? rule.slice(1) : rule
      const glob = new Bun.Glob(pattern.endsWith("/") ? `${pattern}**` : pattern)

      return glob.match(path) ? negated : included
    }, false)

  const credentials = ["ui/.env", "ui/.env.production.local", "sidecar/.env", "packages/contracts/.env.test"]
  const sources = ["ui/src/App.tsx", "sidecar/src/cli/main.ts", "packages/contracts/package.json"]

  expect(credentials.map(getIncluded)).toEqual([false, false, false, false])
  expect(sources.map(getIncluded)).toEqual([true, true, true])
})

test("container HOME keeps CLI sessions and managed profiles on the data volume across processes", async () => {
  const root = await mkdtemp(join(tmpdir(), "touri-container-home-"))
  roots.add(root)
  const dockerfile = await readFile(join(import.meta.dir, "../../../Dockerfile"), "utf8")
  const homeSetting = dockerfile.match(/^ENV HOME=(\S+)/mu)?.[1]
  expect(homeSetting).toBe("/data/home")
  if (!homeSetting) throw new Error("Missing container HOME")
  const home = homeSetting.replace("/data", root)
  await mkdir(join(home, ".codex/sessions"), { recursive: true })
  await writeFile(join(home, ".codex/sessions/synthetic.jsonl"), "synthetic session\n")
  const script = `
    import { homedir } from "node:os"
    import { createAppPaths } from "./sidecar/src/kernel/paths"
    import { getChromeProfilePath } from "./sidecar/src/browser/launcher"
    import { codexSessionsCheck } from "./sidecar/src/doctor/codex-sessions"
    import { openCodeAuthPath } from "./sidecar/src/runtime/opencode/config"
    const paths = createAppPaths({ appData: process.argv[1] })
    console.log(JSON.stringify({
      home: homedir(),
      profile: getChromeProfilePath(paths, "fixture"),
      auth: openCodeAuthPath(homedir()),
      sessions: (await codexSessionsCheck(homedir())).detail,
    }))
  `
  const getPaths = async () => {
    const child = Bun.spawn([process.execPath, "-e", script, root], {
      cwd: join(import.meta.dir, "../../.."),
      env: { ...process.env, HOME: home },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect(stderr).toBe("")
    expect(exit).toBe(0)
    return JSON.parse(stdout) as { home: string; profile: string; auth: string; sessions: string }
  }

  const first = await getPaths()
  const restarted = await getPaths()

  expect(first.home).toBe(home)
  expect(first.profile).toBe(join(root, "bots/fixture/browser/profile"))
  expect(first.auth.startsWith(`${home}/`)).toBe(true)
  expect(first.sessions).toContain("1 arquivos")
  expect(restarted).toEqual(first)
})
