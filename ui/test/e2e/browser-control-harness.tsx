import { useState } from "react"
import { createRoot } from "react-dom/client"
import type { ApiRequest } from "../../src/api/client"
import { createMockApi } from "../../src/api/mock"
import { BrowserTakeoverView } from "../../src/components/BrowserTakeoverView"
import "../../src/styles.css"
import "../../src/components/browser-activity.css"

document.documentElement.dataset.theme = new URLSearchParams(location.search).get("theme") ?? "dark"
const transport = (window as Window & { browserControlTransport: { endpoint: string; token: string } })
  .browserControlTransport
const requestFixture = (input: object) =>
  fetch(transport.endpoint, {
    method: "POST",
    headers: { authorization: `Bearer ${transport.token}`, "content-type": "application/json" },
    body: JSON.stringify(input),
  })
const api = Object.assign({}, createMockApi(), {
  request: (async (route: string, input: unknown) => {
    const response = await requestFixture({ route, input, method: route.split(" ")[0] })
    if (!response.ok) throw new Error("Synthetic browser request failed")
    return response.json()
  }) as ApiRequest,
})
const App = () => {
  const [session, setSession] = useState<{
    tabId: string
    sessionId: string
    controlEpoch: string
    viewEpoch: number
  } | null>(null)
  const [returned, setReturned] = useState(false)
  const start = async () => {
    const response = await requestFixture({ step: "open" })
    const { tabId } = await response.json()
    const control = await api.request("POST /browser/tabs/:id/takeover/session", {}, { id: tabId })
    setSession({ tabId, ...control })
  }
  return (
    <main style={{ maxWidth: 1080, margin: "24px auto", padding: 12 }}>
      <h1>Trabalho com Lia</h1>
      {!session && !returned && (
        <button type="button" className="button" onClick={() => void start()}>
          Assumir navegador de teste
        </button>
      )}
      {returned && <p role="status">Lia retomou o trabalho.</p>}
      {session && (
        <article className="browser-activity-card">
          <BrowserTakeoverView
            api={api}
            tabId={session.tabId}
            sessionId={session.sessionId}
            controlEpoch={session.controlEpoch}
            initialViewEpoch={session.viewEpoch}
            botName="Lia"
            locale="pt-BR"
            reason="Conclua a verificação fictícia para continuar."
            actions={[
              {
                id: "test",
                icon: "◉",
                label: "Abriu a página local de verificação fictícia",
                time: "12:00",
                active: false,
              },
            ]}
            onHandback={() => {
              setSession(null)
              setReturned(true)
            }}
          />
        </article>
      )}
    </main>
  )
}
const root = document.getElementById("root")
if (root) createRoot(root).render(<App />)
