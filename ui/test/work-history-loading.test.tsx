import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, expect, test } from "vitest"
import App from "../src/App"
import type { ApiRequest } from "../src/api/client"
import { createMockApi } from "../src/api/mock"

afterEach(cleanup)

test("opening an existing channel never shows the empty invitation while its first history is pending", async () => {
  const api = createMockApi()
  const { thread } = await api.request("POST /groups", {
    name: "Demonstração",
    color: "#558866",
    avatarShape: "cercle",
    memberIds: ["bot-mark"],
    coordinatorBotId: null,
  })
  let release: () => void = () => undefined
  const barrier = new Promise<void>((done) => {
    release = done
  })
  const request: ApiRequest = async (route, input, path) => {
    if (route === "GET /threads/:id/messages" && path?.id === thread.id) await barrier
    return api.request(route, input, path)
  }
  const client = { ...api, request }

  render(<App kernel={{ services: { api: client } }} />)
  fireEvent.click(await screen.findByRole("tab", { name: /^Work,/ }))
  const channels = await screen.findByRole("region", { name: "Canais", exact: true })
  fireEvent.click(await within(channels).findByText("Demonstração", { exact: true }))

  expect(await screen.findByRole("status", { name: "Carregando conversas…" })).toBeVisible()
  expect(screen.queryByRole("region", { name: "Comece a conversa em #Demonstração" })).not.toBeInTheDocument()
  await act(async () => release())
  await waitFor(() => expect(screen.queryByRole("status", { name: "Carregando conversas…" })).not.toBeInTheDocument())
})

test("retrying a failed first history read loads the conversation", async () => {
  const api = createMockApi()
  const { thread } = await api.request("POST /groups", {
    name: "Demonstração",
    color: "#558866",
    avatarShape: "cercle",
    memberIds: ["bot-mark"],
    coordinatorBotId: null,
  })
  await api.request(
    "POST /threads/:id/messages",
    {
      text: "O plano está salvo.",
      parentId: null,
      attachmentIds: [],
      sendId: crypto.randomUUID(),
    },
    { id: thread.id },
  )
  let failed = false
  const request: ApiRequest = async (route, input, path) => {
    if (route === "GET /threads/:id/messages" && path?.id === thread.id && !failed) {
      failed = true
      throw new Error("History request failed")
    }
    return api.request(route, input, path)
  }
  const client = Object.assign({}, api, { request })

  render(<App kernel={{ services: { api: client } }} />)
  fireEvent.click(await screen.findByRole("tab", { name: /^Work,/ }))
  const channels = await screen.findByRole("region", { name: "Canais", exact: true })
  fireEvent.click(await within(channels).findByText("Demonstração", { exact: true }))
  fireEvent.click(await screen.findByRole("button", { name: "Tentar novamente", exact: true }))

  expect(await screen.findByText("O plano está salvo.")).toBeVisible()
  expect(screen.queryByRole("status", { name: "Carregando conversas…" })).not.toBeInTheDocument()
})
