import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useState } from "react"
import { afterEach, expect, it, vi } from "vitest"
import { createMockApi } from "../src/api/mock"
import { BotCreateModal, BotSettingsModal, Modal, SettingsModal } from "../src/components/Modals"
import { SettingsSwitch } from "../src/components/SettingsLayout"
import { readTheme } from "../src/design/theme"
import { DoctorChecks } from "../src/features/doctor/DoctorChecks"
import type { WorkspaceActions } from "../src/useWorkspace"

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

it("saves the VM memory preference from General and refuses invalid caps", async () => {
  const save = vi.fn(async () => undefined)
  render(<SettingsModal settings={null} onClose={vi.fn()} onSave={save} />)
  fireEvent.click(screen.getByRole("tab", { name: "Geral" }))
  const memory = screen.getByLabelText("Memória por computador do bot (MiB)")
  expect(memory).toHaveValue(1536)
  fireEvent.change(memory, { target: { value: "256" } })
  fireEvent.click(screen.getByRole("button", { name: "Salvar preferências" }))
  expect(save).not.toHaveBeenCalled()
  expect(screen.getByRole("alert")).toHaveTextContent("512")
  fireEvent.change(memory, { target: { value: "1024" } })
  fireEvent.click(screen.getByRole("button", { name: "Salvar preferências" }))
  await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ botVmMemoryMb: 1024 })))
})
const next = () => fireEvent.click(screen.getByRole("button", { name: "Continuar" }))

it("defaults detail retention to 30 days, validates the range and saves keep-forever in Privacy", async () => {
  const save = vi.fn(async () => undefined)
  render(<SettingsModal settings={null} onClose={vi.fn()} onSave={save} />)
  fireEvent.click(screen.getByRole("tab", { name: "Privacidade" }))
  const retention = screen.getByLabelText("Retenção dos detalhes")
  expect(retention).toHaveValue(30)
  fireEvent.change(retention, { target: { value: "-1" } })
  fireEvent.click(screen.getByRole("button", { name: "Salvar preferências" }))
  expect(save).not.toHaveBeenCalled()
  expect(screen.getByRole("alert")).toHaveTextContent("3.650")
  fireEvent.change(retention, { target: { value: "0" } })
  fireEvent.click(screen.getByRole("button", { name: "Salvar preferências" }))
  await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ dataRetentionDays: 0 })))
})

it("collects all five steps without creating a bot early and preserves choices when going back", async () => {
  const user = userEvent.setup()
  const create = vi.fn(async () => undefined)
  render(<BotCreateModal onClose={vi.fn()} onCreate={create} />)
  expect(screen.getByRole("button", { name: "Continuar" })).toBeDisabled()
  fireEvent.change(screen.getByLabelText("Nome"), { target: { value: " Clara " } })
  fireEvent.click(screen.getByRole("button", { name: "Forma Nuvem" }))
  next()
  expect(screen.getByLabelText("Função")).toHaveAccessibleDescription(
    "Resumo do trabalho do bot na equipe, por exemplo: pesquisar e comparar fontes.",
  )
  expect(screen.getByLabelText("Título (opcional)")).toHaveAccessibleDescription(
    "Uma identificação curta, por exemplo: Pesquisador. As tarefas detalhadas vão nas instruções.",
  )
  expect(screen.getByLabelText("Instruções do bot")).toHaveAccessibleDescription(
    "Orientações detalhadas para o bot. Salvas no arquivo SOUL.md na pasta do bot.",
  )
  fireEvent.change(screen.getByLabelText("Função"), { target: { value: "Pesquisa" } })
  fireEvent.change(screen.getByLabelText("Título (opcional)"), { target: { value: "Pesquisador" } })
  fireEvent.change(screen.getByLabelText("Instruções do bot"), { target: { value: "Responda em português." } })
  next()
  fireEvent.change(screen.getByLabelText("Modelo"), { target: { value: "gpt-6.1-sol" } })
  fireEvent.click(screen.getByRole("button", { name: "Voltar" }))
  expect(screen.getByLabelText("Instruções do bot")).toHaveValue("Responda em português.")
  next()
  expect(screen.getByLabelText("Modelo")).toHaveValue("gpt-6.1-sol")
  next()
  const browser = screen.getByRole("switch", { name: "Navegador habilitado" })
  browser.focus()
  await user.keyboard(" ")
  expect(browser).not.toBeChecked()
  next()
  expect(create).not.toHaveBeenCalled()
  expect(screen.getByRole("heading", { name: "Revisar e criar" })).toBeVisible()
  expect(screen.getByText("Responda em português.")).toBeVisible()
  fireEvent.click(screen.getByRole("button", { name: "Criar bot" }))
  await waitFor(() =>
    expect(create).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        name: "Clara",
        roleLine: "Pesquisa",
        title: "Pesquisador",
        instructions: "Responda em português.",
        model: "gpt-6.1-sol",
        avatarShape: "nuage",
        browserEnabled: false,
        machine: "local",
      }),
    ),
  )
})

