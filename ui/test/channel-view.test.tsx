import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import App from "../src/App"
import { createMockApi } from "../src/api/mock"
import { GroupHeader } from "../src/components/Groups"
import { SidebarActionsMenu } from "../src/components/SidebarActionsMenu"
import { t } from "../src/i18n"

afterEach(cleanup)

const getChannel = () => {
  const bots = createMockApi().getState().bots.slice(0, 2)

  return {
    bots,
    group: {
      id: "channel-qa",
      name: "Equipe QA",
      memberIds: bots.map(({ id }) => id),
      coordinatorBotId: bots[0]?.id,
      color: "#dc2626",
      avatarShape: "classic-none" as const,
      avatarSeed: "channel-qa",
      createdAt: 1,
      updatedAt: 1,
    },
  }
}

describe("channel view", () => {
  it("dismisses a team menu from its trigger when every action is disabled", () => {
    const onOpenChange = vi.fn()
    render(
      <SidebarActionsMenu
        label="Ações do time"
        open
        onOpenChange={onOpenChange}
        actions={[
          { label: "Perguntar a todos", onSelect: vi.fn(), disabled: true },
          { label: "Pedir resumo do time", onSelect: vi.fn(), disabled: true },
        ]}
      />,
    )
    const trigger = screen.getByRole("button", { name: "Ações do time" })
    trigger.focus()

    fireEvent.keyDown(trigger, { key: "Escape" })

    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(trigger).toHaveFocus()
  })

  it("focuses an enabled team action when the empty composer disables asking everyone", () => {
    render(
      <SidebarActionsMenu
        label="Ações do time"
        open
        onOpenChange={vi.fn()}
        actions={[
          { label: "Perguntar a todos", onSelect: vi.fn(), disabled: true },
          { label: "Pedir resumo do time", onSelect: vi.fn() },
        ]}
      />,
    )
    const summary = screen.getByRole("menuitem", { name: "Pedir resumo do time" })

    expect(summary).toHaveFocus()
    fireEvent.keyDown(summary, { key: "Home" })
    expect(summary).toHaveFocus()
    fireEvent.keyDown(summary, { key: "ArrowDown" })
    expect(summary).toHaveFocus()
  })

  it("shows only the channel name, a member group that opens the panel and one menu for the rest", () => {
    const { bots, group } = getChannel()
    const onEdit = vi.fn()
    const onInvite = vi.fn()
    const onTogglePanel = vi.fn()
    render(
      <GroupHeader
        group={group}
        bots={bots}
        onEdit={onEdit}
        onInvite={onInvite}
        panelOpen={false}
        onTogglePanel={onTogglePanel}
        channelMode
      />,
    )
    const header = document.querySelector<HTMLElement>(".group-header")
    if (!header) throw new Error("Missing channel header")

    expect(within(header).queryByText(/Canais \//)).toBeNull()
    expect(header.querySelector(".channel-heading-hash")).toHaveTextContent("#")
    expect(within(header).getByText("Equipe QA")).toBeVisible()
    expect(within(header).getAllByRole("button")).toHaveLength(2)
    fireEvent.click(within(header).getByRole("button", { name: "Membros do canal: 2 bots" }))
    expect(onTogglePanel).toHaveBeenCalledOnce()

    fireEvent.click(within(header).getByRole("button", { name: "Ações do canal Equipe QA" }))
    fireEvent.click(screen.getByRole("menuitem", { name: "Convidar pessoa" }))
    expect(onInvite).toHaveBeenCalledOnce()
    expect(onEdit).not.toHaveBeenCalled()

    fireEvent.click(within(header).getByRole("button", { name: "Ações do canal Equipe QA" }))
    fireEvent.click(screen.getByRole("menuitem", { name: "Editar canal" }))
    expect(onEdit).toHaveBeenCalledOnce()
  })

  it("uses a calm channel placeholder and no group wording in the composer", async () => {
    const api = createMockApi()
    await api.request("POST /groups", {
      name: "Equipe QA",
      color: "#dc2626",
      avatarShape: "classic-none",
      memberIds: ["bot-mark", "bot-onb"],
      coordinatorBotId: "bot-mark",
    })
    window.localStorage.setItem("touri.sidebar.mode", "work")
    render(<App kernel={{ services: { api } }} />)
    await screen.findByRole("textbox", { name: "Mensagem para mark" })
    fireEvent.click(within(screen.getByRole("region", { name: "Canais" })).getByRole("button", { name: /^Equipe QA/ }))
    const composer = await screen.findByRole("textbox", { name: "Mensagem para Equipe QA" })
    expect(composer).toHaveAttribute("placeholder", "Mensagem em #Equipe QA · @ chama um bot")
    expect(screen.getByRole("button", { name: "Ações do time" })).toBeVisible()
    expect(screen.queryByRole("button", { name: "Perguntar a todos" })).toBeNull()
    const start = screen.getByRole("region", { name: "Comece a conversa em #Equipe QA" })
    expect(within(start).getByRole("heading", { name: "Comece a conversa em #Equipe QA" })).toBeVisible()
    expect(within(start).getByRole("list", { name: "Membros do canal" }).children).toHaveLength(2)
    expect(within(start).getByText("Os bots só respondem quando você os chama com @nome.")).toBeVisible()
    expect(within(document.body).queryByText(/grupo/i)).toBeNull()
  })

  it("translates the channel copy in English", () => {
    expect(t("Message in channel", { name: "QA" }, "en")).toBe("Message #QA · @ calls a bot")
    expect(t("Invite to channel", {}, "en")).toBe("Invite to channel")
    expect(t("Team actions", {}, "en")).toBe("Team actions")
    expect(t("Channel members summary", { summary: "1 person · 2 bots" }, "en")).toBe(
      "Channel members: 1 person · 2 bots",
    )
    expect(t("Channel summary with coordinator", { count: 2, name: "Alex" }, "en")).toBe("2 bots · Alex coordinates")
    expect(t("Start a conversation in channel {name}", { name: "qa" }, "en")).toBe("Start the conversation in #qa")
  })
})
