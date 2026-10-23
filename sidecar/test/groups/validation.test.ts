import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Bot, BotGroup, GroupInput } from "@touri/contracts"
import { init as initGroups } from "../../src/groups"
import { createKernel } from "../../src/kernel"
import { init as initStore } from "../../src/store"

// Lifecycle hooks own the disposable HTTP servers and databases created by each test.
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

test("POST /groups defaults only an omitted avatarShape and persists the default", async () => {
  const fixture = await getFixture()
  const { avatarShape: _avatarShape, ...input } = fixture.input

  const response = await fixture.request("/groups", input)
  const { group } = (await response.json()) as { group: BotGroup }

  expect(response.status).toBe(201)
  expect(group.avatarShape).toBe("classic-none")
  const listed = await fixture.request("/groups", undefined, "GET")
  expect(await listed.json()).toMatchObject({ groups: [{ id: group.id, avatarShape: "classic-none" }] })
})

test("invalid group fields survive HTTP error normalization without echoing supplied values", async () => {
  const fixture = await getFixture()
  const cases = [
    { field: "body", input: [] },
    { field: "name", input: { ...fixture.input, name: "" } },
    { field: "name", input: { ...fixture.input, name: undefined } },
    { field: "color", input: { ...fixture.input, color: "private-value" } },
    { field: "avatarShape", input: { ...fixture.input, avatarShape: "private-value" } },
    { field: "avatarShape", input: { ...fixture.input, avatarShape: null } },
    { field: "memberIds", input: { ...fixture.input, memberIds: [] } },
    { field: "memberIds", input: { ...fixture.input, memberIds: ["private-value"] } },
    { field: "memberIds", input: { ...fixture.input, memberIds: Array(21).fill(fixture.input.memberIds[0]) } },
    {
      field: "memberIds",
      input: { ...fixture.input, memberIds: [...fixture.input.memberIds, ...fixture.input.memberIds] },
    },
    { field: "coordinatorBotId", input: { ...fixture.input, coordinatorBotId: "private-value" } },
  ]

  for (const scenario of cases) {
    const response = await fixture.request("/groups", scenario.input)
    const body = await response.json()

    expect(response.status).toBe(400)
    expect(body).toMatchObject({ errorCode: "INVALID_ARGS", code: "TOURI-E1001", field: scenario.field })
    expect(body.error).toContain(scenario.field)
    expect(body.errorMessages["pt-BR"]).toBe(body.error)
    expect(body.errorMessages.en).toContain(scenario.field)
    expect(JSON.stringify(body)).not.toContain("private-value")
  }
  expect(await (await fixture.request("/groups", undefined, "GET")).json()).toEqual({ groups: [] })
})

test("POST /groups reports every invalid field with fixed bilingual messages and no writes", async () => {
  const fixture = await getFixture()
  const response = await fixture.request("/groups", {
    ...fixture.input,
    name: "",
    color: "private-value",
    avatarShape: null,
    memberIds: "private-value",
    coordinatorBotId: "private-value",
  })
  const body = await response.json()
  const fields = ["name", "color", "avatarShape", "memberIds", "coordinatorBotId"]

  expect(response.status).toBe(400)
  expect(body.field).toBe("name")
  expect(body.fields).toEqual(fields)
  for (const field of fields) {
    expect(body.errorMessages["pt-BR"]).toContain(`${field}:`)
    expect(body.errorMessages.en).toContain(`${field}:`)
  }
  expect(body.error).toBe(body.errorMessages["pt-BR"])
  expect(JSON.stringify(body)).not.toContain("private-value")
  expect(await (await fixture.request("/groups", undefined, "GET")).json()).toEqual({ groups: [] })
})

test("POST /groups defaults omitted presentation and coordinator fields, including with an explicit avatar", async () => {
  const fixture = await getFixture()
  const { color: _color, avatarShape: _avatarShape, coordinatorBotId: _coordinator, ...required } = fixture.input

  for (const input of [required, { ...required, avatarShape: "short-crown" }]) {
    const response = await fixture.request("/groups", input)
    const { group } = (await response.json()) as { group: BotGroup }

    expect(response.status).toBe(201)
    expect(group.color).toBe("#dc2626")
    expect(group.coordinatorBotId).toBeNull()
    expect(group.avatarShape).toBe("avatarShape" in input ? "short-crown" : "classic-none")
  }
})

test("PATCH /groups requires avatarShape and leaves the existing avatar intact", async () => {
  const fixture = await getFixture()
  const created = await fixture.request("/groups", fixture.input)
  const { group } = (await created.json()) as { group: BotGroup }
  const { avatarShape: _avatarShape, ...input } = fixture.input

  const response = await fixture.request(`/groups/${group.id}`, input, "PATCH")

  expect(response.status).toBe(400)
  expect(await response.json()).toMatchObject({ field: "avatarShape" })
  const listed = await fixture.request("/groups", undefined, "GET")
  expect(await listed.json()).toMatchObject({ groups: [{ id: group.id, avatarShape: fixture.input.avatarShape }] })
})

const getFixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "touri-group-validation-"))
  const host = createKernel({ appData: root })
  cleanups.push(async () => {
    await host.stop()
    await rm(root, { recursive: true, force: true })
  })
  await initStore(host.kernel)
  await initGroups(host.kernel)
  const request = (path: string, body?: unknown, method = "POST") =>
    fetch(`http://127.0.0.1:${host.handshake.port}/api/v1${path}`, {
      method,
      headers: {
        Authorization: "Bearer dev-ui-token",
        Origin: "tauri://localhost",
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  const response = await request("/bots", { name: "example-member", provider: "codex" })
  const { bot } = (await response.json()) as { bot: Bot }
  const input: GroupInput = {
    name: "Example group",
    color: "#dc2626",
    avatarShape: "short-crown",
    memberIds: [bot.id],
    coordinatorBotId: null,
  }

  return { request, input }
}
