import { createRoot } from "react-dom/client"
import { createApiClient, webEndpoint } from "../../src/api/client"
import { ToolCallCard } from "../../src/components/ToolCallCard"
import "../../src/styles.css"

const params = new URLSearchParams(location.search)
document.documentElement.dataset.theme = params.get("theme") ?? "light"
const part = {
  type: "command" as const,
  callId: "saved-output",
  command: "cat resultado.txt",
  cwd: "/workspace",
  exitCode: 0,
  outputTail: "",
  outputAttachmentId: "saved-output",
  outputPreview: "Resumo: 300 etapas concluídas.\nTodos os resultados foram preservados.",
  resolution: "succeeded" as const,
}
const root = document.getElementById("root")
if (root)
  createRoot(root).render(
    <main style={{ maxWidth: 820, margin: "32px auto", padding: 24 }}>
      <ToolCallCard part={part} api={createApiClient({ endpoint: webEndpoint(location) })} />
    </main>,
  )
