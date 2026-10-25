import { cleanup, render, screen } from "@testing-library/react"
import type { ChannelPerson } from "@touri/contracts"
import { afterEach, expect, test } from "vitest"
import {
  ChannelBrowserContext,
  ChannelCardFooter,
  ChannelComposerChip,
  ChannelHeaderChip,
  ChannelHiddenPreview,
} from "../src/features/channelBrowser/ChannelBrowser"
import { getChannelBrowserValue } from "../src/features/channelBrowser/channelBrowserModel"
import type { Locale } from "../src/i18n"
import { getChannelBrowserWorkspaceFixture } from "./channel-browser-workspace-fixture"

afterEach(cleanup)

const getPeople = (): ChannelPerson[] => [
  { id: "owner", name: "Owner", handle: "carla", avatarSeed: "carla", role: "admin" },
  { id: "person-requester", name: "Owner", handle: "ana", avatarSeed: "ana", role: "member" },
]

const renderBrowser = async (viewerId: string, locale: Locale) => {
  const fixture = await getChannelBrowserWorkspaceFixture({ viewerId, controllerId: "owner" })
  const run = Object.assign({}, fixture.browserRun, { requesterName: "Owner", controllerName: "Owner" })
  const queued = Object.assign({}, run, { runId: "queued-run", status: "queued" as const })
  const value = getChannelBrowserValue({
    runs: [run, queued],
    bots: [fixture.bot],
    people: getPeople(),
    threadId: fixture.thread.id,
    viewerId,
    runId: run.runId,
  })

  return render(
    <ChannelBrowserContext.Provider value={value}>
      <ChannelHeaderChip locale={locale} />
      <ChannelComposerChip botName="Léo" locale={locale} />
      <ChannelCardFooter locale={locale} />
      <ChannelHiddenPreview locale={locale} />
    </ChannelBrowserContext.Provider>,
  )
}

test("browser requester, controller, recipient and queue prefer current handles over saved names", async () => {
  const view = await renderBrowser("person-observer", "pt-BR")

  expect(
    screen.getByRole("status", { name: "Léo no navegador · pedido de ana · carla está no controle" }),
  ).toBeVisible()
  expect(view.container.querySelector(".composer-browser-status")).toHaveTextContent("carla está no controle")
  expect(view.container.querySelector(".channel-banner")).toHaveTextContent("chama ana")
  expect(screen.getByText("Na fila: pedido de ana")).toBeVisible()
  expect(view.container).not.toHaveTextContent("Owner")
})

test.each([
  { locale: "pt-BR" as const, request: "pedido de você", queue: "Na fila: pedido de você" },
  { locale: "en" as const, request: "request from you", queue: "Queued: request from you" },
])("browser self references use $locale in requests, handoffs and the queue", async ({ locale, request, queue }) => {
  const view = await renderBrowser("person-requester", locale)

  expect(view.container.querySelector(".channel-chip")).toHaveTextContent(request)
  expect(screen.getByText(queue)).toBeVisible()
  expect(view.container.querySelector(".channel-banner")).toHaveTextContent(
    locale === "en" ? "calls you" : "chama você",
  )
})

test.each([
  { locale: "pt-BR" as const, control: "Você está no controle", preview: "enquanto você digita" },
  { locale: "en" as const, control: "You are in control", preview: "while you type" },
])("browser self control uses correct grammar in $locale", async ({ locale, control, preview }) => {
  const view = await renderBrowser("owner", locale)

  expect(view.container.querySelector(".channel-chip")).toHaveTextContent(control)
  expect(view.container.querySelector(".composer-browser-status")).toHaveTextContent(control)
  expect(view.container.querySelector(".channel-hidden-preview")).toHaveTextContent(preview)
})
