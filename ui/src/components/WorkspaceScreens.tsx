import type {
  Bot,
  BrowserTabInfo,
  Id,
  Message,
  PreviewTarget,
  ProcessRunState,
  ProcessSpec,
  Project,
  Thread,
} from "@touri/contracts"
import { useCallback, useEffect, useRef, useState } from "react"
import type { TauriInvoke, UiApi } from "../api/client"
import { type ApprovalTarget, pendingApprovalTargets } from "../approvalNavigation"
import { localizeNotice, mcpGroupLabel, statusLabel, t } from "../i18n"
import { messageMarkdown } from "../messageMarkdown"
import type { ThreadCreationStatus } from "../workspaceState"
import { BotAvatar } from "./BotAvatar"
import { LearningCard } from "./LearningCard"
import { MarkdownContent } from "./MarkdownContent"
import { mcpPresets } from "./McpCatalog"
import { Mem0Card } from "./Mem0Card"
import { ScreenServerPolicies, useScreenConnections } from "./ScreenConnections"
import { ScreenHeader, ScreenState } from "./ScreenPrimitives"
import { TelegramIntegrationCard } from "./TelegramIntegrationCard"
import "./screens.css"
import { PreviewPane } from "./PreviewPane"
import { BrowserPanel } from "./RightPanels"

type ProcessEntry = { spec: ProcessSpec; run: ProcessRunState | null }

type ConnectionScreenProps = {
  api: UiApi
  botId: string | null
  botName: string | null
  onConfigure?: () => void
  modalOpen?: boolean
}

export const IntegrationsScreen = ({ api, botId, botName, onConfigure, modalOpen }: ConnectionScreenProps) => {
  const connections = useScreenConnections(api, botId, modalOpen)
  return (
    <section className="workspace-screen r8-screen integrations-screen" aria-labelledby="integrations-title">
      <ScreenHeader
        id="integrations-title"
        title="Integrações"
        description="Conecte aplicativos e arquivos às ferramentas de cada bot."
        actions={
          botName &&
          onConfigure && (
            <button type="button" className="brand-button" onClick={onConfigure}>
              Configurar MCP de {botName}
            </button>
          )
        }
      />
      <div className="screen-content">
        <div className="screen-section-heading">
          <h2>{botName ? `Conexões de ${botName}` : "Escolha um bot para conectar"}</h2>
          <p>As conexões e permissões pertencem somente a este bot.</p>
        </div>
        {connections.status === "loading" ? (
          <ScreenState kind="loading" />
        ) : connections.status === "error" ? (
          <ScreenState
            kind="error"
            description="Confira a conexão para ver as integrações deste bot."
            onRetry={connections.retry}
          />
        ) : (
          <>
            <div className="screen-provider-grid">
              {mcpPresets.map((preset) => {
                const server = connections.servers.find((item) => item.name === preset.server.name)
                return (
                  <article className="screen-card screen-provider-card" key={preset.server.name}>
                    <div className="screen-card-heading">
                      <span className="screen-provider-mark" aria-hidden="true">
                        {preset.title === "Gmail" ? "@" : "⌁"}
                      </span>
                      <h3>{preset.title}</h3>
                      <span className={`screen-status ${server ? "is-success" : ""}`}>
                        {server ? "Configurado" : "Não conectado"}
                      </span>
                    </div>
                    <p>{preset.description}</p>
                    <details>
                      <summary>Como conectar</summary>
                      <p>{preset.guidance}</p>
                      <a href={preset.docs} target="_blank" rel="noreferrer">
                        Instruções do servidor {preset.title} ↗
                      </a>
                    </details>
                    <div className="screen-card-footer">
                      <span>
                        {server
                          ? `${server.tools.length} ${server.tools.length === 1 ? "ferramenta disponível" : "ferramentas disponíveis"}`
                          : "Conexão via MCP"}
                      </span>
                      {onConfigure && botId && (
                        <button type="button" className="outline-button" onClick={onConfigure}>
                          {server ? "Gerenciar" : "Conectar"} {preset.title}
                        </button>
                      )}
                    </div>
                  </article>
                )
              })}
              {connections.servers
                .filter((server) => !mcpPresets.some((preset) => preset.server.name === server.name))
                .map((server) => (
                  <article className="screen-card screen-provider-card" key={server.name}>
                    <div className="screen-card-heading">
                      <h3>{server.name}</h3>
                      <span className="screen-status is-success">Configurado</span>
                    </div>
                    <p>
                      {server.tools.length}{" "}
                      {server.tools.length === 1 ? "ferramenta disponível" : "ferramentas disponíveis"} ·{" "}
                      {server.transport === "http" ? "HTTP" : "Processo local"}
                    </p>
                    <div className="screen-card-footer">
                      {onConfigure && (
                        <button type="button" className="outline-button" onClick={onConfigure}>
                          Gerenciar {server.name}
                        </button>
                      )}
                    </div>
                  </article>
                ))}
            </div>
            {connections.servers.length === 0 && (
              <ScreenState
                kind="empty"
                title="Nenhuma integração conectada"
                description="Escolha uma opção acima para começar."
              />
            )}
          </>
        )}
        {botId && (
          <div className="screen-provider-grid telegram-integration">
            <TelegramIntegrationCard api={api} botId={botId} />
          </div>
        )}
        {botId && (
          <div className="screen-provider-grid">
            <Mem0Card api={api} botId={botId} />
          </div>
        )}
        <p className="screen-help">Prepare o login na máquina do bot. Em uma VM, arquivos e credenciais ficam na VM.</p>
        {botId && (
          <div className="screen-provider-grid learning-grid">
            <LearningCard api={api} botId={botId} />
          </div>
        )}
      </div>
    </section>
  )
}

