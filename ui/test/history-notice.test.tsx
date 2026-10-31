import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, expect, test, vi } from "vitest"
import { ChatPanel } from "../src/components/ChatPanel"
import { HistoryNotice } from "../src/components/HistoryNotice"
import type { HistoryFailure } from "../src/historyFailure"
import { getChannelBrowserWorkspaceFixture } from "./channel-browser-workspace-fixture"

afterEach(cleanup)

test("a failed read stays inside the conversation and keeps the saved messages in view", async () => {
  const fixture = await getChannelBrowserWorkspaceFixture()
  const onRetry = vi.fn(async () => {})

  render(
    <ChatPanel
      group={fixture.group}
      groupMembers={[fixture.bot]}
      browserRuns={[]}
      currentPersonId="person-requester"
      thread={fixture.thread}
      bot={fixture.bot}
      messages={[fixture.reply]}
      runs={[fixture.run]}
      historyLoading
      historyNotice={<HistoryNotice failure={getFailure("restarting")} onRetry={onRetry} />}
      onSend={vi.fn(async () => {})}
      onRetry={vi.fn(async () => {})}
      onCancel={vi.fn(async () => {})}
      onSwitchBranch={vi.fn(async () => {})}
      computerGrant={null}
      api={fixture.api}
      onComputerGrant={vi.fn()}
      onOpenTools={vi.fn()}
    />,
  )
  const notice = await screen.findByRole("alert")
  fireEvent.click(within(notice).getByRole("button", { name: "Tentar de novo" }))

  expect(notice.closest(".chat-panel")).not.toBeNull()
  expect(within(notice).getByText("Não conseguimos carregar as mensagens novas.")).toBeVisible()
  expect(within(notice).getByText("TOURI-E1009")).toBeVisible()
  expect(await screen.findByText(fixture.reply.text)).toBeVisible()
  expect(onRetry).toHaveBeenCalledOnce()
})

test.each([
  ["offline", "Você está sem conexão.", true],
  ["deleted", "Esta conversa foi apagada.", false],
  ["restarting", "O touri está reiniciando. Mostrando o que já estava salvo.", true],
  ["server", "O servidor do touri não respondeu. Mostrando o que já estava salvo.", true],
] as const)("the %s failure has its own copy", (kind, copy, retry) => {
  render(<HistoryNotice failure={getFailure(kind)} onRetry={vi.fn(async () => {})} />)

  expect(screen.getByText(copy)).toBeVisible()
  expect(screen.queryByRole("button", { name: "Tentar de novo" }) !== null).toBe(retry)
})

test("details open in place without hiding the code", () => {
  render(<HistoryNotice failure={getFailure("server")} onRetry={vi.fn(async () => {})} />)

  fireEvent.click(screen.getByRole("button", { name: "Detalhes" }))

  expect(screen.getByRole("button", { name: "Detalhes" })).toHaveAttribute("aria-expanded", "true")
  expect(screen.getByText(/HTTP 503 · server stopped/)).toBeVisible()
  expect(screen.getByText("TOURI-E1009")).toBeVisible()
})

const getFailure = (kind: HistoryFailure["kind"]): HistoryFailure => ({
  kind,
  code: "TOURI-E1009",
  diagnostic: "TOURI-E1009 · HTTP 503 · server stopped",
  threadId: "thread",
})
