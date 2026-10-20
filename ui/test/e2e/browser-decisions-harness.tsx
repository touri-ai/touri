import type { ToolCallPart } from "@touri/contracts"
import { useState } from "react"
import { createRoot } from "react-dom/client"
import { ToolCallCard } from "../../src/components/ToolCallCard"
import { initializeTheme } from "../../src/design/theme"
import { t } from "../../src/i18n"
import "../../src/styles.css"

const Harness = () => {
  const [part, setPart] = useState<ToolCallPart>()
  const [image, setImage] = useState("")
  const [busy, setBusy] = useState(false)
  const step = async (step: string) => {
    setBusy(true)
    try {
      const response = await fetch("/__browser-decision-fixture", { method: "POST", body: JSON.stringify({ step }) })
      const result = await response.json()
      setPart(result.part)
      setImage(result.snapshot?.image?.dataUrl ?? "")
    } finally {
      setBusy(false)
    }
  }
  return (
    <main style={{ maxWidth: 960, margin: "24px auto", padding: 16 }}>
      <h1>{t("Browser enabled")}</h1>
      <nav aria-label={t("Browser enabled")} style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
        {["destination", "exact", "option", "cabin", "calendar", "date", "submit"].map((name) => (
          <button key={name} type="button" disabled={busy} onClick={() => void step(name)}>
            {name}
          </button>
        ))}
      </nav>
      {busy && <p role="status">{t("Connecting to the provider…")}</p>}
      {part && <ToolCallCard part={part} />}
      {image && (
        <img
          alt="Página fictícia de pesquisa de viagem"
          src={image}
          style={{ width: "100%", marginTop: 16, borderRadius: 12 }}
        />
      )}
    </main>
  )
}
initializeTheme()
const root = document.getElementById("root")
if (root) createRoot(root).render(<Harness />)
