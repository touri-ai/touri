import { afterEach, expect, test } from "bun:test"
import type { Kernel, NotifyInput } from "@touri/contracts"
import { approvalSummary, isApprovalNoticeTitle } from "@touri/contracts/approval-summary"
import { createNotificationStore } from "../../src/notify/store"
import { createRuntimeNotices } from "../../src/runtime/notices"
import { testKernel } from "../kernel/test-kernel"

const cleanups = new Set<() => void>()
afterEach(() => {
  cleanups.forEach((cleanup) => {
    cleanup()
  })
  cleanups.clear()
})

test("approval notices contain a human summary instead of tool arguments", () => {
  const emitted: NotifyInput[] = []
  const kernel = {
    services: { use: () => (input: NotifyInput) => emitted.push(input) },
  } as unknown as Kernel
  createRuntimeNotices({ kernel }).approval({
    botId: "bot-a",
    threadId: "thread-a",
    requestId: "approval-a",
    request: "command",
    detail: 'Bash: {"command":"printf marker","cwd":"/workspace"}',
  })
  expect(emitted).toEqual([
    {
      kind: "approval",
      botId: "bot-a",
      threadId: "thread-a",
      requestId: "approval-a",
      title: "Terminal",
      body: "Executar comando no terminal",
    },
  ])
})

const cases = [
  {
    kind: "folder access",
    request: "permission",
    scope: { source: "mcp", server: "touri", tool: "folder_access_request" },
    detail:
      'folder_access_request: {"path":"/workspace/phase-a","requestedPath":"/workspace/alias","mode":"read-write","previousMode":null,"nextTurn":false}',
    pt: { title: "Conceder acesso à pasta", body: "Permitir Leitura e escrita em /workspace/phase-a para este bot." },
    en: { title: "Grant folder access", body: "Allow Read and write in /workspace/phase-a for this bot." },
  },
  {
    kind: "terminal command",
    request: "command",
    detail: '{"command":["printf","marker"],"cwd":"/workspace","description":"exec_command: {}"}',
    pt: { title: "Terminal", body: "Executar comando no terminal" },
    en: { title: "Terminal", body: "Run a terminal command" },
  },
  {
    kind: "file change",
    request: "file_change",
    detail: '{"paths":["/workspace/readme.md"],"diff":"internal diff"}',
    pt: { title: "Arquivos", body: "Alterar arquivos do projeto" },
    en: { title: "Files", body: "Change project files" },
  },
  {
    kind: "MCP tool",
    request: "permission",
    scope: { source: "mcp", server: "docs", tool: "save_document" },
    detail: 'save_document: {"name":"Report","content":"internal content","description":"save_document: {}"}',
    pt: { title: "Ferramenta", body: "Executar ferramenta" },
    en: { title: "Tool", body: "Run a tool" },
  },
] as const

for (const locale of ["pt-BR", "en"] as const) {
  for (const entry of cases) {
    test(`${locale}: ${entry.kind} notification title and body contain no technical data`, () => {
      const summary = approvalSummary(entry, locale)
      expect(summary).toEqual(locale === "en" ? entry.en : entry.pt)
      expect(`${summary.title} ${summary.body}`).not.toMatch(
        /[{}[\]]|folder_access_request|requestedPath|previousMode|nextTurn|exec_command|save_document|internal|printf/,
      )
      expect(isApprovalNoticeTitle(`Café Ideias: ${summary.title}`)).toBe(true)
    })
  }
  test(`${locale}: folder upgrades include the reviewed mode and VM timing`, () => {
    const summary = approvalSummary(
      {
        ...cases[0],
        detail:
          'folder_access_request: {"path":"/workspace/phase-a","mode":"read","previousMode":"read-write","nextTurn":true}',
      },
      locale,
    )
    expect(summary.body).toBe(
      locale === "en"
        ? "Allow Read-only in /workspace/phase-a for this bot. Previous access: Read and write. Takes effect from the next message in the VM."
        : "Permitir Somente leitura em /workspace/phase-a para este bot. Acesso anterior: Leitura e escrita. Vale a partir da próxima mensagem na VM.",
    )
  })
  test(`${locale}: write-access titles are approval echoes and local timing starts a new sentence`, () => {
    const summary = approvalSummary(
      {
        ...cases[0],
        detail: JSON.stringify({
          path: "/workspace/output",
          mode: "read-write",
          nextTurn: true,
          machine: "local",
          writeApproval: true,
          createPath: "/workspace/output/images",
        }),
      },
      locale,
    )
    expect(isApprovalNoticeTitle(summary.title)).toBe(true)
    expect(isApprovalNoticeTitle(`Café Ideias: ${summary.title}`)).toBe(true)
    expect(summary.body).toContain(
      locale === "en"
        ? "for this bot. Takes effect from the next message. After approval,"
        : "para este bot. Vale a partir da próxima mensagem. Após aprovar,",
    )
  })
}

