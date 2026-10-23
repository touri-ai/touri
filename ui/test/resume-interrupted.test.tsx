import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import type { Message } from "@touri/contracts"
import { afterEach, expect, it, vi } from "vitest"
import { createMockApi } from "../src/api/mock"
import { VirtualMessageList } from "../src/components/ChatPanel"
import { SettingsModal } from "../src/components/Modals"
import { setDocumentLanguage } from "../src/documentLanguage"

afterEach(() => {
  cleanup()
  setDocumentLanguage("pt-BR", document.documentElement)
})

const message = (overrides: Partial<Message>): Message => ({
  id: "m",
  threadId: "t1",
  parentId: null,
  role: "assistant",
  kind: "text",
  status: "complete",
  runId: null,
  text: "",
  parts: [],
  sender: null,
  source: "local",
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
})

it.each(["Retomado após reinício do touri", "Retomado após aprovação de acesso"])(
  "shows %s as a marker in the thread, not as a message",
  (text) => {
    render(
      <VirtualMessageList
        messages={[
          message({ id: "partial", text: "Comecei a tabela.", parts: [{ type: "text", text: "Comecei a tabela." }] }),
          message({
            id: "marker",
            parentId: "partial",
            role: "system",
            kind: "notice",
            text,
            parts: [{ type: "notice", level: "info", code: "run_resumed", text }],
            createdAt: 2,
          }),
          message({
            id: "reply",
            parentId: "marker",
            text: "Terminei.",
            parts: [{ type: "text", text: "Terminei." }],
            createdAt: 3,
          }),
        ]}
        onSwitchBranch={async () => {}}
        onRetry={async () => {}}
      />,
    )
    const marker = screen.getByRole("note")
    expect(marker).toHaveTextContent(text)
    expect(marker).toHaveClass("run-resumed-marker")
    expect(marker.closest(".message-bubble")).toBeNull()
    expect(screen.getByText("Terminei.")).toBeInTheDocument()
  },
)

it.each([
  { locale: "pt-BR" as const, expected: "Retomando a resposta automaticamente…" },
  { locale: "en" as const, expected: "Resuming the answer automatically…" },
])("localizes the automatic channel recovery marker to $locale", ({ locale, expected }) => {
  setDocumentLanguage(locale, document.documentElement)
  const text = "Retomando a resposta automaticamente…"
  const marker = message({
    role: "system",
    kind: "notice",
    text,
    parts: [{ type: "notice", level: "info", code: "run_resumed", text }],
  })

  render(<VirtualMessageList messages={[marker]} onSwitchBranch={vi.fn()} onRetry={vi.fn()} />)

  expect(screen.getByRole("note")).toHaveTextContent(expected)
})

it("the resume setting is on by default and saving it off persists through the settings API", async () => {
  const onSave = vi.fn(async () => undefined)
  render(<SettingsModal settings={null} initialSection="general" onClose={() => undefined} onSave={onSave} />)
  const toggle = screen.getByRole("switch", { name: /Retomar turnos interrompidos/ })
  expect(toggle).toBeChecked()
  fireEvent.click(toggle)
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Salvar preferências" })))
  expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ resumeInterruptedTurns: false }))
})

it("the mock scenario seeds an interrupted turn followed by its continuation", async () => {
  const api = createMockApi({ scenario: "resumed-turn" })
  const { messages } = await api.request("GET /threads/:id/messages", {}, { id: "thread-mark" })
  const marker = messages.find((item) =>
    item.parts.some((part) => part.type === "notice" && part.code === "run_resumed"),
  )
  expect(marker?.text).toBe("Retomado após reinício do touri")
  expect(messages.at(-1)).toMatchObject({ parentId: marker?.id, role: "assistant", status: "complete" })
  expect((await api.request("GET /settings", {})).settings.resumeInterruptedTurns).toBe(true)
})
