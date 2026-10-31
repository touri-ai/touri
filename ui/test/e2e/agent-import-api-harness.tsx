import type { AgentImportPreview, AgentImportResult } from "@touri/contracts"
import { useState } from "react"
import { createRoot } from "react-dom/client"
import { createApiClient } from "../../src/api/client"
import { Button } from "../../src/components/Button"
import "../../src/styles.css"

const api = createApiClient({ endpoint: { baseUrl: "", wsUrl: "", token: "fixture" } })
const payload = {
  agents: [
    {
      name: "Notas",
      personality: "Organiza notas",
      instructions: "Prefira frases curtas.",
      skills: [{ name: "resumir", content: "Resuma as notas." }],
      memories: ["O projeto usa português."],
      routines: [{ name: "Revisar notas", schedule: "0 9 * * *", prompt: "Revise as notas." }],
      integrations: ["Calendário"],
    },
  ],
}

const Harness = () => {
  const [preview, setPreview] = useState<AgentImportPreview | null>(null)
  const [result, setResult] = useState<AgentImportResult | null>(null)
  const [output, setOutput] = useState("Fixture sintética · prévia → importar → desfazer")
  const [busy, setBusy] = useState(false)
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true)
    try {
      setOutput(JSON.stringify(await action(), null, 2))
    } catch (error) {
      setOutput(error instanceof Error ? error.message : "Falha na solicitação")
    } finally {
      setBusy(false)
    }
  }
  const getPreview = async () => {
    const value = await api.request("POST /api/v1/import/preview", { source: "manual", payload })
    setPreview(value)
    return value
  }
  const apply = async () => {
    if (!preview) return null
    const value = await api.request("POST /api/v1/import/apply", {
      previewId: preview.previewId,
      select: { [preview.agents[0]?.key ?? ""]: { instructions: true, skills: true, memories: true, routines: true } },
    })
    setResult(value)
    return value
  }

  return (
    <main
      style={{
        margin: "40px auto",
        maxWidth: 880,
        padding: 24,
        color: "var(--text)",
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: 16,
      }}
    >
      <p>Evidência de integração · dados fictícios</p>
      <h1>Importação de agentes · API</h1>
      <p>Cliente UiApi conectado ao servidor real. A interface do onboarding é validada separadamente.</p>
      <div style={{ display: "flex", gap: 12, marginBlock: 24 }}>
        <Button disabled={busy} onClick={() => run(getPreview)}>
          Revisar exportação
        </Button>
        <Button disabled={busy || !preview} onClick={() => run(apply)}>
          Importar
        </Button>
        <Button
          disabled={busy || !result}
          onClick={() => run(() => api.request("POST /api/v1/import/undo", { importId: result?.importId ?? "" }))}
        >
          Desfazer
        </Button>
      </div>
      <pre
        data-testid="output"
        aria-live="polite"
        style={{ height: 600, overflow: "auto", whiteSpace: "pre-wrap", background: "var(--bg)", padding: 20 }}
      >
        {output}
      </pre>
    </main>
  )
}
const root = document.getElementById("root")
if (root) createRoot(root).render(<Harness />)
