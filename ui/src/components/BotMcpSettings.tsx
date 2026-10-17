import type { McpServer, McpTool, McpToolPolicy } from "@touri/contracts"
import { useEffect, useId, useRef, useState } from "react"
import type { UiApi } from "../api/client"
import { ApiError } from "../errors"
import { t } from "../i18n"
import { McpCatalog } from "./McpCatalog"

const parseArgs = (value: string): string[] | null => {
  try {
    const args: unknown = JSON.parse(value)
    return Array.isArray(args) && args.every((arg) => typeof arg === "string") ? args : null
  } catch {
    return null
  }
}

export const BotMcpSettings = ({
  api,
  botId,
  onOpenIntegrations,
  onPermissionsChange,
  focusOnOpen = false,
}: {
  api: UiApi
  botId: string
  onOpenIntegrations?: () => void
  onPermissionsChange?: () => void
  focusOnOpen?: boolean
}) => {
  const sectionRef = useRef<HTMLElement>(null)
  useEffect(() => {
    if (!focusOnOpen) return
    sectionRef.current?.scrollIntoView?.({ block: "start" })
    sectionRef.current?.focus({ preventScroll: true })
  }, [focusOnOpen])
  const [servers, setServers] = useState<McpServer[]>([])
  const [name, setName] = useState("")
  const [transport, setTransport] = useState<"stdio" | "http">("stdio")
  const [endpoint, setEndpoint] = useState("")
  const [args, setArgs] = useState("[]")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [missingCommand, setMissingCommand] = useState(false)
  const folderHelpId = useId()
  const argsHelpId = useId()
  const commandErrorId = useId()
  const nameHelpId = useId()
  const validName = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(name.trim()) && name.trim() !== "touri"
  const parsedArgs = parseArgs(args)
  const filesystemIndex = parsedArgs?.indexOf("@modelcontextprotocol/server-filesystem") ?? -1
  const folders = parsedArgs?.slice(filesystemIndex + 1) ?? []
  const validFolders =
    filesystemIndex < 0 ||
    (folders.length > 0 && folders.every((path) => path.startsWith("/") && !/[\0\n\r]/.test(path)))
  const canAttach = validName && !!endpoint.trim() && (transport === "http" || (!!parsedArgs && validFolders))
  useEffect(() => {
    let active = true
    void api
      .request("GET /bots/:id/mcp", {}, { id: botId })
      .then((result) => {
        if (active) setServers(result.servers)
      })
      .catch(() => {
        if (active) setError(t("Não foi possível carregar os servidores MCP."))
      })
    return () => {
      active = false
    }
  }, [api, botId])
  const attach = async () => {
    if (busy || !canAttach) return
    setBusy(true)
    setError(null)
    setMissingCommand(false)
    try {
      const server: McpServer =
        transport === "http"
          ? { name: name.trim(), transport, url: endpoint.trim(), tools: [] }
          : { name: name.trim(), transport, command: endpoint.trim(), args: parsedArgs ?? [], tools: [] }
      const result = await api.request("PUT /bots/:id/mcp/:name", server, { id: botId, name: server.name })
      setServers((current) => [...current.filter((item) => item.name !== result.server.name), result.server])
      onPermissionsChange?.()
      setName("")
      setEndpoint("")
      setArgs("[]")
    } catch (error) {
      const missing = error instanceof ApiError && error.code === "TOURI-E1012"
      setMissingCommand(missing)
      setError(
        missing
          ? t("O comando MCP “{command}” não foi encontrado. Confira a instalação e o PATH na máquina deste bot.", {
              command: endpoint.trim(),
            })
          : error instanceof Error
            ? error.message
            : t("Servidor MCP indisponível."),
      )
    } finally {
      setBusy(false)
    }
  }
  const updateTool = async (
    server: McpServer,
    tool: McpTool,
    patch: { classification?: "reads" | "writes"; policy?: McpToolPolicy },
  ) => {
    setBusy(true)
    setError(null)
    try {
      const result = await api.request(
        "PATCH /bots/:id/mcp/:name/tools/:tool",
        {
          classification: patch.classification ?? tool.classification ?? "writes",
          policy: patch.policy ?? tool.policy ?? "needs_approval",
        },
        { id: botId, name: server.name, tool: tool.name },
      )
      setServers((current) => current.map((value) => (value.name === server.name ? result.server : value)))
      onPermissionsChange?.()
    } catch (error) {
      setError(error instanceof Error ? error.message : "Não foi possível atualizar a política.")
    } finally {
      setBusy(false)
    }
  }
  return (
    <section ref={sectionRef} tabIndex={-1} className="bot-mcp-settings" aria-label={t("Servidores MCP deste bot")}>
      <h3>{t("Servidores MCP deste bot")}</h3>
      <p>{t("Conecte um servidor para disponibilizar suas ferramentas somente a este bot.")}</p>
      {onOpenIntegrations && (
        <button type="button" className="text-button" onClick={onOpenIntegrations}>
          Abrir Integrações
        </button>
      )}
      <McpCatalog
        onSelect={(server) => {
          setError(null)
          setMissingCommand(false)
          setName(server.name)
          setTransport(server.transport)
          setEndpoint(server.transport === "stdio" ? server.command : server.url)
          setArgs(server.transport === "stdio" ? JSON.stringify(server.args) : "[]")
        }}
      />
      {servers.length === 0 && (
        <p>{t("Nenhum servidor externo conectado. Gmail e outras integrações precisam de uma conexão MCP.")}</p>
      )}
      {servers.map((server) => (
        <article key={server.name}>
          <strong>
            {server.name} · {server.transport}
          </strong>
          {server.tools.length === 0 && <p>{t("Nenhuma ferramenta anunciada.")}</p>}
          {server.tools.map((tool) => (
            <fieldset key={tool.name} disabled={busy}>
              <legend>{tool.name}</legend>
              {tool.description && <p>{tool.description}</p>}
              <label>
                Classificação · {tool.name}
                <select
                  value={tool.classification ?? "writes"}
                  onChange={(event) =>
                    void updateTool(server, tool, { classification: event.target.value as "reads" | "writes" })
                  }
                >
                  <option value="reads">Leitura</option>
                  <option value="writes">Escrita</option>
                </select>
              </label>
              <label>
                Política · {tool.name}
                <select
                  value={tool.policy ?? "needs_approval"}
                  onChange={(event) => void updateTool(server, tool, { policy: event.target.value as McpToolPolicy })}
                >
                  <option value="always_allow">Sempre permitir</option>
                  <option value="needs_approval">Pedir aprovação</option>
                  <option value="blocked">Bloquear</option>
                </select>
              </label>
            </fieldset>
          ))}
          <button
            type="button"
            className="text-button"
            disabled={busy}
            onClick={() =>
              void api
                .request("DELETE /bots/:id/mcp/:name", {}, { id: botId, name: server.name })
                .then(() => {
                  setServers((current) => current.filter((item) => item.name !== server.name))
                  onPermissionsChange?.()
                })
                .catch(() => setError(t("Não foi possível desconectar o servidor MCP.")))
            }
          >
            {t("Desconectar")}
          </button>
        </article>
      ))}
      <label>
        {t("Nome do servidor MCP")}
        <input
          value={name}
          aria-invalid={!!name && !validName}
          aria-describedby={name && !validName ? nameHelpId : undefined}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      {name && !validName && (
        <p id={nameHelpId} role="alert">
          {t("Use de 1 a 64 letras sem acentos, números, _ ou -, começando por uma letra. O nome touri é reservado.")}
        </p>
      )}
      <label>
        {t("Transporte MCP")}
        <select
          value={transport}
          onChange={(event) => {
            setTransport(event.target.value as "stdio" | "http")
            setMissingCommand(false)
            setError(null)
          }}
        >
          <option value="stdio">stdio</option>
          <option value="http">HTTP</option>
        </select>
      </label>
      <label>
        {transport === "stdio" ? t("Comando MCP") : t("URL MCP")}
        <input
          value={endpoint}
          aria-invalid={missingCommand}
          aria-describedby={missingCommand ? commandErrorId : undefined}
          onChange={(event) => {
            setEndpoint(event.target.value)
            setMissingCommand(false)
            setError(null)
          }}
        />
      </label>
      {transport === "stdio" && (
        <>
          {filesystemIndex >= 0 && parsedArgs && (
            <>
              <label>
                {t("Pasta permitida (caminho absoluto)")}
                <input
                  required
                  value={folders[0] ?? ""}
                  aria-describedby={folderHelpId}
                  aria-invalid={!validFolders}
                  onChange={(event) =>
                    setArgs(
                      JSON.stringify([
                        ...parsedArgs.slice(0, filesystemIndex + 1),
                        event.target.value,
                        ...folders.slice(1),
                      ]),
                    )
                  }
                />
              </label>
              <small id={folderHelpId}>
                {t("Informe pelo menos uma pasta com caminho absoluto antes de conectar.")}
              </small>
            </>
          )}
          <label>
            {t("Argumentos MCP (lista JSON)")}
            <input
              value={args}
              aria-invalid={!parsedArgs}
              aria-describedby={!parsedArgs ? argsHelpId : undefined}
              onChange={(event) => setArgs(event.target.value)}
            />
          </label>
          {!parsedArgs && (
            <p id={argsHelpId} role="alert">
              {t('Informe uma lista JSON de textos. Exemplo: ["--porta", "3000"] ou [].')}
            </p>
          )}
        </>
      )}
      <button type="button" className="button button-quiet" disabled={busy || !canAttach} onClick={() => void attach()}>
        {busy ? t("Verificando ferramentas…") : t("Conectar servidor MCP")}
      </button>
      {error && (
        <p id={commandErrorId} role="alert">
          {error}
        </p>
      )}
    </section>
  )
}
