import { expect, type Page } from "@playwright/test"
import type { Message } from "@touri/contracts"
import type { createMockApi } from "../../src/api/mock"
import { showWorkMode } from "./home-navigation"

type GroupRepeatWindow = Window & { groupsQa: { api: ReturnType<typeof createMockApi> } }

export const prepareChannelResult = async (page: Page) => {
  await page.goto("/test/e2e/groups-harness.html")
  await expect(page.getByRole("textbox", { name: "Mensagem para mark", exact: true })).toBeVisible()
  await showWorkMode(page)
  await page.getByRole("button", { name: "Criar canal", exact: true }).click()
  const creation = page.getByRole("dialog", { name: "Criar canal", exact: true })
  await creation.getByLabel("Nome do canal").fill("Notas fictícias")
  await creation.getByRole("checkbox", { name: "mark", exact: true }).check()
  await creation.getByRole("button", { name: "Criar canal", exact: true }).click()
  await expect(page.getByRole("textbox", { name: "Mensagem para Notas fictícias", exact: true })).toBeVisible()

  await page.evaluate(() => {
    const fixture = window as GroupRepeatWindow
    const api = fixture.groupsQa.api
    const thread = api.getState().threads.find((thread) => thread.groupId)
    if (!thread) throw new Error("Missing channel fixture")
    const now = Date.now()
    const question: Message = {
      id: "channel-repeat-question",
      threadId: thread.id,
      parentId: null,
      role: "user",
      kind: "text",
      status: "complete",
      runId: null,
      text: "@mark Organize minhas notas",
      parts: [],
      sender: null,
      source: "local",
      createdAt: now,
      updatedAt: now,
    }
    const reply: Message = Object.assign({}, question, {
      id: "channel-repeat-result",
      parentId: question.id,
      role: "assistant" as const,
      text: "Notas organizadas para revisão.",
      sender: { id: "bot-mark", name: "mark" },
      createdAt: now + 1,
      updatedAt: now + 1,
    })
    api.emit({ type: "message.created", message: question })
    api.emit({ type: "message.created", message: reply })
  })
  await expect(page.getByText("Notas organizadas para revisão.", { exact: true })).toBeVisible()
}
