import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ApiRoutes, BotGroup, Invite, InviteDelivery } from "@touri/contracts"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { UiApi } from "../src/api/client"
import { ApiError } from "../src/errors"
import { InvitePersonDialog } from "../src/features/people/InvitePersonDialog"
import { JoinPage } from "../src/features/people/JoinPage"
import { getInviteToken, isJoinPath, redeemInvite } from "../src/features/people/join"

const getChannel = (id: string, name: string): BotGroup => ({
  id,
  name,
  color: "#dc2626",
  avatarShape: "classic-none",
  avatarSeed: id,
  memberIds: [],
  coordinatorBotId: null,
  createdAt: 100,
  updatedAt: 100,
})

const getInvite = (input: Partial<Invite> = {}): Invite => ({
  id: "invite-1",
  name: "Ana Lima",
  email: "ana@exemplo.com",
  role: "member",
  channelIds: ["marketing"],
  createdByPersonId: "owner",
  status: "pending",
  createdAt: 100,
  expiresAt: 100 + 24 * 60 * 60_000,
  usedAt: null,
  revokedAt: null,
  ...input,
})

const getDelivery = (input: Partial<InviteDelivery> = {}): InviteDelivery => ({
  invite: getInvite(),
  emailConfigured: false,
  emailSent: false,
  link: "http://localhost/join#invite=abc",
  requestOriginReachability: "localhost",
  publicAddressReachability: "public",
  ...input,
})

type Request = UiApi["request"]

const getRequest = (handler: (route: keyof ApiRoutes, input: unknown) => unknown) => {
  const request: Request = async <Route extends keyof ApiRoutes>(route: Route, input: ApiRoutes[Route]["req"]) =>
    handler(route, input) as ApiRoutes[Route]["res"]

  return vi.fn(request)
}

const renderDialog = (request: Request) =>
  render(
    <InvitePersonDialog
      channels={[getChannel("marketing", "marketing"), getChannel("suporte", "suporte")]}
      initialChannelId="marketing"
      request={request}
      onClose={vi.fn()}
    />,
  )

const fillForm = async () => {
  await userEvent.type(screen.getByLabelText("Nome"), "Ana Lima")
  await userEvent.type(screen.getByLabelText("E-mail"), "ana@exemplo.com")
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("people invite dialog", () => {
  it("sends name, email, role and the chosen channels to POST /invites", async () => {
    const request = getRequest(() => getDelivery())
    renderDialog(request)

    await fillForm()
    await userEvent.click(screen.getByRole("radio", { name: /Administrador/ }))
    await userEvent.click(screen.getByRole("button", { name: "# suporte" }))
    await userEvent.click(screen.getByRole("button", { name: "Enviar convite" }))

    expect(request).toHaveBeenCalledWith("POST /invites", {
      name: "Ana Lima",
      email: "ana@exemplo.com",
      role: "admin",
      channelIds: ["marketing", "suporte"],
    })
  })

  it("allows a name without email and rejects an invalid email", async () => {
    renderDialog(getRequest(() => getDelivery()))

    expect(screen.getByRole("button", { name: "Enviar convite" })).toBeDisabled()
    await userEvent.type(screen.getByLabelText("Nome"), "Ana")
    await userEvent.type(screen.getByLabelText("E-mail"), "ana@")

    expect(screen.getByRole("button", { name: "Enviar convite" })).toBeDisabled()
  })

  it("explains that email is not configured and offers copy link without Reenviar", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } })
    renderDialog(getRequest(() => getDelivery()))

    await fillForm()
    await userEvent.click(screen.getByRole("button", { name: "Enviar convite" }))
    await userEvent.click(await screen.findByRole("button", { name: "Copiar link" }))

    expect(screen.getByText(/O envio de e-mail não está configurado/)).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Reenviar" })).not.toBeInTheDocument()
    expect(writeText).toHaveBeenCalledWith("http://localhost/join#invite=abc")
    expect(await screen.findByRole("status")).toHaveTextContent("Link copiado")
  })

  it("shows the sent state with Reenviar, Copiar link and Revogar when email left", async () => {
    const request = getRequest((route) =>
      route === "POST /invites"
        ? getDelivery({ emailConfigured: true, emailSent: true })
        : getDelivery({ emailConfigured: true, emailSent: true, link: "http://localhost/join#invite=novo" }),
    )
    renderDialog(request)

    await fillForm()
    await userEvent.click(screen.getByRole("button", { name: "Enviar convite" }))
    expect(await screen.findByText("Convite enviado para ana@exemplo.com")).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Reenviar" }))

    await waitFor(() => expect(request).toHaveBeenCalledWith("POST /invites/:id/resend", {}, { id: "invite-1" }))
    expect(screen.getByRole("button", { name: "Revogar" })).toBeInTheDocument()
  })

  it("revokes the invite and returns to the form with a confirmation", async () => {
    const request = getRequest((route) => (route === "POST /invites" ? getDelivery() : {}))
    renderDialog(request)

    await fillForm()
    await userEvent.click(screen.getByRole("button", { name: "Enviar convite" }))
    await userEvent.click(await screen.findByRole("button", { name: "Revogar" }))

    expect(await screen.findByRole("status")).toHaveTextContent("Convite revogado")
    expect(request).toHaveBeenCalledWith("DELETE /invites/:id", {}, { id: "invite-1" })
  })

  it("shows the link to select when the clipboard is unavailable", async () => {
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText: vi.fn().mockRejectedValue(new Error("no")) } })
    renderDialog(getRequest(() => getDelivery()))

    await fillForm()
    await userEvent.click(screen.getByRole("button", { name: "Enviar convite" }))
    await userEvent.click(await screen.findByRole("button", { name: "Copiar link" }))

    expect(await screen.findByLabelText("Link do convite")).toHaveValue("http://localhost/join#invite=abc")
  })

  it("tells a non-admin they cannot invite", async () => {
    const request = getRequest(() => {
      throw new ApiError(403, "Admin role required", "FORBIDDEN")
    })
    renderDialog(request)

    await fillForm()
    await userEvent.click(screen.getByRole("button", { name: "Enviar convite" }))

    expect(await screen.findByRole("alert")).toHaveTextContent("Só administradores podem convidar pessoas.")
  })
})

