import type { McpServer } from "@touri/contracts"
import { t } from "../i18n"

export const mcpPresets: Array<{ server: McpServer; title: string; guidance: string; setup?: string; docs: string }> = [
  {
    title: "Gmail",
    server: { name: "gmail", transport: "stdio", command: "npx", args: ["-y", "@shinzolabs/gmail-mcp"], tools: [] },
    guidance:
      "Requer Node.js 18+, Gmail API ativada no Google Cloud e cliente OAuth do tipo App para computador. Salve o JSON em ~/.gmail-mcp/gcp-oauth.keys.json e autorize a conta para gerar ~/.gmail-mcp/credentials.json. Depois conecte o servidor abaixo.",
    setup: "npx @shinzolabs/gmail-mcp auth",
    docs: "https://github.com/shinzo-labs/gmail-mcp#prerequisites",
  },
  {
    title: "Arquivos locais",
    server: {
      name: "arquivos",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem"],
      tools: [],
    },
    guidance: t(
      "Requer Node.js. Ao usar esta configuração, informe o caminho absoluto de uma pasta permitida no campo abaixo. Não requer login ou token.",
    ),
    docs: "https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem",
  },
]

export const McpCatalog = ({ onSelect }: { onSelect?: (server: McpServer) => void }) => (
  <section className="mcp-catalog" aria-label="Catálogo de integrações MCP">
    <h3>Conectar uma integração</h3>
    <p>
      Prepare o servidor na máquina em que o bot executa. Para um bot em VM, os arquivos e o login devem estar na VM; o
      login do host não é copiado.
    </p>
    {mcpPresets.map((preset) => (
      <article key={preset.server.name}>
        <h4>{preset.title}</h4>
        <p>{preset.guidance}</p>
        {preset.setup && (
          <p>
            <code>{preset.setup}</code>
          </p>
        )}
        <a href={preset.docs} target="_blank" rel="noreferrer">
          Instruções do servidor {preset.title}
        </a>
        {onSelect && (
          <button type="button" className="button button-quiet" onClick={() => onSelect(preset.server)}>
            Usar configuração {preset.title}
          </button>
        )}
      </article>
    ))}
  </section>
)
