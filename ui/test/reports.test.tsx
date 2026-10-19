import { readFileSync } from "node:fs"
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import {
  editReportSnapshot,
  githubReportUrl,
  type ReportInput,
  type ReportSnapshot,
  redactReportText,
  redactReportValue,
  reportSummary,
  reportZip,
} from "@touri/contracts"
import { afterEach, expect, it, vi } from "vitest"
import App from "../src/App"
import type { ApiRequest, TauriInvoke, UiApi } from "../src/api/client"
import { createMockApi } from "../src/api/mock"
import { ErrorBoundary } from "../src/components/ErrorBoundary"
import { SettingsModal } from "../src/components/Modals"
import { ReportMenuLauncher } from "../src/features/reports/ReportMenuLauncher"
import { ReportProblem } from "../src/features/reports/ReportProblem"

const nativeMenu = vi.hoisted(() => ({ handler: null as (() => void) | null }))
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((name: string, handler: () => void) => {
    if (name === "report-problem") nativeMenu.handler = handler
    return Promise.resolve(() => {
      if (name === "report-problem") nativeMenu.handler = null
    })
  }),
}))
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII="
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  localStorage.clear()
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__")
})
const fixture = (cloud = false) => {
  const mock = createMockApi()
  const history: Array<{ id: string; date: number; title: string; destination: string }> = []
  let snapshot: ReportSnapshot | null = null
  const calls: Array<{ route: string; input: unknown; path?: Record<string, string> }> = []
  const request: ApiRequest = async (route, input, path) => {
    calls.push({ route, input, ...(path ? { path } : {}) })
    if (route === "GET /reports")
      return { history: [...history], cloudAvailable: cloud, repository: "https://github.com/touri/test" } as never
    if (route === "POST /reports/preview") {
      const body = input as ReportInput
      if (body.previewEdits) {
        if (!snapshot) throw new Error("no preview")
        snapshot = editReportSnapshot(snapshot, body.previewEdits, "edited-report", body.repository ?? "")
        return snapshot as never
      }
      const report = redactReportValue({ ...body, diagnostics: { test: "preview only" } }, redactReportText) as Record<
        string,
        unknown
      >
      snapshot = {
        id: "prepared-report",
        createdAt: 123,
        report,
        logs: { "sidecar.log": "[REDACTED]" },
        images: body.images.map((image, index) => ({ ...image, name: `captura-${index + 1}.png` })),
        summary: reportSummary(report),
        githubUrl: githubReportUrl(body.repository ?? "", report),
      }
      return snapshot as never
    }
    if (route === "POST /reports/:id/deliver") {
      if (!snapshot) throw new Error("no preview")
      const destination = (input as { destination: string }).destination
      if (destination === "cloud")
        history.push({ id: "cloud-id", date: 123, title: String(snapshot.report.title), destination })
      return {
        id: destination === "cloud" ? "cloud-id" : snapshot.id,
        zipBase64: btoa(String.fromCharCode(...reportZip(snapshot))),
        url: snapshot.githubUrl,
      } as never
    }
    if (route === "POST /reports/:id/saved") {
      history.push({
        id: "prepared-report",
        date: 123,
        title: String(snapshot?.report.title),
        destination: (input as { destination: string }).destination,
      })
      return {} as never
    }
    if (route === "POST /reports/history") return {} as never
    return mock.request(route, input, path)
  }
  const invoke = vi.fn(async (command: string, _args?: unknown) =>
    command === "report_save_zip" ? { path: "/Users/test/Downloads/report.zip" } : {},
  )
  return {
    api: { ...mock, request } as UiApi,
    invoke: invoke as TauriInvoke,
    invokeSpy: invoke,
    calls,
    getSnapshot: () => snapshot,
  }
}

it("A14 offers an editable redacted preview and blocks delivery until edits are reviewed", async () => {
  const { api, invoke } = fixture()
  render(<ReportProblem api={api} invokeCommand={invoke} />)
  await prepare()
  const editor = screen.getByRole("textbox", { name: "Editar report.json" })
  const report = JSON.parse((editor as HTMLTextAreaElement).value)
  fireEvent.change(editor, { target: { value: JSON.stringify({ ...report, happened: "Removed confidential prose" }) } })
  expect(screen.getByRole("button", { name: "Salvar .zip" })).toBeDisabled()
  expect(screen.getByRole("button", { name: "Aplicar edição e revisar" })).toBeEnabled()
  expect(screen.getByText(/O texto das mensagens continua legível/)).toBeVisible()
  fireEvent.click(screen.getByRole("button", { name: "Aplicar edição e revisar" }))
  await screen.findByText("Edição aplicada. Revise o conteúdo antes de enviar.")
  expect((screen.getByRole("textbox", { name: "Editar report.json" }) as HTMLTextAreaElement).value).toContain(
    "Removed confidential prose",
  )
  await waitFor(() => expect(screen.getByRole("button", { name: "Salvar .zip" })).toBeEnabled())
  fireEvent.click(screen.getByRole("button", { name: "Salvar .zip" }))
  await screen.findByText("Salvo em /Users/test/Downloads/report.zip")
})