type GatewayTool = { name: string; description: string; group: string }

export const McpScreen = ({
  api,
  botId = null,
  botName = null,
  onConfigure,
  modalOpen,
}: {
  api: UiApi
  botId?: string | null
  botName?: string | null
  onConfigure?: () => void
  modalOpen?: boolean
}) => {
  const [tools, setTools] = useState<GatewayTool[]>([])
  const [server, setServer] = useState<{ name: string; version: string } | null>(null)
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading")
  const [revision, setRevision] = useState(0)
  const connections = useScreenConnections(api, botId, modalOpen)
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision requests a fresh gateway snapshot
  useEffect(() => {
    let active = true
    setStatus("loading")
    void api
      .request("GET /mcp/tools", {})
      .then((response) => {
        if (active) {
          setTools(response.tools)
          setServer(response.server)
          setStatus("ready")
        }
      })
      .catch(() => {
        if (active) setStatus("error")
      })
    return () => {
      active = false
    }
  }, [api, revision])
  return (
    <section className="workspace-screen r8-screen mcp-screen" aria-labelledby="mcp-title">
      <ScreenHeader
        id="mcp-title"
        title="MCP"
        description="Servidores, ferramentas e permissões em um só lugar."
        actions={
          <>
            {onConfigure && botId && (
              <button type="button" className="brand-button" onClick={onConfigure}>
                Conectar servidor
              </button>
            )}
            <button
              type="button"
              className="outline-button"
              onClick={() => {
                setRevision((value) => value + 1)
                connections.retry()
              }}
            >
              Atualizar
            </button>
          </>
        }
      />
      <div className="screen-content">
        <section className="screen-card screen-gateway-card" aria-label={t("Ferramentas do touri neste computador")}>
          <div className="screen-card-heading">
            <span className="screen-provider-mark" aria-hidden="true">
              M
            </span>
            <div>
              <h2>{server?.name ?? "touri"}</h2>
              <p>
                {t("Ferramentas do touri neste computador")}
                {server ? ` · ${server.version}` : ""}
              </p>
            </div>
            <span
              className={`screen-status ${status === "ready" ? "is-success" : status === "error" ? "is-error" : ""}`}
            >
              {status === "ready" ? "Conectado" : status === "error" ? "Indisponível" : "Conectando…"}
            </span>
          </div>
        </section>
        {status === "loading" ? (
          <ScreenState kind="loading" />
        ) : status === "error" ? (
          <ScreenState
            kind="error"
            description={t("As ferramentas do touri estão indisponíveis.")}
            onRetry={() => setRevision((value) => value + 1)}
          />
        ) : (
          <>
            <div className="screen-section-heading">
              <h2>{botName ? `Servidores de ${botName}` : "Servidores externos"}</h2>
              <p>Defina o acesso e a aprovação de cada ferramenta.</p>
            </div>
            {connections.status === "loading" ? (
              <ScreenState kind="loading" />
            ) : connections.status === "error" ? (
              <ScreenState
                kind="error"
                description="Os servidores deste bot estão indisponíveis."
                onRetry={connections.retry}
              />
            ) : connections.servers.length === 0 ? (
              <ScreenState
                kind="empty"
                title="Nenhum servidor externo conectado"
                description="Conecte um servidor para adicionar ferramentas a este bot."
              />
            ) : (
              connections.servers.map(
                (external) =>
                  botId && (
                    <ScreenServerPolicies
                      key={`${botId}:${external.name}`}
                      api={api}
                      botId={botId}
                      server={external}
                      onUpdate={(updated) =>
                        connections.setServers((current) =>
                          current.map((item) => (item.name === updated.name ? updated : item)),
                        )
                      }
                    />
                  ),
              )
            )}
            <details className="screen-card screen-gateway-tools">
              <summary>
                {t("Ferramentas do touri")} <span>{tools.length}</span>
              </summary>
              {tools.length === 0 ? (
                <ScreenState kind="empty" title="Nenhuma ferramenta registrada" />
              ) : (
                <div className="screen-gateway-list">
                  {tools.map((tool) => (
                    <article key={tool.name}>
                      <div>
                        <code>{tool.name}</code>
                        <span className="screen-status">{mcpGroupLabel(tool.group)}</span>
                      </div>
                      <p>{localizeNotice(tool.description)}</p>
                    </article>
                  ))}
                </div>
              )}
            </details>
          </>
        )}
      </div>
    </section>
  )
}

