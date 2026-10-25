import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import type { ApiRequest } from "../src/api/client"
import { createMockApi } from "../src/api/mock"
import { BotSettingsModal } from "../src/components/Modals"
import type { WorkspaceActions } from "../src/useWorkspace"

afterEach(cleanup)

const makeEditor = (instructions: Promise<{ instructions: string }>, initialSection?: "model") => {
  const base = createMockApi()
  const original = base.getState().bots[0]
  if (!original) throw new Error("Missing fixture")
  const bot = Object.assign({}, original, { instructions: "", instructionsDeferred: true })
  const request = (async (route, input, path, transport) => {
    if (route === "GET /bots/:id/instructions") return instructions
    return base.request(route, input, path, transport)
  }) as ApiRequest
  const api = Object.assign({}, base, { request })
  const updateBot = vi.fn<WorkspaceActions["updateBot"]>(async () => {})
  const actions = { updateBot } as Partial<WorkspaceActions> as WorkspaceActions
  render(
    <BotSettingsModal
      bot={bot}
      api={api}
      projects={[]}
      routines={[]}
      actions={actions}
      onClose={() => {}}
      initialSection={initialSection}
    />,
  )
  return { updateBot }
}

it("never saves the deferred placeholder while the full text is loading", async () => {
  const pending = Promise.withResolvers<{ instructions: string }>()
  const { updateBot } = makeEditor(pending.promise)

  fireEvent.change(screen.getByRole("textbox", { name: "Nome" }), { target: { value: "Nome atualizado" } })
  fireEvent.click(screen.getByRole("button", { name: "Salvar configurações" }))
  await waitFor(() => expect(updateBot).toHaveBeenCalled())

  expect(updateBot.mock.calls[0]?.[1]).not.toHaveProperty("instructions")
  pending.resolve({ instructions: "Texto preservado" })
})

it("loads full instructions for editing and only includes them when changed", async () => {
  const { updateBot } = makeEditor(Promise.resolve({ instructions: "Texto completo fictício" }), "model")
  const editor = await screen.findByRole("textbox", { name: "Instruções do bot" })
  await waitFor(() => expect(editor).toHaveValue("Texto completo fictício"))

  fireEvent.change(editor, { target: { value: "Novas instruções" } })
  fireEvent.click(screen.getByRole("button", { name: "Salvar configurações" }))
  await waitFor(() => expect(updateBot).toHaveBeenCalled())

  expect(updateBot.mock.calls[0]?.[1]).toHaveProperty("instructions", "Novas instruções")
})