it("C-09 explains why a cloud without reports support has no delivery option", async () => {
  const { api, invoke } = fixture()
  render(<ReportProblem api={api} invokeCommand={invoke} />)
  await prepare()
  expect(screen.queryByRole("button", { name: "Enviar para o touri" })).toBeNull()
  expect(screen.getByText(/nuvem não anunciou suporte a relatórios/)).toBeVisible()
})
const fill = () => {
  fireEvent.change(screen.getByLabelText("Título"), { target: { value: "Erro sk-fake-key" } })
  fireEvent.change(screen.getByLabelText("O que aconteceu?"), { target: { value: "Travou ao executar" } })
  fireEvent.change(screen.getByLabelText("O que você esperava?"), { target: { value: "Concluir a tarefa" } })
}
const prepare = async () => {
  fill()
  fireEvent.click(screen.getByRole("button", { name: "Ver conteúdo" }))
  await screen.findByRole("button", { name: "Salvar .zip" })
  await waitFor(() => expect(screen.getByRole("button", { name: "Salvar .zip" })).toBeEnabled())
}

it("keeps diagnostic checkboxes compact in a modal, with separate accessible descriptions", async () => {
  const { api, invoke } = fixture()
  // Include the real modal input rule that originally stretched the checkboxes.
  const modalInputs = readFileSync("src/styles.css", "utf8").match(/\.modal-card input,[\s\S]*?\n\}/)?.[0]
  expect(modalInputs).toBeTruthy()
  const style = document.createElement("style")
  style.textContent = `${modalInputs}\n${readFileSync("src/features/reports/reports.css", "utf8")}`
  document.head.append(style)
  try {
    render(<SettingsModal api={api} invokeCommand={invoke} settings={null} onClose={vi.fn()} onSave={vi.fn()} />)
    fireEvent.click(screen.getByRole("tab", { name: "Diagnóstico" }))
    fireEvent.click(screen.getByText("Reportar problema"))
    await act(async () => {
      await Promise.resolve()
    })
    const checks = within(await screen.findByRole("group", { name: "Diagnóstico incluído" })).getAllByRole("checkbox")
    expect(checks).toHaveLength(9)
    for (const checkbox of checks) {
      expect(getComputedStyle(checkbox).width).toBe("16px")
      expect(getComputedStyle(checkbox.closest("label") as HTMLLabelElement).display).toBe("flex")
      const description = document.getElementById(checkbox.getAttribute("aria-describedby") ?? "")
      expect(description).not.toBeNull()
      expect(description?.tagName).toBe("P")
      expect(checkbox.closest("label")).not.toContainElement(description)
      expect(checkbox).toHaveAccessibleDescription(description?.textContent ?? "")
    }
    const versions = screen.getByRole("checkbox", { name: "Informações do aplicativo e do computador" })
    fireEvent.click(screen.getByText("Informações do aplicativo e do computador"))
    expect(versions).not.toBeChecked()
    await act(async () => {
      await Promise.resolve()
    })
  } finally {
    style.remove()
  }
})

const expectDiagnosticCopy = (name: string, pairs: readonly (readonly [string, string])[]) => {
  const group = screen.getByRole("group", { name })
  for (const [label, description] of pairs) {
    const checkbox = within(group).getByRole("checkbox", { name: label })
    expect(checkbox).toHaveAccessibleDescription(description)
  }
  expect(group).not.toHaveTextContent(/\b(?:doctor|vms?|container|sidecar|shell|stderr)\b/i)
}

