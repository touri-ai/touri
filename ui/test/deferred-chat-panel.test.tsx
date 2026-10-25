import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { useState } from "react"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { createMockApi } from "../src/api/mock"
import { getDeferredChatPanel } from "../src/components/DeferredChatPanel"
import { ErrorBoundary } from "../src/components/ErrorBoundary"
import { useComposerDraft } from "../src/composerDraft"

beforeEach(() => vi.spyOn(console, "error").mockImplementation(() => {}))
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const getRecoveryFixture = (loadPanel: Parameters<typeof getDeferredChatPanel>[0]) => {
  const Panel = getDeferredChatPanel(loadPanel)
  const api = createMockApi()

  return function Recovery({ conversation = "first" }: { conversation?: string }) {
    const [retry, setRetry] = useState(false)

    return (
      <ErrorBoundary key={conversation} area="a conversa" api={api} reloadApp={retry} onRetry={() => setRetry(true)}>
        <Panel
          retry={retry}
          api={api}
          bot={null}
          thread={null}
          messages={[]}
          runs={[]}
          computerGrant={null}
          onSend={async () => {}}
          onRetry={async () => {}}
          onCancel={async () => {}}
          onSwitchBranch={async () => {}}
          onComputerGrant={() => {}}
          onOpenTools={() => {}}
        />
      </ErrorBoundary>
    )
  }
}

const DraftPanel = () => {
  const { draft, setDraft } = useComposerDraft("thread-mark")

  return <input aria-label="Mensagem" value={draft} onChange={(event) => setDraft(event.target.value)} />
}

test("retry imports a new panel and restores the saved draft without remounting the app", async () => {
  localStorage.setItem("touri.composer-draft.v1:thread-mark", "Rascunho de teste")
  const loadPanel = vi.fn().mockRejectedValueOnce(new TypeError("Failed to fetch dynamically imported module"))
  loadPanel.mockResolvedValue({ default: DraftPanel })
  const Recovery = getRecoveryFixture(loadPanel)
  const view = render(<Recovery />)
  await screen.findByRole("button", { name: "Recarregar esta área" })

  fireEvent.click(screen.getByRole("button", { name: "Recarregar esta área" }))

  expect(await screen.findByRole("textbox", { name: "Mensagem" })).toHaveValue("Rascunho de teste")
  expect(loadPanel).toHaveBeenCalledTimes(2)
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Rascunho atualizado" } })
  view.rerender(<Recovery conversation="second" />)
  expect(screen.getByRole("textbox")).toHaveValue("Rascunho atualizado")
  expect(loadPanel).toHaveBeenCalledTimes(2)
})

test("a failed retry offers an explicit app reload and keeps the conversation draft", async () => {
  localStorage.setItem("touri.composer-draft.v1:thread-mark", "Não perder este texto")
  const loadPanel = vi.fn().mockRejectedValue(new TypeError("Failed to fetch dynamically imported module"))
  const Recovery = getRecoveryFixture(loadPanel)
  const view = render(<Recovery />)

  fireEvent.click(await screen.findByRole("button", { name: "Recarregar esta área" }))

  expect(await screen.findByRole("button", { name: "Recarregar app" })).toBeVisible()
  expect(screen.queryByRole("button", { name: "Recarregar esta área" })).toBeNull()
  expect(loadPanel).toHaveBeenCalledTimes(2)
  expect(localStorage.getItem("touri.composer-draft.v1:thread-mark")).toBe("Não perder este texto")
  view.rerender(<Recovery conversation="second" />)
  expect(await screen.findByRole("button", { name: "Recarregar app" })).toBeVisible()
  expect(screen.queryByRole("button", { name: "Recarregar esta área" })).toBeNull()
  expect(loadPanel).toHaveBeenCalledTimes(2)
})