describe("join page", () => {
  it("reads the invite token from the URL fragment", () => {
    expect(getInviteToken("#invite=abc.123")).toBe("abc.123")
    expect(getInviteToken("")).toBe("")
    expect(isJoinPath("/join")).toBe(true)
    expect(isJoinPath("/")).toBe(false)
  })

  it("redeems the invite with the typed email and then opens the workspace", async () => {
    const redeem = vi.fn().mockResolvedValue({ ok: true })
    const onJoined = vi.fn()
    render(<JoinPage hash="#invite=abc" redeem={redeem} onJoined={onJoined} />)

    await userEvent.type(screen.getByLabelText("Seu nome"), "Ana")
    await userEvent.type(screen.getByLabelText("E-mail do convite"), "ana@exemplo.com")
    await userEvent.click(screen.getByRole("button", { name: "Entrar" }))

    await waitFor(() => expect(onJoined).toHaveBeenCalledTimes(1))
    expect(redeem).toHaveBeenCalledWith({
      token: "abc",
      email: "ana@exemplo.com",
      deviceName: "Navegador",
      name: "Ana",
    })
  })

  it("shows a clear message for an invalid invite and does not open the workspace", async () => {
    const redeem = vi.fn().mockResolvedValue({
      ok: false,
      message: "Convite inválido, expirado, já usado ou com outro e-mail. Peça um novo link a quem convidou.",
    })
    const onJoined = vi.fn()
    render(<JoinPage hash="#invite=abc" redeem={redeem} onJoined={onJoined} />)

    await userEvent.type(screen.getByLabelText("Seu nome"), "Ana")
    await userEvent.type(screen.getByLabelText("E-mail do convite"), "outra@exemplo.com")
    await userEvent.click(screen.getByRole("button", { name: "Entrar" }))

    expect(await screen.findByRole("alert")).toHaveTextContent("Convite inválido, expirado")
    expect(onJoined).not.toHaveBeenCalled()
  })

  it("explains a link without an invite token", () => {
    render(<JoinPage hash="" onJoined={vi.fn()} />)

    expect(screen.getByLabelText("Código do convite")).toHaveValue("")
    expect(screen.getByRole("button", { name: "Entrar" })).toBeDisabled()
  })

  it("posts the token and email to the redeem route and maps failures", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("{}", { status: 401 }))

    const result = await redeemInvite({ token: "abc", email: " Ana@Exemplo.com ", deviceName: " ", fetchImpl })

    expect(result).toMatchObject({ ok: false })
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("/api/v1/invites/redeem")
    expect(JSON.parse(String(init.body))).toEqual({ token: "abc", email: "Ana@Exemplo.com", deviceName: "Navegador" })
  })
})
