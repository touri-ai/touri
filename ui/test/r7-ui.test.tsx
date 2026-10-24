import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import type { Message } from "@touri/contracts"
import { describe, expect, it } from "vitest"
import App from "../src/App"
import { createMockApi } from "../src/api/mock"
import { latestPreview } from "../src/botPreview"
import { plural, t } from "../src/i18n"
import { openConversations } from "./workspaceNavigation"

const message = (text: string): Message => ({
  id: "r7-markdown",
  threadId: "thread-mark",
  parentId: null,
  role: "assistant",
  kind: "text",
  status: "complete",
  runId: null,
  text,
  parts: [{ type: "text", text }],
  sender: null,
  source: "local",
  createdAt: Date.now(),
  updatedAt: Date.now(),
})

describe("R7: resumos em texto simples", () => {
  it.each([
    ["**Origem:** `README.md`", "Origem: README.md"],
    [
      "# Resultado\n\n- **Primeiro**\n- *Segundo*\n- [Leia mais](https://example.test)",
      "Resultado · Primeiro · Segundo · Leia mais",
    ],
    ["1. __Planejar__\n2. _Revisar_\n3. ~~Antigo~~", "Planejar · Revisar · Antigo"],
    ["- [ ] Pendente\n- [x] Feito", "Pendente · Feito"],
    ["Título\n=====\n\n> Texto **curto**", "Título Texto curto"],
    [
      "Abra `file_name.ts` e `a * b` ou https://example.test/a_b.",
      "Abra file_name.ts e a * b ou https://example.test/a_b.",
    ],
    ["```sh\nprintf '**literal**'\n```", "printf '**literal**'"],
    ["**Forte *e itálico***", "Forte e itálico"],
    ["[Documentação][ref]\n\n[ref]: https://example.test/a_(b)", "Documentação"],
    ["```sh\nprintf '*literal*'\n````", "printf '*literal*'"],
    ["~~~sh\nprintf '*literal*'", "printf '*literal*'"],
    ["***\n# Título #\r\n\r\n- Primeiro\r\n  continua\r\n- Segundo", "Título · Primeiro continua · Segundo"],
  ])("cleans %s", (source, expected) => {
    expect(latestPreview({ threadIds: ["thread-mark"], messages: [message(source)] })).toBe(expected)
  })

  it("removes formatting before truncation and keeps a single line", () => {
    const text = latestPreview({ threadIds: ["thread-mark"], messages: [message(`**${"a".repeat(100)}**`)] })
    expect(text).toBe(`${"a".repeat(89)}…`)
  })

  it("protects URLs inside emphasis without retaining the outer delimiters", () => {
    for (const source of [
      "**https://example.test/a_b**",
      "_https://example.test/_a__",
      "***https://example.test/a_b***",
    ]) {
      const expected = source.includes("/_a_") ? "https://example.test/_a_" : "https://example.test/a_b"
      expect(latestPreview({ threadIds: ["thread-mark"], messages: [message(source)] })).toBe(expected)
    }
  })

  it("cleans both notification titles and bodies without changing the source", async () => {
    const api = createMockApi()
    render(<App kernel={{ services: { api } }} />)
    await screen.findByRole("textbox", { name: "Mensagem para mark" })
    act(() =>
      api.notify({
        kind: "done",
        title: "**Resumo**",
        body: "- **Origem:** `README.md`\n- [Documentação](https://example.test)",
        botId: "bot-mark",
      }),
    )
    fireEvent.click(screen.getByRole("button", { name: "Notificações" }))
    const center = screen.getByRole("region", { name: "Central de notificações" })
    expect(within(center).getByText("Resumo")).toBeVisible()
    expect(within(center).getByText("Origem: README.md · Documentação")).toBeVisible()
    expect((await api.request("GET /notifications", {})).notifications[0]?.body).toContain("**Origem:**")
  })

  it("preserves literal command arguments in approval notifications", async () => {
    const api = createMockApi()
    const command = "find . -name '*.ts' -o -name '*.tsx'"
    render(<App kernel={{ services: { api } }} />)
    await screen.findByRole("textbox", { name: "Mensagem para mark" })
    act(() =>
      api.notify({
        kind: "approval",
        title: "Approve command",
        body: command,
        botId: "bot-mark",
        requestId: "r7-command",
      }),
    )
    fireEvent.click(screen.getByRole("button", { name: "Notificações, 1 precisa de atenção" }))
    expect(within(screen.getByRole("region", { name: "Central de notificações" })).getByText(command)).toBeVisible()
  })
})

