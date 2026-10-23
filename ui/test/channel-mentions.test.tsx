import { fireEvent, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useRef, useState } from "react"
import { describe, expect, it, vi } from "vitest"
import { createMockApi } from "../src/api/mock"
import { Composer } from "../src/components/Composer"

const getComposer = (handle?: string) => {
  const api = createMockApi()
  const bots = api
    .getState()
    .bots.slice(0, 2)
    .map((bot, index) => ({
      ...bot,
      name: index ? "Revisor" : "Codador",
    }))
  const send = vi.fn().mockResolvedValue(undefined)
  const Harness = () => {
    const [draft, setDraft] = useState("")
    const input = useRef<HTMLTextAreaElement>(null)

    return (
      <Composer
        bot={null}
        groupName="produto"
        mentionBots={bots}
        mentionPeople={[
          { id: "ana", name: "Ana Silva", ...(handle ? { handle } : {}), avatarSeed: "ana", role: "member" },
        ]}
        summaryBotId={bots[1]?.id}
        api={api}
        threadId="channel"
        parentId={null}
        draft={draft}
        onDraft={setDraft}
        inputRef={input}
        activeRun={null}
        queuedCount={0}
        onSend={send}
        onCancel={async () => {}}
      />
    )
  }
  render(<Harness />)

  return { input: screen.getByRole("textbox"), send }
}

describe("channel mentions", () => {
  it("offers bots and people, completes inline mentions with the keyboard and keeps typing", async () => {
    const user = userEvent.setup()
    const { input, send } = getComposer()

    await user.type(input, "@")

    expect(within(screen.getByRole("listbox")).getAllByRole("option")).toHaveLength(3)
    await user.keyboard("{ArrowUp}{Enter}")
    expect(input).toHaveValue('@"Ana Silva" ')
    expect(screen.queryByRole("group", { name: "Membros mencionados" })).toBeNull()
    expect(send).not.toHaveBeenCalled()

    await user.type(input, "oi @cod")
    expect(screen.getByRole("option", { name: "@Codador" })).toBeVisible()
    await user.keyboard("{Tab}")
    expect(input).toHaveValue('@"Ana Silva" oi @Codador ')
    expect(input).toHaveFocus()
  })

  it("offers the stable handle when the person's display name differs", async () => {
    const user = userEvent.setup()
    const { input, send } = getComposer("ana.silva")

    await user.type(input, "@ana.")
    await user.keyboard("{Enter}")

    expect(input).toHaveValue("@ana.silva ")
    expect(send).not.toHaveBeenCalled()
  })

  it("keeps names with a matching prefix as ordinary draft text", async () => {
    const user = userEvent.setup()
    const { input, send } = getComposer()

    await user.type(input, "@CodadorExtra oi")

    expect(input).toHaveValue("@CodadorExtra oi")
    expect(screen.queryByRole("group", { name: "Membros mencionados" })).toBeNull()
    expect(send).not.toHaveBeenCalled()
  })

  it("positions the caret after a completed mention before the next keyboard event", () => {
    const { input, send } = getComposer()
    if (!(input instanceof HTMLTextAreaElement)) throw new Error("Composer missing")
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: "@cod tarefa", selectionStart: 4, selectionEnd: 4 } })

    fireEvent.keyDown(input, { key: "Enter" })

    expect(input).toHaveValue("@Codador  tarefa")
    expect(input.selectionStart).toBe(9)
    expect(input.selectionEnd).toBe(9)
    expect(send).not.toHaveBeenCalled()
  })

  it("dismisses suggestions with Escape and preserves the draft", async () => {
    const user = userEvent.setup()
    const { input, send } = getComposer()

    await user.type(input, "@rev")
    await user.keyboard("{Escape}")

    expect(screen.queryByRole("listbox")).toBeNull()
    expect(input).toHaveValue("@rev")
    expect(send).not.toHaveBeenCalled()
  })

  it("explicitly mentions everyone for the broadcast action and only the summary bot for summaries", async () => {
    const user = userEvent.setup()
    const { input, send } = getComposer()

    await user.type(input, "revisem")
    await user.click(screen.getByRole("button", { name: "Ações do time" }))
    await user.click(screen.getByRole("menuitem", { name: "Perguntar a todos" }))

    expect(send).toHaveBeenLastCalledWith("@Codador @Revisor revisem", null, [], "ask_all")
    await user.click(screen.getByRole("button", { name: "Ações do time" }))
    await user.click(screen.getByRole("menuitem", { name: "Pedir resumo do time" }))
    expect(send).toHaveBeenLastCalledWith(expect.stringMatching(/^@Revisor /), null, [], "summarize")
  })

  it("shows the channel placeholder and does not treat IME Enter as mention selection", () => {
    const { input, send } = getComposer()

    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: "@", selectionStart: 1 } })
    fireEvent.keyDown(input, { key: "Enter", isComposing: true, keyCode: 229 })

    expect(input).toHaveAttribute("placeholder", "Mensagem em #produto")
    expect(input).toHaveValue("@")
    expect(send).not.toHaveBeenCalled()
  })
})