type PreviewScreenProps = {
  threadCreation?: ThreadCreationStatus | undefined
  onRetryCreateThread?: (() => void) | undefined
  project: Project | null
  processes: Array<ProcessEntry>
  preview: PreviewTarget | null
  modalOpen?: boolean
  browserTabs: Array<BrowserTabInfo & { ownerBotId: Id | null }>
  selectedBot: Bot | null
  selectedThread: Thread | null
  selectedMessages: Array<Message>
  api: UiApi
  invokeCommand: TauriInvoke
  onStart: (processId: Id) => Promise<void>
  onStop: (processId: Id) => Promise<void>
  onRestart: (processId: Id) => Promise<void>
  onSend: (text: string, parentId?: Id | null) => Promise<void>
  onBack: () => void
  onReviewApprovals?: (target: ApprovalTarget) => void
  onConnectProject: () => void
  onNotice: (message: string) => void
}

export const PreviewScreen = ({
  threadCreation,
  onRetryCreateThread,
  project,
  processes,
  preview,
  modalOpen = false,
  browserTabs,
  selectedBot,
  selectedThread,
  selectedMessages,
  api,
  invokeCommand,
  onStart,
  onStop,
  onRestart,
  onSend,
  onBack,
  onReviewApprovals,
  onConnectProject,
  onNotice,
}: PreviewScreenProps) => {
  const [tab, setTab] = useState<"preview" | "logs" | "browser">("preview")
  const [draft, setDraft] = useState("")
  const [logs, setLogs] = useState<Array<string>>([])
  const [logsProcess, setLogsProcess] = useState<Id | null>(null)
  const [logsLoading, setLogsLoading] = useState(false)
  const [logsError, setLogsError] = useState(false)
  const [wrapLogs, setWrapLogs] = useState(true)
  const logsRequest = useRef(0)
  const logsSnapshotPending = useRef(false)
  const liveLogBuffer = useRef<string[]>([])
  const pendingApprovals = pendingApprovalTargets(selectedMessages)
  const [projectMenuOpen, setProjectMenuOpen] = useState(false)
  const context = `${project?.id ?? ""}:${selectedBot?.id ?? ""}`
  const contextRef = useRef(context)
  contextRef.current = context
  // biome-ignore lint/correctness/useExhaustiveDependencies: clear local view state whenever bot or project changes
  useEffect(() => {
    setLogs([])
    setLogsProcess(null)
    setLogsLoading(false)
    setLogsError(false)
    logsRequest.current += 1
    logsSnapshotPending.current = false
    liveLogBuffer.current = []
    setDraft("")
    setProjectMenuOpen(false)
    setTab("preview")
  }, [project?.id, selectedBot?.id])

  useEffect(() => {
    return api.subscribe((envelope) => {
      const event = envelope.event
      if (event.type === "process.log" && event.processId === logsProcess) {
        if (logsSnapshotPending.current) liveLogBuffer.current = [...liveLogBuffer.current, ...event.lines].slice(-2000)
        setLogs((current) => [...current, ...event.lines].slice(-2000))
      }
    })
  }, [api, logsProcess])

  const loadLogs = useCallback(
    async (processId: Id): Promise<void> => {
      setLogsProcess(processId)
      setLogs([])
      setLogsLoading(true)
      setLogsError(false)
      const request = ++logsRequest.current
      logsSnapshotPending.current = true
      liveLogBuffer.current = []
      const requestedContext = contextRef.current
      try {
        const response = await api.request("GET /processes/:id/logs", { tail: 200 }, { id: processId })
        if (contextRef.current === requestedContext && request === logsRequest.current)
          setLogs([...response.lines, ...liveLogBuffer.current].slice(-2000))
      } catch {
        if (contextRef.current === requestedContext && request === logsRequest.current) setLogsError(true)
      } finally {
        if (contextRef.current === requestedContext && request === logsRequest.current) {
          logsSnapshotPending.current = false
          setLogsLoading(false)
        }
      }
    },
    [api],
  )
  useEffect(() => {
    const only = processes.length === 1 ? processes[0] : null
    if (tab === "logs" && only && logsProcess !== only.spec.id) void loadLogs(only.spec.id)
  }, [tab, processes, logsProcess, loadLogs])
  const submit = async (): Promise<void> => {
    if (threadCreation || !draft.trim() || !selectedThread) return
    await onSend(draft, selectedThread.activeLeafId)
    setDraft("")
  }
  const copyLogs = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(logs.join("\n"))
      onNotice("Logs copiados")
    } catch {
      onNotice("Não foi possível copiar os logs.")
    }
  }
  return (
    <section className="preview-screen r8-preview" aria-labelledby="preview-title">
      <div className="preview-screen-header">
        <ScreenHeader
          id="preview-title"
          title="Preview"
          description={
            project
              ? `${project.name} · acompanhe o projeto e a conversa`
              : "Conecte um projeto para acompanhar seu desenvolvimento."
          }
          actions={
            <>
              <button type="button" className="outline-button" onClick={onBack}>
                ‹ Voltar ao chat
              </button>
              <div className="preview-tabs" role="tablist" aria-label="Preview do projeto">
                {(["preview", "logs", "browser"] as const).map((item) => (
                  <button
                    type="button"
                    role="tab"
                    aria-selected={tab === item}
                    className={tab === item ? "active" : ""}
                    onClick={() => setTab(item)}
                    key={item}
                  >
                    {item === "preview" ? "Preview" : item === "logs" ? "Logs" : "Navegador"}
                  </button>
                ))}
              </div>
            </>
          }
        />
      </div>
      <div className="preview-screen-body">
        <aside className="preview-project-sidebar">
          <div className="project-sidebar-heading">
            <span className="folder-mark" aria-hidden="true">
              □
            </span>
            <strong>{project?.name ?? "Projeto"}</strong>
            <div className="project-menu-wrap">
              <button
                type="button"
                className="icon-button project-menu-button"
                aria-label={t("Project menu")}
                aria-expanded={projectMenuOpen}
                onClick={() => setProjectMenuOpen((current) => !current)}
              >
                ···
              </button>
              {projectMenuOpen && (
                <div className="project-menu" role="menu">
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setProjectMenuOpen(false)
                      onConnectProject()
                    }}
                  >
                    {t("Conectar projeto")}
                  </button>
                </div>
              )}
            </div>
          </div>
          <p className="project-path">
            {project?.path ?? t("No project for bot", { name: selectedBot?.name ?? "bot" })}
          </p>
          {!project && (
            <button type="button" className="button button-brand connect-project-empty" onClick={onConnectProject}>
              {t("Conectar projeto")}
            </button>
          )}

          <h2>{t("Processos")}</h2>
          <div className="preview-process-list">
            {processes.map((entry) => {
              const status = entry.run?.status ?? "não iniciado"
              return (
                <div className="preview-process-entry" key={entry.spec.id}>
                  <button
                    type="button"
                    className="preview-process-row"
                    onClick={() => {
                      setTab("logs")
                      void loadLogs(entry.spec.id)
                    }}
                  >
                    <i className={status === "ready" ? "ready" : ""} />
                    <span>
                      <strong>{entry.spec.name}</strong>
                      <small>{entry.spec.command}</small>
                    </span>
                    <em>{entry.spec.previewPort ? `:${entry.spec.previewPort}` : statusLabel(status)}</em>
                  </button>
                  <div className="preview-process-actions">
                    <button type="button" onClick={() => void onStart(entry.spec.id)} disabled={status === "ready"}>
                      {t("Iniciar")}
                    </button>
                    <button
                      type="button"
                      onClick={() => void onStop(entry.spec.id)}
                      disabled={!entry.run || status === "stopped"}
                    >
                      {t("Parar")}
                    </button>
                    <button
                      type="button"
                      disabled={!entry.run || !["starting", "running", "ready"].includes(status)}
                      onClick={() => void onRestart(entry.spec.id)}
                    >
                      {t("Reiniciar")}
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
          <div className="preview-project-actions">
            <button
              type="button"
              className="brand-button"
              disabled={
                !!project &&
                !processes.some((entry) => !entry.run || !["starting", "running", "ready"].includes(entry.run.status))
              }
              onClick={() => {
                if (!project) {
                  onConnectProject()
                  return
                }
                for (const entry of processes)
                  if (!entry.run || !["starting", "running", "ready"].includes(entry.run.status))
                    void onStart(entry.spec.id)
              }}
            >
              {project ? t("Subir tudo") : t("Conectar projeto")}
            </button>
            <button
              type="button"
              className="outline-button"
              disabled={
                !processes.some((entry) => entry.run && ["starting", "running", "ready"].includes(entry.run.status))
              }
              onClick={() => {
                for (const entry of processes)
                  if (entry.run && ["starting", "running", "ready"].includes(entry.run.status))
                    void onStop(entry.spec.id)
              }}
            >
              {t("Parar")}
            </button>
          </div>
        </aside>
        <main className="preview-main-pane">
          {tab === "preview" &&
            (preview ? (
              <PreviewPane
                preview={preview}
                modalOpen={modalOpen || projectMenuOpen}
                invokeCommand={invokeCommand}
                onOpenAgentBrowser={(url) => onNotice(t("Open agent URL", { url }))}
              />
            ) : (
              <ScreenState
                kind="empty"
                title={
                  project ? "Nenhum preview disponível" : t("No project for bot", { name: selectedBot?.name ?? "bot" })
                }
                description={
                  project
                    ? "Inicie um processo com porta HTTP para visualizar o projeto."
                    : t(
                        "Para usar o Preview, conecte a pasta do aplicativo como projeto e inicie um processo HTTP deste bot. Você pode pedir ao bot para preparar isso; a conexão exige sua aprovação.",
                      )
                }
              >
                {!project && (
                  <button type="button" className="brand-button" onClick={onConnectProject}>
                    Conectar
                  </button>
                )}
              </ScreenState>
            ))}
          {tab === "logs" && (
            <div className="preview-log-panel">
              <div className="preview-log-toolbar">
                <label className="visually-hidden" htmlFor="preview-log-process">
                  Processo dos logs
                </label>
                <select
                  id="preview-log-process"
                  value={logsProcess ?? ""}
                  onChange={(event) => void loadLogs(event.target.value)}
                >
                  <option value="" disabled>
                    Selecione um processo
                  </option>
                  {processes.map((entry) => (
                    <option key={entry.spec.id} value={entry.spec.id}>
                      {entry.spec.name}
                    </option>
                  ))}
                </select>
                <span className="preview-log-count">
                  {logs.length} {logs.length === 1 ? "linha" : "linhas"}
                </span>
                <div className="preview-log-actions">
                  <button
                    type="button"
                    disabled={!logsProcess || logsLoading}
                    onClick={() => {
                      if (logsProcess) void loadLogs(logsProcess)
                    }}
                  >
                    Atualizar
                  </button>
                  <button type="button" aria-pressed={wrapLogs} onClick={() => setWrapLogs((value) => !value)}>
                    Quebrar linhas
                  </button>
                  <button type="button" disabled={logs.length === 0} onClick={() => void copyLogs()}>
                    Copiar
                  </button>
                  <button type="button" disabled={logs.length === 0} onClick={() => setLogs([])}>
                    Limpar
                  </button>
                </div>
              </div>
              {logsLoading ? (
                <ScreenState kind="loading" />
              ) : logsError ? (
                <ScreenState
                  kind="error"
                  description="Os logs deste processo estão indisponíveis."
                  onRetry={() => {
                    if (logsProcess) void loadLogs(logsProcess)
                  }}
                />
              ) : !logsProcess || logs.length === 0 ? (
                <ScreenState
                  kind="empty"
                  title={logsProcess ? "Aguardando logs do processo" : "Selecione um processo"}
                  description="A saída do processo aparecerá aqui."
                />
              ) : (
                <pre
                  className={`preview-logs ${wrapLogs ? "wrap-lines" : ""}`}
                  role="log"
                  aria-live="off"
                  aria-label="Logs do processo"
                >
                  {logs.join("\n")}
                </pre>
              )}
            </div>
          )}
          {tab === "browser" && (
            <BrowserPanel tabs={browserTabs} botId={selectedBot?.id ?? null} api={api} onNotice={onNotice} />
          )}
        </main>
        <aside className="preview-chat-sidebar">
          <div className="preview-chat-heading">
            {selectedBot ? <BotAvatar bot={selectedBot} size={24} /> : <span className="preview-chat-avatar">S</span>}
            <strong>{selectedBot?.name ?? "Bot"}</strong>
          </div>
          {pendingApprovals.length > 0 && (
            <button
              type="button"
              className="preview-approval-link"
              onClick={() => {
                const target = pendingApprovals[0]
                if (target && onReviewApprovals) onReviewApprovals(target)
                else onBack()
              }}
            >
              Aprovação pendente — abrir no chat <span aria-hidden="true">→</span>
            </button>
          )}
          <div className="preview-chat-feed">
            {selectedMessages.slice(-3).map((message) => (
              <div className={message.role === "user" ? "preview-message user" : "preview-message"} key={message.id}>
                <div className="preview-message-meta">
                  <span>{message.role === "user" ? "Você" : (selectedBot?.name ?? "Bot")}</span>
                  <time dateTime={new Date(message.createdAt).toISOString()}>
                    {new Date(message.createdAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}
                  </time>
                </div>
                <MarkdownContent
                  compact
                  content={
                    message.role === "system" || message.role === "tool"
                      ? localizeNotice(messageMarkdown(message))
                      : messageMarkdown(message)
                  }
                />
              </div>
            ))}
            {selectedMessages.length === 0 && <p className="muted-copy">{t("Nenhuma mensagem nesta conversa.")}</p>}
          </div>
          {threadCreation === "pending" && <p role="status">{t("Criando conversa…")}</p>}
          {threadCreation === "failed" && (
            <div role="alert">
              <p>{t("Não foi possível criar a conversa. Seu rascunho foi mantido.")}</p>
              <button type="button" onClick={onRetryCreateThread}>
                {t("Tentar criar conversa novamente")}
              </button>
            </div>
          )}
          <form
            className="preview-composer"
            onSubmit={(event) => {
              event.preventDefault()
              void submit()
            }}
          >
            <input
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder={t("Mensagem para o bot…")}
              aria-label={t("Mensagem para o bot")}
            />
            <button
              type="submit"
              aria-label={t("Enviar")}
              disabled={Boolean(threadCreation) || !selectedThread || !draft.trim()}
            >
              ↑
            </button>
          </form>
        </aside>
      </div>
    </section>
  )
}
