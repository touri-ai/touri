import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import App from "../src/App"
import { createMockApi } from "../src/api/mock"
import { GroupHeader } from "../src/components/Groups"
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
  it("shows a channel summary and keeps invitations separate from editing the channel", () => {
    const { bots, group } = getChannel()
    const onEdit = vi.fn()
    const onInvite = vi.fn()
    render(<GroupHeader group={group} bots={bots} onEdit={onEdit} onInvite={onInvite} channelMode />)

    expect(screen.getByText("Canais / Equipe QA")).toBeVisible()
    expect(screen.getByText("2 bots · mark coordena")).toBeVisible()
    expect(document.querySelector(".channel-heading-hash")).toHaveTextContent("#")
    expect(document.querySelector(".group-header-members")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Convidar pessoa" }))
    expect(onInvite).toHaveBeenCalledOnce()
    expect(onEdit).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole("button", { name: "Editar canal" }))
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
    expect(screen.getByRole("group", { name: "Ações do canal" })).toBeVisible()
    expect(screen.getByRole("heading", { name: "Comece a conversa em #Equipe QA" })).toBeVisible()
    expect(screen.getByText("Os bots só respondem quando você os chama com @nome.")).toBeVisible()
    expect(within(document.body).queryByText(/grupo/i)).toBeNull()
  })

  it("translates the channel copy in English", () => {
    expect(t("Message in channel", { name: "QA" }, "en")).toBe("Message #QA · @ calls a bot")
    expect(t("Invite to channel", {}, "en")).toBe("Invite to channel")
    expect(t("Channel composer actions", {}, "en")).toBe("Channel actions")
    expect(t("Channel summary with coordinator", { count: 2, name: "Alex" }, "en")).toBe("2 bots · Alex coordinates")
    expect(t("Start a conversation in channel {name}", { name: "qa" }, "en")).toBe("Start the conversation in #qa")
  })
})
