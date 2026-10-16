import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { Bot } from "@touri/contracts"
import { useRef, useState } from "react"
import { afterEach, expect, it, vi } from "vitest"
import { createMockApi } from "../src/api/mock"
import { Composer } from "../src/components/Composer"
import { dropRejectionMessage, fileDragEvent, fileDropEvent, parseFileDrop } from "../src/fileDrops"

type Listener = (event: { payload: unknown }) => void
const listeners = vi.hoisted(() => new Map<string, Listener>())
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: Listener) => {
    listeners.set(name, handler)
    return () => listeners.delete(name)
  }),
}))
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), convertFileSrc: (path: string) => path }))

afterEach(() => {
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__")
  listeners.clear()
})

const GRANT = "a".repeat(64)
const emit = (name: string, payload: unknown) => act(() => listeners.get(name)?.({ payload }))

const setup = () => {
  Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} })
  const api = createMockApi()
  const bot = api.getState().bots[0] as Bot
  const Harness = () => {
    const [text, setText] = useState("")
    const input = useRef<HTMLTextAreaElement>(null)
    return (
      <Composer
        bot={bot}
        api={api}
        threadId="t"
        parentId="p"
        draft={text}
        onDraft={setText}
        inputRef={input}
        activeRun={null}
        queuedCount={0}
        onSend={vi.fn().mockResolvedValue(undefined)}
        onCancel={vi.fn()}
        onOpenPermissions={vi.fn()}
      />
    )
  }
  render(<Harness />)
  return api
}

it("parseFileDrop keeps only well-formed grant ids and drops raw paths", () => {
  const drop = parseFileDrop({
    granted: [{ id: GRANT, name: "a.txt", path: "/etc/passwd" }, { id: "../etc", name: "x" }, { id: GRANT }],
    rejected: [
      { name: "pasta", reason: "directory" },
      { name: "x", reason: "bogus" },
    ],
  })
  expect(drop).toEqual({ granted: [{ id: GRANT, name: "a.txt" }], rejected: [{ name: "pasta", reason: "directory" }] })
})

it("shows the pt-BR drop affordance while the shell reports a native drag", async () => {
  setup()
  await waitFor(() => expect(listeners.has(fileDragEvent)).toBe(true))
  await emit(fileDragEvent, { active: true })
  expect(screen.getByText("Solte para anexar")).toBeInTheDocument()
  await emit(fileDragEvent, { active: false })
  expect(screen.queryByText("Solte para anexar")).toBeNull()
})

it("attaches a native drop through its grant id and never sends a path", async () => {
  const api = setup()
  await waitFor(() => expect(listeners.has(fileDropEvent)).toBe(true))
  await emit(fileDropEvent, { granted: [{ id: GRANT, name: "plano.md" }], rejected: [] })
  await waitFor(() => expect(screen.getByText("plano.md")).toBeInTheDocument())
  const calls = api.calls.filter((call) => call.route === "POST /attachments")
  expect(calls).toHaveLength(1)
  expect(JSON.stringify(calls[0])).toContain(GRANT)
  expect(JSON.stringify(calls[0])).not.toContain('"path"')
})

it("reports rejected drops in Portuguese", async () => {
  setup()
  await waitFor(() => expect(listeners.has(fileDropEvent)).toBe(true))
  await emit(fileDropEvent, { granted: [], rejected: [{ name: "docs", reason: "directory" }] })
  expect(await screen.findByText(/Não foi possível anexar docs: é uma pasta/)).toBeInTheDocument()
  expect(dropRejectionMessage({ name: "g.iso", reason: "too_large" })).toContain("mais de 15 MB")
})

it("browser clients keep uploading bytes from HTML5 drops without native grants", async () => {
  const api = createMockApi()
  const bot = api.getState().bots[0] as Bot
  render(
    <Composer
      bot={bot}
      api={api}
      threadId="t"
      parentId="p"
      draft=""
      onDraft={vi.fn()}
      inputRef={{ current: null }}
      activeRun={null}
      queuedCount={0}
      onSend={vi.fn().mockResolvedValue(undefined)}
      onCancel={vi.fn()}
      onOpenPermissions={vi.fn()}
    />,
  )
  expect(listeners.size).toBe(0)
  const form = screen.getByRole("form", { name: "Compor mensagem" })
  fireEvent.dragOver(form, { dataTransfer: { types: ["Files"], files: [] } })
  expect(screen.getByText("Solte para anexar")).toBeInTheDocument()
  fireEvent.drop(form, { dataTransfer: { types: ["Files"], files: [new File(["a"], "nota.md")] } })
  await waitFor(() => expect(screen.getByText("nota.md")).toBeInTheDocument())
})