const portugueseDiagnosticCopy = [
  [
    "Informações do aplicativo e do computador",
    "Ajuda a identificar incompatibilidades entre a versão do touri e o computador.",
  ],
  ["Funcionamento do aplicativo", "Mostra o resultado das verificações do funcionamento e da conexão."],
  [
    "Atividade recente do aplicativo",
    "Inclui as 500 linhas mais recentes, com dados sensíveis ocultados automaticamente.",
  ],
  ["Erros recentes", "Ajuda a identificar erros que se repetem."],
  ["Atividade dos bots", "Mostra quais bots estão em execução e o estado dos computadores usados por eles."],
  ["Resumo dos dados guardados", "Inclui o tamanho e a quantidade de registros, sem o conteúdo."],
  ["Uso de memória do computador pelo touri", "Ajuda a investigar uso elevado de memória e travamentos."],
  ["Tarefas recentes", "Inclui o estado, a duração e o tipo de erro das últimas 20 tarefas."],
  ["Incluir a conversa selecionada", "Selecione um bot e uma conversa acima para incluir esta parte."],
] as const

const englishDiagnosticCopy = [
  ["App and computer details", "Helps spot incompatibilities between the touri version and this computer."],
  ["App operation checks", "Shows results of checks for app operation and connection."],
  ["Recent app activity", "Includes the 500 most recent lines, with sensitive information hidden automatically."],
  ["Recent errors", "Helps identify recurring errors."],
  ["Bot activity", "Shows which bots are running and the status of their computers."],
  ["Stored data summary", "Includes storage size and record counts, without their contents."],
  ["touri memory use on this computer", "Helps investigate high memory use and freezes."],
  ["Recent tasks", "Includes the status, duration and error type of the last 20 tasks."],
  ["Include selected conversation", "Choose a bot and conversation above to include this information."],
] as const

it("uses plain-language diagnostic labels and descriptions in pt-BR", () => {
  const { api, invoke } = fixture()
  render(<ReportProblem api={api} invokeCommand={invoke} />)

  expectDiagnosticCopy("Diagnóstico incluído", portugueseDiagnosticCopy)
})

it("uses plain-language diagnostic labels and descriptions in English", () => {
  const { api, invoke } = fixture()
  render(<ReportProblem api={api} invokeCommand={invoke} locale="en" />)

  expectDiagnosticCopy("Included diagnostics", englishDiagnosticCopy)
})

it("defaults all diagnostics on except transcript, requires preview and saves/copies the exact redacted snapshot", async () => {
  const { api, invoke, invokeSpy, calls, getSnapshot } = fixture()
  const writeText = vi.fn(async () => undefined)
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } })
  render(<ReportProblem api={api} invokeCommand={invoke} />)
  await waitFor(() =>
    expect(screen.getByLabelText("Repositório GitHub (configuração opcional)")).toHaveValue(
      "https://github.com/touri/test",
    ),
  )
  expect(screen.getAllByRole("checkbox").filter((box) => (box as HTMLInputElement).checked)).toHaveLength(8)
  expect(screen.getByLabelText("Incluir a conversa selecionada")).not.toBeChecked()
  expect(screen.getByLabelText("Incluir a conversa selecionada")).toBeDisabled()
  expect(screen.queryByRole("button", { name: "Salvar .zip" })).toBeNull()
  expect(screen.queryByRole("button", { name: "Enviar para o touri" })).toBeNull()
  await prepare()
  const preview = screen.getByRole("region", { name: "Conteúdo exato do relatório" })
  expect(preview).not.toHaveTextContent("sk-fake-key")
  expect(preview).toHaveTextContent("Erro [REDACTED]")
  fireEvent.click(screen.getByRole("button", { name: "Copiar resumo" }))
  await waitFor(() => expect(writeText).toHaveBeenCalledWith(getSnapshot()?.summary))
  fireEvent.click(screen.getByRole("button", { name: "Salvar .zip" }))
  await screen.findByText("Salvo em /Users/test/Downloads/report.zip")
  const data = invokeSpy.mock.calls.find(([command]) => command === "report_save_zip")?.[1] as { dataBase64: string }
  expect(Uint8Array.from(atob(data.dataBase64), (char) => char.charCodeAt(0))).toEqual(
    reportZip(getSnapshot() as ReportSnapshot),
  )
  expect(calls.some((call) => call.route === "POST /reports/:id/saved")).toBe(true)
  expect(within(screen.getByRole("region", { name: "Relatórios enviados" })).getByText("Erro [REDACTED]")).toBeVisible()
  fireEvent.change(screen.getByLabelText("Título"), { target: { value: "Edited" } })
  expect(screen.queryByRole("button", { name: "Salvar .zip" })).toBeNull()
})