it("uses native, labelled switches with Space activation and a disabled state", async () => {
  const user = userEvent.setup()
  const change = vi.fn()
  const Harness = () => {
    const [checked, setChecked] = useState(false)
    return (
      <>
        <label htmlFor="example-switch">Receber avisos</label>
        <SettingsSwitch id="example-switch" checked={checked} onChange={(event) => setChecked(event.target.checked)} />
        <SettingsSwitch aria-label="Opção indisponível" disabled checked={false} onChange={change} />
      </>
    )
  }
  render(<Harness />)
  const control = screen.getByRole("switch", { name: "Receber avisos" })
  expect(control).toHaveAttribute("type", "checkbox")
  await user.click(screen.getByText("Receber avisos"))
  expect(control).toBeChecked()
  expect(control).toHaveAttribute("aria-checked", "true")
  control.focus()
  await user.keyboard(" ")
  expect(control).not.toBeChecked()
  expect(control).toHaveFocus()
  expect(control).toHaveAttribute("aria-checked", "false")
  await user.click(screen.getByRole("switch", { name: "Opção indisponível" }))
  expect(change).not.toHaveBeenCalled()
})

it("keeps machine switch drafts until saving and sends the existing computer-use action", async () => {
  const user = userEvent.setup()
  const bot = createMockApi().getState().bots[0]
  if (!bot) throw new Error("Missing bot fixture")
  const updateBot = vi.fn(async () => undefined)
  render(
    <BotSettingsModal
      bot={{ ...bot, machine: "vm", computerUse: false, vmProviderLogin: false, hostComputerUse: false }}
      projects={[]}
      routines={[]}
      actions={{ updateBot } as unknown as WorkspaceActions}
      onClose={vi.fn()}
    />,
  )
  await user.click(screen.getByRole("tab", { name: "Computador" }))
  const login = screen.getByRole("switch", { name: /Usar meu login/ })
  login.focus()
  await user.keyboard(" ")
  await user.click(screen.getByRole("switch", { name: /Permitir controle do computador na tela/ }))
  expect(updateBot).not.toHaveBeenCalled()
  await user.click(screen.getByRole("tab", { name: "Permissões" }))
  const computer = screen.getByRole("switch", { name: /Controle do computador/ })
  computer.focus()
  await user.keyboard(" ")
  expect(updateBot).toHaveBeenCalledExactlyOnceWith(bot.id, { computerUse: true })
  await user.click(screen.getByRole("tab", { name: "Computador" }))
  expect(screen.getByRole("switch", { name: /Usar meu login/ })).toBeChecked()
  expect(screen.getByRole("switch", { name: /Permitir controle do computador na tela/ })).toBeChecked()
  await user.click(screen.getByRole("button", { name: "Salvar configurações" }))
  expect(updateBot).toHaveBeenLastCalledWith(
    bot.id,
    expect.objectContaining({ vmProviderLogin: true, hostComputerUse: true, approvals: bot.approvals }),
  )
})

it("validates idle time before review and keeps the review available after a failed creation", async () => {
  const create = vi.fn().mockRejectedValueOnce(new Error("Indisponível")).mockResolvedValueOnce(undefined)
  const close = vi.fn()
  render(
    <BotCreateModal
      capability={{ available: true, provider: "apple-container", reason: null }}
      onClose={close}
      onCreate={create}
    />,
  )
  fireEvent.change(screen.getByLabelText("Nome"), { target: { value: "Clara" } })
  next()
  next()
  next()
  fireEvent.change(screen.getByLabelText("Máquina"), { target: { value: "vm" } })
  fireEvent.change(screen.getByLabelText("Parar após minutos sem atividade"), { target: { value: "0" } })
  expect(screen.getByRole("button", { name: "Continuar" })).toBeDisabled()
  expect(screen.getByRole("alert")).toHaveTextContent("1.440")
  fireEvent.change(screen.getByLabelText("Parar após minutos sem atividade"), { target: { value: "1" } })
  next()
  expect(screen.getByText("Linux isolado · pausa após 1 minuto")).toBeVisible()
  fireEvent.click(screen.getByRole("button", { name: "Criar bot" }))
  await screen.findByRole("alert")
  expect(close).not.toHaveBeenCalled()
  expect(screen.getByRole("heading", { name: "Revisar e criar" })).toBeVisible()
  fireEvent.click(screen.getByRole("button", { name: "Criar bot" }))
  await waitFor(() => expect(close).toHaveBeenCalledOnce())
  expect(create).toHaveBeenCalledTimes(2)
})

