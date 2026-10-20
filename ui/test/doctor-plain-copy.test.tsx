import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import type { DoctorCheck } from "@touri/contracts"
import { afterEach, expect, it, vi } from "vitest"
import { DoctorModal } from "../src/components/Modals"
import { DoctorChecks } from "../src/features/doctor/DoctorChecks"

// Synthetic diagnostics; never probe the host or contact a provider.
const getCheck = (values: Partial<DoctorCheck> = {}): DoctorCheck => ({
  id: "codex",
  label: "codex · versão",
  status: "pass",
  ok: true,
  detail: "Disponível em /example/bin/codex",
  fix: null,
  ...values,
})

afterEach(cleanup)

it("explains an installed tool without exposing its path until details are opened", () => {
  render(<DoctorChecks doctor={{ checks: [getCheck()] }} error={null} onRefresh={vi.fn()} />)

  expect(screen.getByText("Codex está instalado")).toBeVisible()
  const details = screen.getByRole("button", { name: "Detalhes técnicos" })
  expect(details).toHaveAttribute("aria-expanded", "false")
  expect(screen.getByText("Disponível em /example/bin/codex")).not.toBeVisible()
  fireEvent.click(details)
  expect(screen.getByText("codex · versão")).toBeVisible()
  expect(screen.getByText("Disponível em /example/bin/codex")).toBeVisible()
})

it("gives a failed sign-in a next step without claiming that it is ready", () => {
  render(
    <DoctorChecks
      doctor={{ checks: [getCheck({ id: "claude-auth", label: "claude · autenticação", status: "fail", ok: false })] }}
      error={null}
      onRefresh={vi.fn()}
    />,
  )

  expect(screen.getByText("O login do Claude precisa de atenção")).toBeVisible()
  expect(screen.getByText("Confira seu login do Claude e verifique novamente.")).toBeVisible()
  expect(screen.queryByText("Você está conectado ao Claude")).not.toBeInTheDocument()
})

it("keeps a suggested correction visible while hiding only its technical explanation", () => {
  render(
    <DoctorChecks
      doctor={{ checks: [getCheck({ status: "warn", ok: false, fix: "example-tool --repair" })] }}
      error={null}
      onRefresh={vi.fn()}
    />,
  )

  expect(screen.getByText("Codex precisa de atenção")).toBeVisible()
  expect(screen.getByText("example-tool --repair")).toBeVisible()
  expect(screen.getByRole("button", { name: "Copiar comando para codex · versão" })).toBeEnabled()
})

it("keeps the diagnostic dialog focused on checks, without its duplicate import action", () => {
  render(
    <DoctorModal
      doctor={{ checks: [] }}
      doctorError={null}
      onRefresh={vi.fn()}
      onClose={vi.fn()}
      launchAtLogin={false}
      onLaunchAtLogin={vi.fn()}
    />,
  )

  const dialog = screen.getByRole("dialog", { name: "Verificar suas ferramentas" })
  expect(within(dialog).queryByRole("button", { name: /Importar bots/ })).not.toBeInTheDocument()
  expect(within(dialog).getByRole("button", { name: "Concluído" })).toBeEnabled()
})

it("preserves an unfamiliar diagnostic and leaves vault authorization explicit", () => {
  render(
    <DoctorChecks
      doctor={{
        checks: [
          getCheck({
            id: "browser-session:synthetic",
            label: "Synthetic browser",
            status: "warn",
            ok: false,
            detail: "Synthetic vault status",
            action: "authorize-vault",
            vaultAccount: "fake-account",
            fix: "example-vault --repair",
          }),
        ],
      }}
      error={null}
      onRefresh={vi.fn()}
    />,
  )

  expect(screen.getByText("Synthetic browser")).toBeVisible()
  expect(screen.getByRole("button", { name: "Permitir acesso ao cofre" })).toBeEnabled()
  expect(screen.getByText("Permita o acesso ao cofre para restaurar a sessão salva do navegador.")).toBeVisible()
})
