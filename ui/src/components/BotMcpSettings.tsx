import type { Bot, McpServer, McpTool, McpToolPolicy } from "@touri/contracts"
import { useCallback, useEffect, useId, useRef, useState } from "react"
import type { TauriInvoke, UiApi } from "../api/client"
import { ApiError } from "../errors"
import { t } from "../i18n"
import { McpCatalog, type McpPreset, mcpPresets } from "./McpCatalog"
import { McpSetupChecklist } from "./McpSetupChecklist"

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
  machine = "local",
  invokeCommand,
  botName,
  onContinue,
  onAttach,
  onFolder,
}: {
  api: UiApi
  botName?: string | undefined
  onContinue?: (() => void) | undefined
  onAttach?: (() => void) | undefined
  onFolder?: (() => void) | undefined
  botId: string
  onOpenIntegrations?: () => void
  onPermissionsChange?: () => void
  focusOnOpen?: boolean
  machine?: Bot["machine"]
  invokeCommand?: TauriInvoke | undefined
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
  const [connected, setConnected] = useState(false)
  const [advanced, setAdvanced] = useState(false)
  const [preset, setPreset] = useState<McpPreset | null>(null)
  const [setupReady, setSetupReady] = useState(false)
  const [tested, setTested] = useState<McpServer | null>(null)
  const [testing, setTesting] = useState(false)
  const [picking, setPicking] = useState(false)
  const operationRef = useRef(false)
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
  const resetTest = () => {
    setTested(null)
    setError(null)
    setMissingCommand(false)
  }
  const preparationReady = useCallback((ready: boolean) => {
    setSetupReady(ready)
    if (!ready) setTested(null)
  }, [])
  const setFolder = (path: string) => {
    if (!parsedArgs || filesystemIndex < 0) return
    resetTest()
    setArgs(JSON.stringify([...parsedArgs.slice(0, filesystemIndex + 1), path, ...folders.slice(1)]))
  }
  const chooseFolder = async () => {
    if (!invokeCommand || operationRef.current || busy) return
    operationRef.current = true
    setBusy(true)
    setPicking(true)
    try {
      const result = await invokeCommand("pick_folder", { title: t("Dar acesso a uma pasta") })
      if (result?.path) setFolder(result.path)
    } catch {
      setError(t("Não foi possível escolher a pasta. Tente novamente."))
    } finally {
      operationRef.current = false
      setBusy(false)
      setPicking(false)
    }
  }
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
  const serverConfig = (): McpServer =>
    transport === "http"
      ? { name: name.trim(), transport, url: endpoint.trim(), tools: [] }
      : { name: name.trim(), transport, command: endpoint.trim(), args: parsedArgs ?? [], tools: [] }
  const connectionError = (error: unknown) => {
    const missing = error instanceof ApiError && error.code === "TOURI-E1012"
    setMissingCommand(missing)
    setError(
      missing
        ? advanced
          ? t("O comando MCP “{command}” não foi encontrado. Confira a instalação e o PATH na máquina deste bot.", {
              command: endpoint.trim(),
            })
          : t("Instale Node.js na máquina deste bot, verifique a preparação e tente novamente.")
        : t("Não foi possível conectar. Confira a preparação, o endereço ou o acesso à rede e teste novamente."),
    )
  }
  const testConnection = async () => {
    if (operationRef.current || busy || !canAttach || (!!preset && !setupReady)) return
    operationRef.current = true
    setBusy(true)
    setTesting(true)
    setTested(null)
    setError(null)
    setMissingCommand(false)
    try {
      const result = await api.request("POST /bots/:id/mcp/test", serverConfig(), { id: botId })
      setTested(result.server)
    } catch (error) {
      connectionError(error)
    } finally {
      operationRef.current = false
      setTesting(false)
      setBusy(false)
    }
  }
  const attach = async () => {
    if (operationRef.current || busy || !canAttach || !tested?.tools.length || (!!preset && !setupReady)) return
    operationRef.current = true
    setBusy(true)
    setError(null)
    setMissingCommand(false)
    try {
      const server = serverConfig()
      const result = await api.request("PUT /bots/:id/mcp/:name", server, { id: botId, name: server.name })
      setConnected(true)
      setServers((current) => [...current.filter((item) => item.name !== result.server.name), result.server])
      onPermissionsChange?.()
      setName("")
      setEndpoint("")
      setArgs("[]")
      setTested(null)
      setPreset(null)
      setAdvanced(false)
    } catch (error) {
      setTested(null)
      connectionError(error)
    } finally {
      operationRef.current = false
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
        disabled={busy}
        technical={advanced}
        onAttach={onAttach}
        onFolder={machine === "cloud" ? undefined : onFolder}
        onSelect={(server) => {
          const selected = mcpPresets.find((item) => item.server.name === server.name)
          resetTest()
          setAdvanced(true)
          setConnected(false)
          setPreset(selected ? { ...selected } : null)
          setSetupReady(false)
          setError(null)
          setMissingCommand(false)
          setName(server.name)
          setTransport(server.transport)
          setEndpoint(server.transport === "stdio" ? server.command : server.url)
          setArgs(server.transport === "stdio" ? JSON.stringify(server.args) : "[]")
        }}
      />
      <button
        type="button"
        className="text-button"
        disabled={busy}
        aria-expanded={advanced}
        onClick={() => {
          setPreset(null)
          setAdvanced((value) => !value)
          setTested(null)
          setError(null)
        }}
      >
        {t("Configuração técnica (MCP)")}
      </button>
      {preset && advanced && (
        <McpSetupChecklist
          key={preset.server.name}
          api={api}
          botId={botId}
          preset={preset}
          onReady={preparationReady}
          disabled={busy}
        />
      )}
      {connected && (
        <div role="status">
          <p>{t("Dados disponíveis para {bot}.", { bot: botName ?? botId })}</p>
          {onContinue && (
            <button type="button" className="button button-brand" onClick={onContinue}>
              {t("Continuar tarefa")}
            </button>
          )}
        </div>
      )}
      {advanced && servers.length === 0 && (
        <p>{t("Nenhum servidor externo conectado. Gmail e outras integrações precisam de uma conexão MCP.")}</p>
      )}
      {!advanced &&
        servers.map((server) => <p key={server.name}>{t("Conexão disponível: {name}", { name: server.name })}</p>)}
      {advanced &&
        servers.map((server) => (
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
      {advanced && (
        <fieldset className="mcp-connection" disabled={busy}>
          <legend>{t("Configuração técnica (MCP)")}</legend>
          <label>
            {t("Nome do servidor MCP")}
            <input
              value={name}
              aria-invalid={!!name && !validName}
              aria-describedby={name && !validName ? nameHelpId : undefined}
              onChange={(event) => {
                resetTest()
                setName(event.target.value)
              }}
            />
          </label>
          {name && !validName && (
            <p id={nameHelpId} role="alert">
              {t(
                "Use de 1 a 64 letras sem acentos, números, _ ou -, começando por uma letra. O nome touri é reservado.",
              )}
            </p>
          )}
          <label>
            {t("Transporte MCP")}
            <select
              value={transport}
              onChange={(event) => {
                resetTest()
                setTransport(event.target.value as "stdio" | "http")
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
                resetTest()
                setEndpoint(event.target.value)
              }}
            />
          </label>
          {transport === "stdio" && (
            <>
              <label>
                {t("Argumentos MCP (lista JSON)")}
                <input
                  value={args}
                  aria-invalid={!parsedArgs}
                  aria-describedby={!parsedArgs ? argsHelpId : undefined}
                  onChange={(event) => {
                    resetTest()
                    setArgs(event.target.value)
                  }}
                />
              </label>
              {!parsedArgs && (
                <p id={argsHelpId} role="alert">
                  {t('Informe uma lista JSON de textos. Exemplo: ["--porta", "3000"] ou [].')}
                </p>
              )}
            </>
          )}
        </fieldset>
      )}
      {(preset || advanced) && (
        <div className="mcp-connection">
          {transport === "stdio" && filesystemIndex >= 0 && parsedArgs && (
            <>
              <label>
                {t("Pasta permitida (caminho absoluto)")}
                <input
                  required
                  disabled={busy}
                  value={folders[0] ?? ""}
                  aria-describedby={folderHelpId}
                  aria-invalid={!validFolders}
                  onChange={(event) => setFolder(event.target.value)}
                />
              </label>
              {invokeCommand && machine === "local" && (
                <button
                  type="button"
                  className="button button-quiet"
                  disabled={busy}
                  onClick={() => void chooseFolder()}
                >
                  {t("Escolher pasta…")}
                </button>
              )}
              <small id={folderHelpId}>
                {t("Informe pelo menos uma pasta com caminho absoluto antes de conectar.")}
              </small>
            </>
          )}
          <button
            type="button"
            className="button button-quiet"
            disabled={busy || !canAttach || (!!preset && !setupReady)}
            onClick={() => void testConnection()}
          >
            {testing ? t("Testando conexão…") : t("Testar conexão")}
          </button>
          {testing && <p role="status">{t("Buscando as ferramentas disponíveis…")}</p>}
          {tested && (
            <p role="status">
              {tested.tools.length > 0
                ? t("Conexão pronta: {count} ferramentas disponíveis. Salve para usá-las neste bot.", {
                    count: tested.tools.length,
                  })
                : t("O servidor respondeu, mas não ofereceu ferramentas. Confira a configuração e teste novamente.")}
            </p>
          )}
          <button
            type="button"
            className="button button-quiet"
            disabled={busy || !canAttach || !tested?.tools.length || (!!preset && !setupReady)}
            onClick={() => void attach()}
          >
            {busy && !testing && !picking
              ? t("Salvando conexão…")
              : advanced
                ? t("Conectar servidor MCP")
                : t("Salvar conexão")}
          </button>
        </div>
      )}
      {error && (
        <p id={commandErrorId} role="alert">
          {error}
        </p>
      )}
    </section>
  )
}