it("keeps drafts across settings panes and links each navigation tab to its panel", async () => {
  const bot = createMockApi().getState().bots[0]
  if (!bot) throw new Error("Missing bot fixture")
  const updateBot = vi.fn(async () => undefined)
  render(
    <BotSettingsModal
      bot={bot}
      projects={[]}
      routines={[]}
      actions={{ updateBot } as unknown as WorkspaceActions}
      onClose={vi.fn()}
    />,
  )
  fireEvent.change(screen.getByLabelText("Função"), { target: { value: "Pesquisa" } })
  fireEvent.click(screen.getByRole("tab", { name: "Computador" }))
  expect(screen.queryByRole("textbox", { name: "Função" })).toBeNull()
  const tab = screen.getByRole("tab", { name: "Computador" })
  expect(document.getElementById(tab.getAttribute("aria-controls") ?? "")).toBe(
    screen.getByRole("tabpanel", { name: "Computador" }),
  )
  fireEvent.click(screen.getByRole("tab", { name: "Geral" }))
  expect(screen.getByLabelText("Função")).toHaveValue("Pesquisa")
  fireEvent.click(screen.getByRole("button", { name: "Salvar configurações" }))
  await waitFor(() =>
    expect(updateBot).toHaveBeenCalledWith(
      bot.id,
      expect.objectContaining({ roleLine: "Pesquisa", instructions: bot.instructions, approvals: bot.approvals }),
    ),
  )
})

it("cycles focus inside the modal, closes with Escape and restores the opening button", async () => {
  const user = userEvent.setup()
  const Harness = () => {
    const [open, setOpen] = useState(false)
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          Abrir
        </button>
        {open && (
          <Modal title="Teste de foco" onClose={() => setOpen(false)}>
            <input aria-label="Nome" />
            <button type="button">Último controle</button>
          </Modal>
        )}
      </>
    )
  }
  render(<Harness />)
  const trigger = screen.getByRole("button", { name: "Abrir" })
  await user.click(trigger)
  const close = screen.getByRole("button", { name: "Fechar diálogo" })
  expect(close).toHaveFocus()
  const last = screen.getByRole("button", { name: "Último controle" })
  last.focus()
  await user.tab()
  expect(close).toHaveFocus()
  await user.tab({ shift: true })
  expect(last).toHaveFocus()
  await user.keyboard("{Escape}")
  expect(screen.queryByRole("dialog")).toBeNull()
  expect(trigger).toHaveFocus()
})

it("Escape cancels a machine reset before closing settings and returns focus to Redefinir", async () => {
  const bot = createMockApi().getState().bots[0]
  if (!bot) throw new Error("Missing bot fixture")
  const close = vi.fn()
  const machineAction = vi.fn(async () => undefined)
  render(
    <BotSettingsModal
      bot={{ ...bot, machine: "vm" }}
      projects={[]}
      routines={[]}
      capability={{ available: true, reason: null, provider: "apple-container" }}
      actions={{ machineAction } as unknown as WorkspaceActions}
      onClose={close}
    />,
  )
  fireEvent.click(screen.getByRole("tab", { name: "Computador" }))
  fireEvent.click(screen.getByRole("button", { name: "Redefinir" }))
  const confirmation = screen.getByRole("alertdialog")
  expect(within(confirmation).getByRole("button", { name: "Cancelar" })).toHaveFocus()
  fireEvent.keyDown(document, { key: "Escape" })
  expect(screen.queryByRole("alertdialog")).toBeNull()
  expect(screen.getByRole("button", { name: "Redefinir" })).toHaveFocus()
  expect(close).not.toHaveBeenCalled()
  expect(machineAction).not.toHaveBeenCalled()
})

it("shows preference failures without closing or applying the theme, then allows retry", async () => {
  localStorage.setItem("touri.appearance.v1", "dark")
  const save = vi.fn().mockRejectedValueOnce(new Error("Indisponível")).mockResolvedValueOnce(undefined)
  const close = vi.fn()
  render(<SettingsModal settings={null} onClose={close} onSave={save} />)
  expect(screen.getByText("preferências locais")).toBeVisible()
  fireEvent.change(screen.getByLabelText("Tema"), { target: { value: "light" } })
  fireEvent.click(screen.getByRole("button", { name: "Salvar preferências" }))
  await screen.findByRole("alert")
  expect(readTheme()).toBe("dark")
  expect(close).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole("button", { name: "Salvar preferências" }))
  await waitFor(() => expect(close).toHaveBeenCalledOnce())
  expect(readTheme()).toBe("light")
})

