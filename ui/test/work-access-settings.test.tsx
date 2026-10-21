import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import type { UiApi } from "../src/api/client"
import { WorkAccessSettings } from "../src/features/work/WorkAccessSettings"

const makeApi = (role: "admin" | "member" = "admin") => {
  const request = vi.fn(async (route: string, input: unknown) => {
    if (route === "GET /session")
      return {
        ok: true,
        kind: "device",
        person: {
          id: role === "admin" ? "owner" : "person-1",
          name: "Dani",
          email: null,
          avatarSeed: "owner",
          role,
        },
      }
    if (route === "GET /people")
      return {
        people: [
          {
            id: "person-1",
            name: "Ana",
            email: "ana@example.test",
            role: "member",
            devices: [{ id: "device-1", name: "Notebook", lastSeenAt: 1_800_000_000_000 }],
          },
        ],
      }
    if (route === "GET /invites")
      return {
        invites: [
          {
            id: "invite-1",
            name: "Bia",
            email: "bia@example.test",
            role: "member",
            expiresAt: 1_800_000_000_000,
            status: "pending",
          },
        ],
      }
    if (route === "GET /email")
      return {
        configured: true,
        configuration: {
          transport: "http",
          endpoint: "https://mail.example.test/send",
          fromEmail: "time@example.test",
          fromName: "Time",
          teamName: "Equipe A",
        },
      }
    if (route === "GET /public-address")
      return {
        address: "https://team.example.test",
        reachability: "public",
        requestOriginReachability: "private",
      }
    if (route === "POST /email/test") return { sent: true }
    if (route === "POST /pairing-codes") return { code: "ABCD-EFGH-JKLM", expiresAt: 1_800_000_300_000 }
    return input ? {} : {}
  })
  return { request, api: { request, isMock: false, subscribe: () => () => {} } as unknown as UiApi }
}

describe("work access settings", () => {
  it("keeps email credentials out of the form and exposes email, people, device, and invite actions", async () => {
    const { request, api } = makeApi()
    render(<WorkAccessSettings api={api} />)

    expect(await screen.findByText("E-mail")).toBeDefined()
    expect(screen.getByLabelText("Chave de API")).toHaveProperty("value", "")
    expect(screen.getByText("Ana")).toBeDefined()
    expect(screen.getByText("Notebook")).toBeDefined()
    expect(screen.getByText("bia@example.test")).toBeDefined()
    expect(screen.getByText(/esta sessão usa um endereço local ou privado/iu)).toBeDefined()

    fireEvent.change(screen.getByLabelText("E-mail para teste"), { target: { value: "admin@example.test" } })
    fireEvent.click(screen.getByRole("button", { name: "Enviar e-mail de teste" }))

    await waitFor(() => expect(request).toHaveBeenCalledWith("POST /email/test", { to: "admin@example.test" }))
  })

  it("creates a short-lived pairing code from a signed-in device", async () => {
    const { request, api } = makeApi()
    render(<WorkAccessSettings api={api} />)

    fireEvent.click(await screen.findByRole("button", { name: "Parear novo dispositivo" }))

    expect(await screen.findByText(/ABCD-EFGH-JKLM/u)).toBeDefined()
    expect(request).toHaveBeenCalledWith("POST /pairing-codes", {})
  })

  it("lets a member pair a device without requesting admin-only people settings", async () => {
    const { request, api } = makeApi("member")
    render(<WorkAccessSettings api={api} />)

    fireEvent.click(await screen.findByRole("button", { name: "Parear novo dispositivo" }))

    expect(await screen.findByText(/ABCD-EFGH-JKLM/u)).toBeDefined()
    expect(request).not.toHaveBeenCalledWith("GET /people", {})
    expect(request).not.toHaveBeenCalledWith("GET /invites", {})
  })
})
