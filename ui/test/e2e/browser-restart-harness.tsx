import type { ToolCallPart } from "@touri/contracts"
import { useState } from "react"
import { createRoot } from "react-dom/client"
import type { ApiRequest } from "../../src/api/client"
import { createMockApi } from "../../src/api/mock"
import { BrowserActivityCard } from "../../src/components/BrowserActivityCard"
import { BrowserActivityControlsProvider } from "../../src/components/BrowserActivityControls"
import { ApiError } from "../../src/errors"
import { InlinePreviewContext } from "../../src/features/desktop/InlineLivePreview"
import "../../src/styles.css"

const requestFixture = async (step: string, input?: unknown) => {
  const response = await fetch("/__browser-restart-fixture", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ step, ...(input as Record<string, unknown>) }),
  })
  const result = await response.json()
  if (!response.ok) throw new ApiError(response.status, result.error ?? "Browser unavailable", result.errorCode)

  return result
}

const Fixture = () => {
  const [fixture] = useState(() => {
    const api = createMockApi()
    const bot = api.getState().bots[0]
    if (!bot) throw new Error("Fixture bot is missing")
    const originalRequest = api.request
    const steps: Record<string, string> = {
      "GET /browser/tabs": "metadata",
      "POST /browser/tabs/:id/takeover": "takeover-control",
      "GET /bots/:id/browser-preview": "preview",
      "POST /browser/tabs/:id/takeover/session": "takeover-session",
      "POST /browser/tabs/:id/takeover/frame": "takeover-frame",
      "POST /browser/tabs/:id/takeover/input": "takeover-input",
      "DELETE /browser/tabs/:id/takeover/session": "takeover-release",
    }
    const request: ApiRequest = ((route, input, pathValues) => {
      const step = steps[route]
      if (step) return requestFixture(step, input)

      return originalRequest(route, input, pathValues)
    }) as ApiRequest

    return { api: { ...api, request }, bot: { ...bot, id: "browser-demo", name: "Lia", machine: "local" as const } }
  })
  const [parts, setParts] = useState<ToolCallPart[]>([])

  return (
    <main style={{ padding: 16, maxWidth: 1000, margin: "auto" }}>
      <h1>Navegador · cenário fictício de recuperação</h1>
      <button
        type="button"
        onClick={async () => {
          const result = (await requestFixture("open")) as { part: ToolCallPart }
          setParts([result.part])
        }}
      >
        Abrir página pública fictícia
      </button>
      <InlinePreviewContext.Provider
        value={{ ...fixture, machine: undefined, activeCallId: undefined, onOpenComputer: () => {} }}
      >
        <BrowserActivityControlsProvider>
          {parts.length > 0 && (
            <BrowserActivityCard
              parts={parts}
              finished={false}
              createdAt={Date.now()}
              botName="Lia"
              runId="browser-flow-run"
            />
          )}
        </BrowserActivityControlsProvider>
      </InlinePreviewContext.Provider>
    </main>
  )
}

const root = document.getElementById("root")
if (root) createRoot(root).render(<Fixture />)
