import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { Message } from "@touri/contracts"
import { expect, it, vi } from "vitest"
import { VirtualMessageList } from "../src/components/ChatPanel"
import { OwnerProfileSettings } from "../src/components/OwnerProfileSettings"
import { PersonAvatar } from "../src/components/PersonAvatar"

const message: Message = {
  id: "owner-message",
  threadId: "thread",
  parentId: null,
  role: "user",
  kind: "text",
  status: "complete",
  runId: null,
  text: "Vamos trabalhar",
  parts: [],
  sender: null,
  source: "local",
  createdAt: 1,
  updatedAt: 1,
}
const callbacks = { onSwitchBranch: vi.fn(), onRetry: vi.fn(async () => {}) }

it("Work renders the owner's avatar, profile name and time in the header, preserving direct chat", () => {
  const profile = { name: "Pessoa Teste", avatar: null }
  const view = render(<VirtualMessageList {...callbacks} messages={[message]} work ownerProfile={profile} />)
  const row = view.container.querySelector("[data-message-id]")

  expect(row).toHaveAttribute("data-work-message", "true")
  expect(row?.querySelector(".message-meta")).toHaveTextContent("Pessoa Teste")
  expect(row?.querySelector(".message-meta time")).toBeTruthy()
  expect(row?.querySelector(".message-avatar")).toHaveTextContent("PT")
  view.rerender(<VirtualMessageList {...callbacks} messages={[message]} ownerProfile={profile} />)

  expect(view.container.querySelector("[data-work-message]")).toBeNull()
  expect(view.container.querySelector(".message-meta")).toBeNull()
})

it("photo removal restores initials and changing the name updates them", () => {
  const person = { id: "owner", avatarSeed: "owner", name: "Pessoa Teste" }
  const view = render(
    <PersonAvatar person={person} avatar={{ kind: "image", dataUrl: "data:image/png;base64,iVBORw0KGgo=" }} />,
  )

  expect(view.container.querySelector("img")).toHaveAttribute("src", expect.stringContaining("data:image/png"))
  view.rerender(<PersonAvatar person={person} avatar={null} />)

  expect(screen.queryByRole("img")).toBeNull()
  expect(screen.getByText("PT")).toBeVisible()
})

it("profile settings removes an existing avatar without changing the name", () => {
  const onChange = vi.fn()
  render(
    <OwnerProfileSettings
      profile={{ name: "Pessoa", avatar: { kind: "image", dataUrl: "data:image/png;base64,iVBORw0KGgo=" } }}
      onChange={onChange}
    />,
  )

  fireEvent.click(screen.getByRole("button", { name: "Remover avatar do perfil" }))

  expect(onChange).toHaveBeenCalledWith({ name: "Pessoa", avatar: null })
})

it("Work preserves queued delivery and editing after acknowledgement", async () => {
  const onEdit = vi.fn(async () => {})
  const delivery = { clientNonce: "test-message", deadline: 1000, status: "queued" as const }
  const view = render(<VirtualMessageList {...callbacks} messages={[{ ...message, delivery }]} work onEdit={onEdit} />)

  expect(screen.getByRole("status")).toHaveTextContent("Na fila · aguardando conexão")
  expect(screen.getByRole("button", { name: "Editar", exact: true })).toBeDisabled()
  view.rerender(
    <VirtualMessageList
      {...callbacks}
      messages={[{ ...message, delivery: { ...delivery, status: "acked" } }]}
      work
      onEdit={onEdit}
    />,
  )
  fireEvent.click(screen.getByRole("button", { name: "Editar", exact: true }))
  fireEvent.change(screen.getByRole("textbox", { name: "Editar mensagem" }), { target: { value: "Mensagem revisada" } })
  fireEvent.click(screen.getByRole("button", { name: "Salvar e enviar" }))

  await waitFor(() => expect(screen.queryByRole("textbox", { name: "Editar mensagem" })).toBeNull())
  expect(onEdit).toHaveBeenCalledWith("Mensagem revisada", null, [])
})
