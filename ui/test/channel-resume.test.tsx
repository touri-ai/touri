import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, expect, it } from "vitest"
import App from "../src/App"
import { createMockApi } from "../src/api/mock"
import { getResumeDraft } from "../src/components/DraftComposer"
import { requestTaskResume } from "../src/recoveryEvents"

afterEach(() => {
  cleanup()
  localStorage.clear()
})

const request =
  "Conferi as ações registradas. Quero continuar a tarefa a partir do estado atual, sem repetir ações já concluídas."

const openChannel = async () => {
  const api = createMockApi()
  const { group } = await api.request("POST /groups", {
    name: "Equipe QA",
    color: "#dc2626",
    avatarShape: "classic-none",
    memberIds: ["bot-mark", "bot-onb"],
    coordinatorBotId: null,
  })
  const { threads } = await api.request("GET /groups/:id/threads", {}, { id: group.id })
  const thread = threads[0]
  if (!thread) throw new Error("Missing channel conversation")
  render(<App kernel={{ services: { api } }} />)
  await screen.findByRole("textbox", { name: "Mensagem para mark" })
  fireEvent.click(screen.getByRole("tab", { name: /^Work,/ }))
  fireEvent.click(await screen.findByRole("button", { name: /^Equipe QA/ }))
  const input = await screen.findByRole("textbox", { name: "Mensagem para Equipe QA" })

  return { api, thread, input }
}

it("resumes the interrupted bot by name in a channel, not the bot that answered last", async () => {
  const { api, thread, input } = await openChannel()

  // mark was interrupted; onb answered later in the same channel.
  act(() => requestTaskResume(thread.id, "bot-mark"))

  expect(input).toHaveValue(`@mark ${request}`)
  expect(input).toHaveFocus()
  fireEvent.click(screen.getByRole("button", { name: "Enviar", exact: true }))
  await waitFor(() =>
    expect(
      api.calls.find((call) => call.route === "POST /threads/:id/messages" && call.pathValues.id === thread.id)?.input,
    ).toMatchObject({ text: `@mark ${request}` }),
  )
})

it("keeps an existing channel draft below the resume request", async () => {
  const { thread, input } = await openChannel()
  fireEvent.change(input, { target: { value: "Depois confira o relatório." } })

  act(() => requestTaskResume(thread.id, "bot-mark"))

  expect(input).toHaveValue(`@mark ${request}\n\nDepois confira o relatório.`)
})

it("builds the resume draft from the interrupted bot only", () => {
  expect(getResumeDraft("", "mark")).toBe(`@mark ${request}`)
  expect(getResumeDraft("", "Dev Bot")).toBe(`@"Dev Bot" ${request}`)
  expect(getResumeDraft("@mark já comecei", "mark")).toBe("@mark já comecei")
  expect(getResumeDraft("", undefined)).toBe(request)
  expect(getResumeDraft("Meu rascunho", undefined)).toBe("Meu rascunho")
})
