import { afterEach, expect, mock, spyOn, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import * as fsPromises from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import type { FolderListing } from "@touri/contracts"
import Ajv2020 from "ajv/dist/2020"
import folderSchema from "../../../packages/contracts/folders.schema.json"
import { excludedBotFolders } from "../../src/kernel/bot-folders"
import * as kernelFiles from "../../src/kernel/files"
import { createRouteRegistry } from "../../src/kernel/routes"
import { createFolderRoutes } from "../../src/projects/folders"

const cleanups: (() => void)[] = []
afterEach(() => {
  mock.restore()
  for (const close of cleanups.splice(0)) close()
})

const fixture = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "touri-folders-")))
  const home = join(root, "workspace")
  const appData = join(home, "app-data")
  mkdirSync(home)
  mkdirSync(appData)
  const registry = createRouteRegistry()
  registry.registerRoutes(createFolderRoutes({ appData, home }))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const request = async (method: string, path?: string, body?: unknown) => {
    const response = await registry.handle({
      method,
      pathname: "/folders",
      query: new URLSearchParams(path === undefined ? {} : { path }),
      body,
      signal: AbortSignal.timeout(5_000),
    })
    if (!("json" in response)) throw new Error("Expected JSON")
    return Response.json(response.json, { status: response.status })
  }
  const list = (path?: string) => request("GET", path)
  const create = (path: string, name: string) => request("POST", undefined, { path, name })
  return { root, home, appData, list, create }
}

test("folder endpoint lists only visible subfolders starting at home", async () => {
  const f = fixture()
  mkdirSync(join(f.home, "Zulu"))
  mkdirSync(join(f.home, "Alpha/nested"), { recursive: true })
  mkdirSync(join(f.home, ".hidden"))
  writeFileSync(join(f.home, "notes.txt"), "fixture")
  symlinkSync(join(f.home, "Alpha"), join(f.home, "alias"))
  const response = await f.list()
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({
    home: f.home,
    path: f.home,
    parent: dirname(f.home),
    truncated: false,
    folders: ["Alpha", "Zulu"].map((name) => ({ name, path: join(f.home, name) })),
  })
  const nested = (await (await f.list(join(f.home, "Alpha"))).json()) as FolderListing
  expect(nested.parent).toBe(f.home)
  expect(nested.folders).toEqual([{ name: "nested", path: join(f.home, "Alpha/nested") }])
})

test("all sensitive exclusions and app data are hidden and refused by both routes", async () => {
  const f = fixture()
  for (const path of excludedBotFolders(f.appData, f.home)) {
    mkdirSync(join(path, "private"), { recursive: true })
    expect((await f.list(path)).status).toBe(400)
    expect((await f.list(join(path, "private"))).status).toBe(400)
    expect((await f.create(path, "new-folder")).status).toBe(400)
    const parent = await f.list(dirname(path))
    if (parent.status === 200) {
      const listing = (await parent.json()) as FolderListing
      expect(listing.folders.some((folder) => folder.path === path)).toBe(false)
    }
  }
  mkdirSync(join(f.home, "app-data-backup"))
  const listing = (await (await f.list()).json()) as FolderListing
  expect(listing.folders.some((folder) => folder.name === "app-data-backup")).toBe(true)
})

test("traversal, hidden paths, files and missing directories cannot be opened or used as parents", async () => {
  const f = fixture()
  mkdirSync(join(f.home, "public"))
  mkdirSync(join(f.home, ".hidden/nested"), { recursive: true })
  writeFileSync(join(f.home, "file"), "fixture")
  for (const path of [
    "relative",
    `${f.home}/public/../app-data`,
    `${f.home}/./public`,
    join(f.home, ".hidden/nested"),
    join(f.home, "file"),
    join(f.home, "missing"),
    `${f.home}/bad\0path`,
  ]) {
    expect((await f.list(path)).status).toBe(400)
    expect((await f.create(path, "new-folder")).status).toBe(400)
  }
})

test("symlinks cannot bypass exclusions, including intermediate links, broken links and retargeted folders", async () => {
  const f = fixture()
  mkdirSync(join(f.home, "public/nested"), { recursive: true })
  mkdirSync(join(f.appData, "private"))
  symlinkSync(f.appData, join(f.home, "sensitive-alias"))
  symlinkSync(join(f.home, "public"), join(f.home, "public-alias"))
  symlinkSync(join(f.root, "missing"), join(f.home, "broken"))
  for (const path of [
    join(f.home, "sensitive-alias"),
    join(f.home, "sensitive-alias/private"),
    join(f.home, "public-alias/nested"),
    join(f.home, "broken"),
  ]) {
    expect((await f.list(path)).status).toBe(400)
    expect((await f.create(path, "new-folder")).status).toBe(400)
  }
  const publicPath = join(f.home, "public")
  expect((await f.list(publicPath)).status).toBe(200)
  rmSync(publicPath, { recursive: true })
  symlinkSync(f.appData, publicPath)
  expect((await f.list(publicPath)).status).toBe(400)
  expect((await f.create(publicPath, "new-folder")).status).toBe(400)
  expect(existsSync(join(f.appData, "new-folder"))).toBe(false)
})