it("supports arrow navigation between preference sections and preserves modified controls", async () => {
  const user = userEvent.setup()
  const save = vi.fn(async () => undefined)
  render(<SettingsModal settings={null} onClose={vi.fn()} onSave={save} />)
  const appearance = screen.getByRole("tab", { name: "Aparência" })
  appearance.focus()
  fireEvent.keyDown(appearance, { key: "ArrowDown" })
  expect(screen.getByRole("tab", { name: "Atalhos" })).toHaveFocus()
  expect(screen.getByRole("tabpanel", { name: "Atalhos" })).toBeVisible()
  fireEvent.click(screen.getByRole("tab", { name: "Geral" }))
  const updates = screen.getByRole("switch", { name: /Verificar atualizações/ })
  updates.focus()
  await user.keyboard(" ")
  fireEvent.click(screen.getByRole("tab", { name: "Aparência" }))
  fireEvent.click(screen.getByRole("tab", { name: "Geral" }))
  expect(screen.getByRole("switch", { name: /Verificar atualizações/ })).toBeChecked()
  await user.click(screen.getByRole("tab", { name: "Notificações" }))
  const notifications = screen.getByRole("switch", { name: /Notificações do sistema/ })
  notifications.focus()
  await user.keyboard(" ")
  expect(notifications).not.toBeChecked()
  await user.click(screen.getByRole("button", { name: "Salvar preferências" }))
  expect(save).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ checkForUpdates: true, nativeNotifications: false }),
  )
})

it("groups Doctor checks by environment and uses zero plurals in the summary", () => {
  const view = render(<DoctorChecks doctor={{ checks: [] }} error={null} onRefresh={vi.fn()} />)
  expect(screen.getByText("0 prontos · 0 avisos · 0 falhas")).toBeVisible()
  view.rerender(
    <DoctorChecks
      doctor={{
        checks: [
          { id: "codex", label: "Codex", ok: true, fix: null, detail: "Pronto para executar." },
          {
            id: "vm-system",
            label: "Serviço de máquinas",
            ok: false,
            fix: "container system start",
            detail: "Parado.",
          },
          { id: "network-openai-dns", label: "OpenAI", ok: true, fix: null, detail: "Conectado." },
        ],
      }}
      error={null}
      onRefresh={vi.fn()}
    />,
  )
  expect(within(screen.getByRole("region", { name: "Provedores de IA" })).getByText("Codex")).toBeVisible()
  expect(
    within(screen.getByRole("region", { name: "Computadores isolados" })).getByText("Serviço de máquinas"),
  ).toBeVisible()
  expect(within(screen.getByRole("region", { name: "Conexões com provedores" })).getByText("OpenAI")).toBeVisible()
})

it("revalidates the machine after revisiting a completed creation step and on form submit", () => {
  const create = vi.fn(async () => undefined)
  render(
    <BotCreateModal
      capability={{ available: true, reason: null, provider: "apple-container" }}
      onClose={vi.fn()}
      onCreate={create}
    />,
  )
  fireEvent.change(screen.getByLabelText("Nome"), { target: { value: "Clara" } })
  next()
  next()
  next()
  fireEvent.change(screen.getByLabelText("Máquina"), { target: { value: "vm" } })
  next()
  fireEvent.click(screen.getByRole("button", { name: "Voltar" }))
  fireEvent.change(screen.getByLabelText("Parar após minutos sem atividade"), { target: { value: "0" } })
  expect(screen.getByRole("button", { name: /Revisar e criar/ })).toBeDisabled()
  const form = document.querySelector(".bot-create-form")
  if (!form) throw new Error("Missing creation form")
  fireEvent.submit(form)
  expect(create).not.toHaveBeenCalled()
  expect(screen.getByRole("heading", { name: "Computador e integrações" })).toBeVisible()
})

it("reports immediate permission failures and lets the user retry without losing drafts", async () => {
  const bot = createMockApi().getState().bots[0]
  if (!bot) throw new Error("Missing bot fixture")
  const updateBot = vi.fn().mockRejectedValueOnce(new Error("Indisponível")).mockResolvedValue(undefined)
  render(
    <BotSettingsModal
      bot={bot}
      projects={[]}
      routines={[]}
      actions={{ updateBot } as unknown as WorkspaceActions}
      onClose={vi.fn()}
    />,
  )
  fireEvent.change(screen.getByLabelText("Função"), { target: { value: "Pesquisa" } })
  fireEvent.click(screen.getByRole("tab", { name: "Permissões" }))
  const control = screen.getByRole("switch", { name: /Controle do computador/ })
  fireEvent.click(control)
  await screen.findByRole("alert")
  expect(control).toHaveProperty("checked", bot.computerUse)
  expect(control).not.toBeDisabled()
  fireEvent.click(control)
  await waitFor(() => expect(updateBot).toHaveBeenCalledTimes(2))
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull())
  fireEvent.click(screen.getByRole("tab", { name: "Geral" }))
  expect(screen.getByLabelText("Função")).toHaveValue("Pesquisa")
})
