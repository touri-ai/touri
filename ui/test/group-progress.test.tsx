import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import App from "../src/App"
import { ChatPanel } from "../src/components/ChatPanel"
import { t } from "../src/i18n"
import { getGroupProgressFixture } from "./fixtures/groupProgress"

const getProps = () => {
  const fixture = getGroupProgressFixture()

  return {
    ...fixture,
    groupMembers: fixture.bots,
    messages: [fixture.request, fixture.reply],
    runs: [fixture.execution, fixture.coordination],
    computerGrant: null,
    onSend: vi.fn(async () => undefined),
    onRetry: vi.fn(async () => undefined),
    onCancel: vi.fn(async () => undefined),
    onSwitchBranch: vi.fn(async () => undefined),
    onComputerGrant: () => undefined,
    onOpenTools: () => undefined,
  }
}

const getProgressBlocks = (container: HTMLElement) => container.querySelectorAll(".activity-mark")
const getStopButtons = () => screen.getAllByRole("button", { name: "Parar", exact: true })

describe("channel progress", () => {
  it("hydrates one progress block, one connection check and only the global stop for a linked execution", () => {
    const props = getProps()

    const view = render(<ChatPanel {...props} runs={[props.coordination, props.execution]} />)

    expect(getProgressBlocks(view.container)).toHaveLength(1)
    expect(screen.getAllByRole("button", { name: "Verificar conexão" })).toHaveLength(1)
    expect(getStopButtons()).toHaveLength(1)
    expect(view.container.querySelectorAll("[data-pending-run]")).toHaveLength(0)
  })

  it("replaces coordination-only progress when its child attaches, before any child message exists", () => {
    const props = getProps()
    const view = render(<ChatPanel {...props} runs={[props.coordination]} messages={[props.request]} />)
    expect(getProgressBlocks(view.container)).toHaveLength(1)
    expect(view.container.querySelector("[data-pending-run]")).toHaveAttribute(
      "data-pending-run",
      props.coordination.id,
    )

    view.rerender(<ChatPanel {...props} messages={[props.request]} />)

    expect(getProgressBlocks(view.container)).toHaveLength(1)
    expect(view.container.querySelector("[data-pending-run]")).toHaveAttribute("data-pending-run", props.execution.id)
    expect(getStopButtons()).toHaveLength(1)
  })

  it("keeps separate executions visible, even for the same bot, with member stop actions in the existing menu", async () => {
    const props = getProps()
    const secondBot = props.bots[1]
    if (!secondBot) throw new Error("Missing second bot")
    const second = { ...props.execution, id: "second", botId: secondBot.id }
    const { groupTurnId: _turnId, ...standalone } = props.execution
    const independent = { ...standalone, id: "independent" }
    const finished = { ...props.execution, status: "succeeded" as const, finishedAt: Date.now() }
    const view = render(
      <ChatPanel
        {...props}
        runs={[props.coordination, props.execution, second, independent]}
        messages={[props.request]}
      />,
    )

    expect(getProgressBlocks(view.container)).toHaveLength(3)
    expect(getStopButtons()).toHaveLength(1)
    fireEvent.click(screen.getByRole("button", { name: "Ações do time" }))

    view.rerender(
      <ChatPanel {...props} runs={[props.coordination, finished, second, independent]} messages={[props.request]} />,
    )

    expect(screen.getAllByRole("menuitem", { name: `Parar ${props.bot.name}`, exact: true })).toHaveLength(1)
    expect(screen.getByRole("menuitem", { name: `Parar ${secondBot.name}`, exact: true })).toHaveFocus()
    fireEvent.click(screen.getByRole("menuitem", { name: `Parar ${secondBot.name}`, exact: true }))

    await waitFor(() => expect(props.onCancel).toHaveBeenCalledWith(second.id))
    expect(t("Stop {name}", { name: "Revisor" }, "en")).toBe("Stop Revisor")
  })

  it("keeps streamed text and terminal history while the global stop targets coordination regardless of row order", async () => {
    const props = getProps()
    const reply = {
      ...props.reply,
      text: "Estou conferindo.",
      parts: [{ type: "text" as const, text: "Estou conferindo." }],
    }
    const view = render(<ChatPanel {...props} messages={[props.request, reply]} />)
    await screen.findByText("Estou conferindo.")

    const stop = screen.getByRole("button", { name: "Parar", exact: true })
    fireEvent.click(stop)

    await waitFor(() => expect(props.onCancel).toHaveBeenCalledWith(props.coordination.id))
    view.rerender(
      <ChatPanel
        {...props}
        runs={props.runs.map((run) => ({ ...run, status: "canceled", finishedAt: Date.now() }))}
        messages={[props.request, { ...reply, status: "canceled" }]}
      />,
    )
    expect(await screen.findByText("Estou conferindo.")).toBeVisible()
    expect(screen.getByText(props.request.text)).toBeVisible()
    expect(getProgressBlocks(view.container)).toHaveLength(0)
    expect(screen.queryByRole("button", { name: "Parar", exact: true })).toBeNull()
  })

  it("does not bring coordination progress back after its child finishes before the parent", () => {
    const props = getProps()

    const view = render(
      <ChatPanel
        {...props}
        messages={[
          props.request,
          { ...props.reply, status: "complete", text: "Concluído.", parts: [{ type: "text", text: "Concluído." }] },
        ]}
        runs={[props.coordination, { ...props.execution, status: "succeeded", finishedAt: Date.now() }]}
      />,
    )

    expect(getProgressBlocks(view.container)).toHaveLength(0)
    expect(getStopButtons()).toHaveLength(1)
  })

  it("projects actual live run and message events into one visible block", async () => {
    const { api } = getGroupProgressFixture()
    await api.request("POST /groups", {
      name: "Equipe de exemplo",
      memberIds: ["bot-mark"],
      coordinatorBotId: "bot-mark",
      color: "#dc2626",
      avatarShape: "classic-none",
    })
    const view = render(<App kernel={{ services: { api } }} />)
    await screen.findByRole("textbox", { name: "Mensagem para mark" })
    fireEvent.click(screen.getByRole("tab", { name: /^Work,/ }))
    fireEvent.click(
      within(await screen.findByRole("region", { name: "Canais" })).getByRole("button", { name: /^Equipe de exemplo/ }),
    )
    await screen.findByRole("textbox", { name: "Mensagem para Equipe de exemplo" })
    const thread = api.getState().threads.find((candidate) => candidate.groupId)
    if (!thread) throw new Error("Missing channel")
    const fixture = getGroupProgressFixture(thread.id)
    act(() => {
      api.emit({ type: "message.created", message: fixture.request })
      api.emit({ type: "run.updated", run: fixture.coordination })
    })
    await waitFor(() => expect(getProgressBlocks(view.container)).toHaveLength(1))

    act(() => {
      api.emit({ type: "run.updated", run: fixture.execution })
      api.emit({ type: "message.created", message: fixture.reply })
    })

    await waitFor(() => expect(screen.getAllByRole("button", { name: "Verificar conexão" })).toHaveLength(1))
    expect(getProgressBlocks(view.container)).toHaveLength(1)
    expect(getStopButtons()).toHaveLength(1)
  })
})