test("canonical exclusions also protect the real destination when app data itself is linked", async () => {
  const f = fixture()
  const alias = join(f.root, "data-alias")
  symlinkSync(f.appData, alias)
  const module = createFolderRoutes({ appData: alias, home: f.home })
  const list = module.routes.find((route) => route.method === "GET")
  if (!list) throw new Error("Missing folder route")
  const response = await list.handler({
    params: {},
    query: { path: f.appData },
    body: null,
    signal: AbortSignal.timeout(1_000),
  })
  expect(response.status).toBe(400)
})

test("listings are bounded and report truncation", async () => {
  const f = fixture()
  for (let index = 0; index < 110; index++) mkdirSync(join(f.home, `folder-${index}`))
  const listing = (await (await f.list()).json()) as FolderListing
  expect(listing.folders).toHaveLength(100)
  expect(listing.truncated).toBe(true)
  const files = join(f.home, "many-files")
  mkdirSync(files)
  for (let index = 0; index < 2_010; index++) writeFileSync(join(files, `file-${index}`), "")
  const scanned = (await (await f.list(files)).json()) as FolderListing
  expect(scanned.folders).toEqual([])
  expect(scanned.truncated).toBe(true)
})

test("creates exactly one visible child and rejects escapes, protected names and existing entries", async () => {
  const f = fixture()
  const response = await f.create(f.home, "New project")
  expect(response.status).toBe(201)
  expect(await response.json()).toEqual({ path: join(f.home, "New project") })
  expect(existsSync(join(f.home, "New project"))).toBe(true)
  for (const name of [
    "",
    " ",
    ".",
    "..",
    ".hidden",
    "../escape",
    "nested/escape",
    "nested\\escape",
    "bad\0name",
    "bad\nname",
    "app-data",
    "New project",
  ])
    expect((await f.create(f.home, name)).status).toBe(400)
  expect(existsSync(join(f.root, "escape"))).toBe(false)
})

test("rechecks canonical exclusions when a protected directory becomes a symlink", async () => {
  const f = fixture()
  const vault = join(f.home, "vault")
  mkdirSync(vault)
  mkdirSync(join(f.home, "Library"))
  symlinkSync(vault, join(f.home, "Library/Keychains"))
  expect((await f.list(vault)).status).toBe(400)
  expect((await f.create(vault, "new-folder")).status).toBe(400)
  const listing = (await (await f.list()).json()) as FolderListing
  expect(listing.folders.some((folder) => folder.path === vault)).toBe(false)
})

test("folder responses match the shared API schema", async () => {
  const f = fixture()
  const ajv = new Ajv2020()
  const listing = ajv.compile<FolderListing>({ ...folderSchema, $ref: "#/$defs/listing" })
  const created = ajv.compile<{ path: string }>({ ...folderSchema, $ref: "#/$defs/created" })
  expect(listing(await (await f.list()).json())).toBe(true)
  expect(created(await (await f.create(f.home, "Report")).json())).toBe(true)
})

test("a directory swapped for a symlink during listing cannot expose protected names", async () => {
  const f = fixture()
  const path = join(f.home, "public")
  mkdirSync(path)
  mkdirSync(join(f.appData, "private-name"))
  const original = fsPromises.opendir
  spyOn(fsPromises, "opendir").mockImplementationOnce(async (...args) => {
    renameSync(path, join(f.home, "previous"))
    symlinkSync(f.appData, path)
    return original(...args)
  })
  const response = await f.list(path)
  expect(response.status).toBe(400)
  expect(await response.text()).not.toContain("private-name")
})

test("creating a folder stays under the pinned parent even when its path is swapped", async () => {
  const f = fixture()
  const path = join(f.home, "public")
  const previous = join(f.home, "previous")
  mkdirSync(path)
  const original = kernelFiles.createWorkspaceChildDirectory
  spyOn(kernelFiles, "createWorkspaceChildDirectory").mockImplementationOnce((fd, name) => {
    renameSync(path, previous)
    symlinkSync(f.appData, path)
    original(fd, name)
  })
  expect((await f.create(path, "Report")).status).toBe(400)
  expect(existsSync(join(f.appData, "Report"))).toBe(false)
  expect(existsSync(join(previous, "Report"))).toBe(true)
})
