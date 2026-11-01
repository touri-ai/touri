import { toolCatalog } from "@touri/contracts"
import { expect, test } from "vitest"
import { toolPresentation } from "../src/components/toolPresentation"
import { localizeNotice, t } from "../src/i18n"

test.each(["thread_create", "routine_create"])("translates the %s gateway description", (name) => {
  const tool = toolCatalog.tools.find((tool) => tool.name === name)
  if (!tool) throw new Error("Missing catalog tool")

  const portuguese = localizeNotice(tool.description)

  expect(portuguese).not.toBe(tool.description)
  expect(portuguese).toContain(name === "thread_create" ? "mensagem atual" : "conversa principal")
})

test("thread creation uses a readable activity label", () => {
  const presentation = toolPresentation({
    type: "tool_call",
    callId: "create-message-thread",
    tool: "mcp__touri__thread_create",
    summary: "thread_create",
    inputJson: "{}",
    outputJson: null,
    ok: true,
  })

  expect(presentation.name).toBe("Iniciar thread")
  expect(presentation.summary).toBe("Criar uma thread a partir da mensagem atual.")
  expect(t("Iniciar thread", {}, "en")).toBe("Start thread")
  expect(t("Criar uma thread a partir da mensagem atual.", {}, "en")).toBe("Create a thread from the current message.")
})

test("thread recovery and tool feedback have Portuguese and English copy", () => {
  expect(t("Conversa principal indisponível", {}, "en")).toBe("Main conversation unavailable")
  expect(t("Use Iniciar thread em uma mensagem da conversa.", {}, "en")).toBe(
    "Use Start thread on a message in the conversation.",
  )
  expect(t("Conversa em exclusão", {}, "en")).toBe("Conversation is being deleted")
  expect(t("Thread criada: {title}", { title: "Planejamento" }, "en")).toBe("Thread created: Planejamento")
  expect(localizeNotice("Thread criada: Planejamento")).toBe("Thread criada: Planejamento")
})