it("renders structured Markdown in the Preview mini-chat with the main chat renderer", async () => {
  const api = createMockApi()
  const source =
    "## Resultado\n\n**Resumo** e `código`.\n\n- Primeiro\n- Segundo\n\n[Documentação](https://example.test)\n\n- [ ] Pendente\n- [x] Feito"
  const saved = message(source)
  const state = api.getState()
  state.messages.push(saved)
  const thread = state.threads.find((thread) => thread.id === saved.threadId)
  if (thread) thread.activeLeafId = saved.id
  render(<App kernel={{ services: { api } }} />)
  await screen.findByRole("textbox", { name: "Mensagem para mark" })
  if (!screen.queryByRole("button", { name: "Preview do projeto" }))
    fireEvent.click(screen.getByRole("button", { name: "Painel do bot" }))
  await screen.findByRole("complementary", { name: /^Painel de / })
  fireEvent.click(screen.getByRole("button", { name: "Preview do projeto" }))
  await screen.findByRole("heading", { name: "Preview", exact: true })

  const feed = document.querySelector(".preview-chat-feed") as HTMLElement
  expect(await within(feed).findByRole("heading", { name: "Resultado" })).toBeVisible()
  expect(feed.querySelector("strong")).toHaveTextContent("Resumo")
  expect(feed.querySelector("code")).toHaveTextContent("código")
  expect(within(feed).getAllByRole("listitem")).toHaveLength(4)
  expect(within(feed).getByRole("link", { name: "Documentação" })).toHaveAttribute("href", "https://example.test")
  expect(within(feed).getAllByRole("checkbox")).toHaveLength(2)
  expect(within(feed).getAllByRole("checkbox")[1]).toBeChecked()
})

it("uses a pt-BR preferences title and separate labels for the shortcut and browser", async () => {
  render(<App kernel={{ services: { api: createMockApi() } }} />)
  await screen.findByRole("textbox", { name: "Mensagem para mark" })
  fireEvent.click(screen.getByRole("button", { name: /Você Local/ }))
  const settings = await screen.findByRole("dialog", { name: "Configurações" })
  expect(within(settings).getByText("preferências locais")).toBeVisible()
  fireEvent.click(within(settings).getByText("Chat, barra lateral e atalhos"))
  const shortcut = within(settings).getByText("Atalho para controle do computador:")
  expect(shortcut).toBeVisible()
  fireEvent.click(within(settings).getByRole("tab", { name: "Privacidade" }))
  fireEvent.click(within(settings).getByText("Dados, permissões e conexões"))
  const browser = within(settings).getByText("Navegador:")
  expect(browser).toBeVisible()
  expect(shortcut.nextElementSibling?.tagName).toBe("CODE")
  expect(browser.nextElementSibling).toHaveTextContent("Chrome do sistema")
  expect(shortcut.parentElement).not.toBe(browser.parentElement)
})

describe("R7: orientação de primeira mensagem", () => {
  it.each([
    ["QA de aplicativos", /Usar exemplo/],
    ["Gerente de produto", /Usar exemplo/],
    [null, /Usar exemplo/],
  ])("offers relevant prompts for %s and fills the composer without sending", async (roleLine, example) => {
    const api = createMockApi()
    await api.request("PATCH /bots/:id", { roleLine, description: null }, { id: "bot-mark" })
    render(<App kernel={{ services: { api } }} />)
    await screen.findByRole("textbox", { name: "Mensagem para mark" })
    fireEvent.click(within(openConversations()).getByRole("button", { name: /Nova conversa/ }))
    const hint = await screen.findByRole("region", { name: "Comece uma conversa com mark" })
    const examples = within(hint).getAllByRole("button")
    expect(examples.length).toBeGreaterThanOrEqual(2)
    expect(examples.length).toBeLessThanOrEqual(3)
    const prompt = within(hint).getByRole("button", { name: example })
    fireEvent.click(prompt)
    const composer = screen.getByRole("textbox", { name: "Mensagem para mark" })
    expect((composer as HTMLTextAreaElement).value).toContain("Comprar café; revisar orçamento; marcar reunião.")
    expect(composer).toHaveFocus()
    expect(api.calls.some((call) => call.route === "POST /threads/:id/messages")).toBe(false)
    fireEvent.keyDown(composer, { key: "Enter" })
    await waitFor(() => expect(screen.queryByRole("region", { name: "Comece uma conversa com mark" })).toBeNull())
  })
})

it("uses plural count labels for zero and singular only for one", () => {
  expect(plural(0, "aviso", "avisos")).toBe("avisos")
  expect(plural(1, "aviso", "avisos")).toBe("aviso")
  expect(plural(2, "aviso", "avisos")).toBe("avisos")
  expect(t("Tool count", { count: 0 })).toBe("0 chamadas de ferramenta")
  expect(t("Checks ready", { count: 0 })).toBe("0 verificações prontas")
  expect(t("Pending approval count", { count: 1 })).toBe("1 aprovação pendente")
})