it("offers cloud only when connected, sends the prepared ID, and opens GitHub with summary only", async () => {
  const { api, invoke, invokeSpy, calls } = fixture(true)
  render(<ReportProblem api={api} invokeCommand={invoke} />)
  await waitFor(() =>
    expect(screen.getByLabelText("Repositório GitHub (configuração opcional)")).toHaveValue(
      "https://github.com/touri/test",
    ),
  )
  await prepare()
  fireEvent.click(screen.getByRole("button", { name: "Enviar para o touri" }))
  await screen.findByText("Relatório enviado para o touri: cloud-id")
  expect(calls.find((call) => call.route === "POST /reports/:id/deliver")).toEqual({
    route: "POST /reports/:id/deliver",
    input: { destination: "cloud" },
    path: { id: "prepared-report" },
  })
  await waitFor(() => expect(screen.getByRole("button", { name: "Abrir issue no GitHub" })).toBeEnabled())
  fireEvent.click(screen.getByRole("button", { name: "Abrir issue no GitHub" }))
  await screen.findByText(/GitHub aberto com o resumo/)
  const data = invokeSpy.mock.calls.find(([command]) => command === "open_external")?.[1] as { url: string }
  expect(data.url).toContain("https://github.com/touri/test/issues/new")
  expect(data.url).not.toContain("preview+only")
  expect(data.url).not.toContain("sk-fake-key")
})

it("requires selection and explicit consent to include a conversation", async () => {
  const { api, invoke, calls } = fixture()
  render(<ReportProblem api={api} invokeCommand={invoke} />)
  await waitFor(() =>
    expect(screen.getByLabelText("Bot relacionado (opcional)").querySelectorAll("option").length).toBeGreaterThan(1),
  )
  const bot = screen.getByLabelText("Bot relacionado (opcional)") as HTMLSelectElement
  fireEvent.change(bot, { target: { value: bot.options[1]?.value } })
  await waitFor(() =>
    expect(screen.getByLabelText("Conversa relacionada (opcional)").querySelectorAll("option").length).toBeGreaterThan(
      1,
    ),
  )
  const thread = screen.getByLabelText("Conversa relacionada (opcional)") as HTMLSelectElement
  fireEvent.change(thread, { target: { value: thread.options[1]?.value } })
  expect(screen.getByLabelText("Incluir a conversa selecionada")).toBeEnabled()
  expect(screen.getByLabelText("Incluir a conversa selecionada")).not.toBeChecked()
  fireEvent.click(screen.getByLabelText("Incluir a conversa selecionada"))
  expect(screen.getByText(/A conversa pode conter dados pessoais/)).toBeVisible()
  await prepare()
  const input = calls.find((call) => call.route === "POST /reports/preview")?.input as ReportInput
  expect(input.parts).toContain("transcript")
  expect(input.threadId).toBe(thread.value)
  fireEvent.change(bot, { target: { value: "" } })
  expect(screen.getByLabelText("Incluir a conversa selecionada")).not.toBeChecked()
})

it("accepts paste and drag images, re-encodes them, previews exact images and permits removal", async () => {
  const { api, invoke, calls } = fixture()
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:test") })
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() })
  vi.stubGlobal(
    "Image",
    class {
      width = 1
      height = 1
      src = ""
      decode = async () => undefined
    },
  )
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage: vi.fn() } as never)
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(`data:image/png;base64,${png}`)
  render(<ReportProblem api={api} invokeCommand={invoke} />)
  const form = screen.getByLabelText("Título").closest("form") as HTMLFormElement
  const file = new File(["image bytes"], "private-original-name.png", { type: "image/png" })
  fireEvent.paste(form, { clipboardData: { files: [file] } })
  await screen.findByRole("button", { name: "Remover captura 1" })
  fireEvent.drop(form, { dataTransfer: { files: [file] } })
  await screen.findByRole("button", { name: "Remover captura 2" })
  await prepare()
  const input = calls.find((call) => call.route === "POST /reports/preview")?.input as ReportInput
  expect(input.images).toHaveLength(2)
  expect(input.images[0]?.dataBase64).toBe(png)
  const preview = screen.getByRole("region", { name: "Conteúdo exato do relatório" })
  expect(within(preview).getAllByRole("img")).toHaveLength(2)
  expect(JSON.stringify(input.images)).not.toContain("private-original-name")
  fireEvent.click(screen.getByRole("button", { name: "Remover captura 1" }))
  expect(screen.queryByRole("region", { name: "Conteúdo exato do relatório" })).toBeNull()
})

