import { createRoot } from "react-dom/client"
import { MarkdownContent } from "../../src/components/MarkdownContent"
import "../../src/styles.css"

const params = new URLSearchParams(location.search)
document.documentElement.dataset.theme = params.get("theme") ?? "dark"

const flowchart =
  "flowchart LR\n  pedido[Pedido] --> atividade[Atividade resumida]\n  atividade --> resposta[Resposta visível]"
const sequence =
  "sequenceDiagram\n  participant Pessoa\n  participant Bot\n  Pessoa->>Bot: Solicitação\n  Bot-->>Pessoa: Resposta"
const restricted = `\`\`\`mermaid
%%{init: {"securityLevel":"loose","htmlLabels":true,"themeCSS":"body{opacity:0}"}}%%
flowchart LR
  A[Pedido] --> B[Resposta]
  click A "https://example.test/diagram-link"
\`\`\`

\`\`\`mermaid
flowchart LR; A-->B; classDef external fill:u\\72l(https://example.test/image.svg)
\`\`\``
const content =
  params.get("view") === "plain"
    ? "Resposta pronta, sem diagramas."
    : params.get("view") === "invalid"
      ? "```mermaid\nisto não é um diagrama válido\n```"
      : params.get("view") === "restricted"
        ? restricted
        : `A resposta está pronta. O diagrama mostra o resultado da tarefa.\n\n\`\`\`mermaid\n${flowchart}\n\`\`\`\n\nDetalhes do fluxo:\n\n\`\`\`mermaid\n${sequence}\n\`\`\``

const root = document.getElementById("root")
if (root)
  createRoot(root).render(
    <main style={{ maxWidth: 900, margin: "24px auto", padding: 24 }}>
      <article className="message-bubble message-assistant" aria-label="Resposta">
        <MarkdownContent content={content} />
      </article>
    </main>,
  )
