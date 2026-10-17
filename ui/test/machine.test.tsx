import { act, fireEvent, render, screen } from "@testing-library/react"
import { useState } from "react"
import { describe, expect, it, vi } from "vitest"
import { MachineFields } from "../src/components/MachineFields"

describe("Máquina settings", () => {
  it("keeps local default and explains an unavailable Linux host", () => {
    render(
      <MachineFields
        values={{ machine: "local", machineIdleMinutes: 15, vmProviderLogin: false, hostComputerUse: false }}
        provider="codex"
        capability={{ available: false, reason: "sem virtualização neste host", provider: null }}
        onChange={vi.fn()}
      />,
    )
    expect(screen.getByLabelText("Máquina")).toHaveValue("local")
    expect(screen.getByRole("option", { name: /indisponível neste computador/ })).toBeDisabled()
  })
  it("shows image progress, credential risk, status and requires reset confirmation", async () => {
    const action = vi.fn(async () => {})
    const Form = () => {
      const [values, setValues] = useState({
        machine: "vm" as const,
        machineIdleMinutes: 15,
        vmProviderLogin: false,
        hostComputerUse: false,
      })
      return (
        <MachineFields
          values={values}
          provider="claude"
          capability={{ available: true, reason: null, provider: "apple-container" }}
          state={{
            botId: "vm",
            status: "running",
            progress: "Imagem em cache",
            error: null,
            memoryMb: 2048,
            createdMs: 1,
            startMs: 1,
          }}
          onChange={(patch) => setValues((current) => ({ ...current, ...patch, machine: "vm" }))}
          onAction={action}
        />
      )
    }
    render(<Form />)
    expect(screen.getByRole("status")).toHaveTextContent("rodando")
    expect(screen.getByText("Imagem em cache")).toBeInTheDocument()
    expect(screen.getByText(/token gerado por claude setup-token/)).toBeInTheDocument()
    const login = screen.getByRole("switch", { name: /Usar meu login do Claude/ })
    expect(login).not.toBeChecked()
    fireEvent.click(login)
    expect(login).toBeChecked()
    fireEvent.click(screen.getByRole("button", { name: "Redefinir" }))
    expect(action).not.toHaveBeenCalled()
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Apagar e recriar" })))
    expect(action).toHaveBeenCalledWith(true, false)
  })
})
