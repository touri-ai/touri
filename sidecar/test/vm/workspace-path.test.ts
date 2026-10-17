import { expect, test } from "bun:test"
import type { Bot, Kernel } from "@touri/contracts"
import { folderGuestPath } from "../../src/kernel/bot-folders"
import { workspaceError, workspacePath } from "../../src/vm/workspace-path"

const kernel = {} as Kernel
const grant = "/output/assets"
const bot = {
  machine: "vm",
  projectId: null,
  folders: [{ path: grant, access: "read-only" }],
  anyFolderAccess: true,
} as Bot

test("the shared resolver maps VM grants and report bases to the same guest directory", () => {
  const mount = folderGuestPath(grant)
  for (const path of [`${grant}/post.png`, `${mount}/post.png`])
    expect(workspacePath(kernel, bot, path)).toEqual({ root: mount, path: "post.png" })
  expect(workspacePath(kernel, bot, "post.png", `${grant}/reports`)).toEqual({
    root: mount,
    path: "reports/post.png",
  })
  expect(workspacePath(kernel, bot, "/host/home/post.png")).toEqual({ root: "/host/home", path: "post.png" })
})

test("cloud bots cannot inherit host grants or the VM home mount", () => {
  const cloud = { ...bot, machine: "cloud" } as Bot
  expect(workspacePath(kernel, cloud, "/workspace/post.png")).toEqual({ root: "/workspace", path: "post.png" })
  for (const path of [`${grant}/post.png`, `${folderGuestPath(grant)}/post.png`, "/host/home/post.png"])
    expect(() => workspacePath(kernel, cloud, path)).toThrow("Acesso a esta pasta não autorizado")
})

test("the shared resolver rejects malformed paths and encoded traversal before guest access", () => {
  for (const path of ["../post.png", "%2e%2e/post.png", "bad\\post.png", "bad\0post.png", "%00post.png", "%ZZ"])
    for (const base of [false, true]) {
      let status = 0
      try {
        workspacePath(kernel, bot, base ? "post.png" : path, base ? path : "")
      } catch (error) {
        status = workspaceError(error).status
      }
      expect(status).toBe(400)
    }
})
