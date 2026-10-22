import { cleanup, render, screen } from "@testing-library/react"
import type { BotGroup } from "@touri/contracts"
import { afterEach, expect, test } from "vitest"
import { createMockApi } from "../src/api/mock"
import { GroupPanel } from "../src/components/GroupPanel"
import { GroupHeader } from "../src/components/Groups"
import { localizeNotice, t } from "../src/i18n"

afterEach(cleanup)

const getGroup = (): BotGroup => ({
  id: "team",
  name: "Viagens",
  color: "#888888",
  avatarShape: "circle",
  avatarSeed: "team",
  memberIds: [],
  coordinatorBotId: null,
  createdAt: 1,
  updatedAt: 1,
})

test("the channel panel lists human members without exposing administrative fields", async () => {
  const api = createMockApi()
  const request = api.request
  const rosterApi = Object.assign({}, api, {
    request: ((route, body, params, transport) => {
      if (route === "GET /groups/:id/people")
        return Promise.resolve({
          people: [{ id: "ana", name: "Ana", handle: "ana.silva", avatarSeed: "ana", role: "member" }],
        })

      return request(route, body, params, transport)
    }) as typeof request,
  })

  render(
    <GroupPanel
      group={getGroup()}
      api={rosterApi}
      bots={[]}
      messages={[]}
      runs={[]}
      onClose={() => {}}
      onEdit={() => {}}
      channelMode
    />,
  )

  expect(await screen.findByText("Ana")).toBeVisible()
  expect(screen.getByText("Pessoa · @ana.silva")).toBeVisible()
})

test("the channel header counts people and bots in both languages", () => {
  render(
    <GroupHeader
      group={getGroup()}
      bots={[]}
      people={[{ id: "ana", name: "Ana", avatarSeed: "ana", role: "member" }]}
      onEdit={() => {}}
      channelMode
    />,
  )

  const members = screen.getByRole("img", { name: "Membros do canal: 1 pessoa · 0 bots" })
  expect(members).toHaveTextContent("A1")
  expect(members).toHaveAttribute("aria-label", "Membros do canal: 1 pessoa · 0 bots")
  expect(t("1 person", {}, "en")).toBe("1 person")
  expect(t("{count} people", { count: 2 }, "en")).toBe("2 people")
})

test("legacy application browser notices and public address guidance are localized", () => {
  expect(localizeNotice("Browser takeover")).toBe("Controle do navegador")
  expect(localizeNotice("needs you in the browser: synthetic reason")).toBe("O navegador precisa da sua ajuda.")
  expect(localizeNotice("Done")).toBe("Concluído")
  expect(t("Informe um endereço HTTPS válido, sem caminho.", {}, "en")).toBe(
    "Enter a valid HTTPS address without a path.",
  )
})
