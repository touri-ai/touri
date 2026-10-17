import type { McpServer } from "@touri/contracts"
import { t } from "../i18n"

export type McpPreset = {
  server: McpServer
  title: string
  description: string
  guidance: string
  setup?: string
  docs: string
}

export const mcpPresets: McpPreset[] = [
  {
    title: "Gmail",
    server: { name: "gmail", transport: "stdio", command: "npx", args: ["-y", "@shinzolabs/gmail-mcp"], tools: [] },
    description: t("Leia, organize e envie mensagens com a conta que você autorizar."),
    guidance: t("Uma conta Google e uma preparação no Google Cloud. Vamos orientar cada etapa."),
    setup: "npx @shinzolabs/gmail-mcp auth",
    docs: "https://github.com/shinzo-labs/gmail-mcp#prerequisites",
  },
  {
    title: t("Arquivos locais"),
    server: {
      name: "arquivos",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem"],
      tools: [],
    },
    description: t("O bot pode ler e editar arquivos nas pastas que você escolher."),
    guidance: t("Uma pasta permitida na máquina do bot e Node.js. Não precisa de conta ou senha."),
    docs: "https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem",
  },
]

export const McpCatalog = ({
  onSelect,
  disabled = false,
  technical = false,
  onAttach,
  onFolder,
}: {
  technical?: boolean
  onAttach?: (() => void) | undefined
  onFolder?: (() => void) | undefined
  onSelect?: (server: McpServer) => void
  disabled?: boolean
}) => (
  <section className="mcp-catalog" aria-label={t("Catálogo de integrações MCP")}>
    <h3>{t("Conectar uma integração")}</h3>
    <p>{t("Escolha o que seu bot poderá fazer. A conexão vale somente para este bot.")}</p>
    {!technical && (
      <>
        <p>{t("A conexão direta com esta fonte ainda não está disponível. Exporte um CSV para começar.")}</p>
        <div className="connect-data-actions">
          {onAttach && (
            <button type="button" className="button button-quiet" disabled={disabled} onClick={onAttach}>
              {t("Anexar CSV")}
            </button>
          )}
          {onFolder && (
            <button type="button" className="button button-quiet" disabled={disabled} onClick={onFolder}>
              {"__TAURI_INTERNALS__" in window ? t("Escolher pasta") : t("Escolher pasta do servidor")}
            </button>
          )}
        </div>
      </>
    )}
    {technical &&
      mcpPresets.map((preset) => (
        <article key={preset.server.name}>
          <h4>{preset.title}</h4>
          <p>{preset.description}</p>
          <strong>{t("O que você precisa")}</strong>
          <p>{preset.guidance}</p>
          {onSelect && (
            <button
              type="button"
              className="button button-quiet"
              disabled={disabled}
              onClick={() => onSelect(preset.server)}
            >
              {t("Conectar")}
            </button>
          )}
        </article>
      ))}
  </section>
)