it("exposes the Settings tab and preserves preferences while reporting", async () => {
  const { api, invoke } = fixture()
  const save = vi.fn()
  render(<SettingsModal api={api} invokeCommand={invoke} settings={null} onClose={vi.fn()} onSave={save} />)
  fireEvent.click(screen.getByRole("tab", { name: "Diagnóstico" }))
  fireEvent.click(screen.getByText("Reportar problema"))
  expect(screen.getByRole("tab", { name: "Diagnóstico" })).toHaveAttribute("aria-selected", "true")
  expect(await screen.findByLabelText("Título")).toBeVisible()
  await waitFor(() => expect(screen.queryByRole("button", { name: "Salvar preferências" })).toBeNull())
  expect(save).not.toHaveBeenCalled()
  await act(async () => {
    await Promise.resolve()
  })
})

it("prefills the error code from an error boundary", async () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined)
  const { api } = fixture()
  const Broken = () => {
    throw new Error("Falhou [TOURI-E8001]")
  }
  render(
    <ErrorBoundary area="teste" api={api}>
      <Broken />
    </ErrorBoundary>,
  )
  fireEvent.click(screen.getByRole("button", { name: "Reportar este problema" }))
  expect(await screen.findByLabelText("Título")).toHaveValue("Problema TOURI-E8001")
  expect((screen.getByLabelText("O que aconteceu?") as HTMLTextAreaElement).value).toContain(
    "O touri apresentou o erro TOURI-E8001.",
  )
})

it("exports a reduced offline report and records history when the sidecar is unavailable", async () => {
  const invoke = vi.fn(async (command: string, _args?: unknown) =>
    command === "report_shell_diagnostics"
      ? {
          home: "/Users/test",
          versions: { app: "0.3.0", schema: 10 },
          logs: { "sidecar-stderr.log": "Bearer fake-token\n/Users/test/project" },
        }
      : { path: "/Users/test/Downloads/offline.zip" },
  )
  render(<ReportProblem offline errorCode="TOURI-E1009" invokeCommand={invoke as TauriInvoke} />)
  fireEvent.change(screen.getByLabelText("O que você esperava?"), { target: { value: "Abrir o touri" } })
  fireEvent.click(screen.getByRole("button", { name: "Ver conteúdo" }))
  await screen.findByRole("button", { name: "Salvar .zip" })
  const preview = screen.getByRole("region", { name: "Conteúdo exato do relatório" })
  expect(preview).toHaveTextContent("Sidecar indisponível")
  expect(preview).not.toHaveTextContent("fake-token")
  expect(preview).toHaveTextContent("~/project")
  expect(screen.queryByRole("button", { name: "Enviar para o touri" })).toBeNull()
  fireEvent.click(screen.getByRole("button", { name: "Salvar .zip" }))
  await screen.findByText("Salvo em /Users/test/Downloads/offline.zip")
  expect(JSON.parse(localStorage.getItem("touri-report-history") ?? "[]")[0]).toMatchObject({
    title: "Problema TOURI-E1009",
    destination: "zip",
  })
})

it("offers the report action on the fatal connection screen", async () => {
  const invoke = vi.fn(async () => {
    throw new Error("Falha [TOURI-E8001]")
  })
  render(<App kernel={{ services: { invoke: invoke as TauriInvoke } }} />)
  expect(await screen.findByRole("button", { name: "Reportar este problema" })).toBeVisible()
})

it("keeps the native Help report action available after a fatal render error", async () => {
  Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} })
  vi.spyOn(console, "error").mockImplementation(() => undefined)
  const { api } = fixture()
  const Broken = () => {
    throw new Error("render failed")
  }
  render(
    <>
      <ErrorBoundary area="o app" app api={api}>
        <Broken />
      </ErrorBoundary>
      <ReportMenuLauncher api={api} />
    </>,
  )
  await waitFor(() => expect(nativeMenu.handler).not.toBeNull())
  await act(async () => nativeMenu.handler?.())
  expect(await screen.findByRole("dialog", { name: "Reportar problema" })).toBeVisible()
  expect(screen.getByLabelText("Título")).toHaveValue("")
})

it("R13-07 a cancelled native save panel writes nothing and does not mark the report as saved", async () => {
  const { api, invokeSpy, calls } = fixture()
  const cancelled = vi.fn(async (command: string, args?: unknown) =>
    command === "report_save_zip" ? { path: null } : await invokeSpy(command, args),
  )
  render(<ReportProblem api={api} invokeCommand={cancelled as TauriInvoke} />)
  await prepare()
  fireEvent.click(screen.getByRole("button", { name: "Salvar .zip" }))
  await screen.findByText("Salvamento cancelado.")
  expect(calls.some((call) => call.route === "POST /reports/:id/saved")).toBe(false)
})