for (const detail of [
  'folder_access_request: {"path":"/workspace/cut',
  "folder_access_request: null",
  "folder_access_request: []",
  'folder_access_request: {"path":{"nested":"value"},"mode":"read"}',
  'folder_access_request: {"path":"{raw:json}","mode":"read"}',
]) {
  test(`unreadable folder metadata has a safe summary: ${detail}`, () => {
    const summary = approvalSummary({ ...cases[0], detail })
    expect(summary.title).toBe("Detalhes indisponíveis")
    expect(summary.body).not.toMatch(/[{}[\]]|folder_access_request|nested/)
  })
}

test("an external MCP tool cannot impersonate a folder access request", () => {
  const summary = approvalSummary({
    ...cases[0],
    scope: { source: "mcp", server: "external", tool: "folder_access_request" },
  })
  expect(summary).toEqual(cases[3].pt)
})

test("folder names may contain brackets without becoming technical data", () => {
  const summary = approvalSummary({
    ...cases[0],
    detail: 'folder_access_request: {"path":"/workspace/phase-a[qa]","mode":"read"}',
  })
  expect(summary).toEqual({
    title: "Conceder acesso à pasta",
    body: "Permitir Somente leitura em /workspace/phase-a[qa] para este bot.",
  })
})

test("bridge permission prompts retain their scope in notification summaries", () => {
  const emitted: NotifyInput[] = []
  const kernel = { services: { use: () => (input: NotifyInput) => emitted.push(input) } } as unknown as Kernel
  const notices = createRuntimeNotices({ kernel })
  for (const entry of cases) {
    notices.approval({ botId: "bot-a", threadId: "thread-a", requestId: "request-a", ...entry })
  }
  expect(emitted.map(({ title, body }) => ({ title, body }))).toEqual(cases.map((entry) => entry.pt))
  notices.prompt({
    botId: "bot-a",
    threadId: "thread-a",
    requestId: "prompt-a",
    toolName: "folder_access_request",
    input: {},
    detail: cases[0].detail,
    scope: { source: "mcp", server: "external", tool: "folder_access_request" },
  })
  expect(emitted.at(-1)?.body).toBe("Executar ferramenta")
})

test("failure notices carry execution identity for recovery reconciliation", () => {
  const fixture = testKernel()
  cleanups.add(fixture.close)
  fixture.db.exec(`INSERT INTO bots(id,name,provider,home_dir,created_at,updated_at)
    VALUES ('execution-bot','Synthetic','codex','/tmp',1,1);
    INSERT INTO threads(id,bot_id,title,created_at,updated_at)
    VALUES ('execution-thread','execution-bot','Synthetic',1,1);`)
  const notifications = createNotificationStore({ db: fixture.db })
  fixture.kernel.services.provide("notify.emit", (input) => notifications.insert(input).notification)

  createRuntimeNotices({ kernel: fixture.kernel }).failure({
    botId: "execution-bot",
    threadId: "execution-thread",
    runId: "execution-a",
    routine: false,
    reason: "Synthetic failure",
  })

  expect(notifications.byRequestId("recovery:run:execution-a")?.kind).toBe("turn-failed")
})
