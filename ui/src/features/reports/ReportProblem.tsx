import {
  type Bot,
  editReportSnapshot,
  type Message,
  type ReportHistory,
  type ReportInput,
  type ReportPart,
  type ReportSnapshot,
  reportParts,
  reportSizeLimit,
  reportZip,
  type Thread,
} from "@touri/contracts"
import { useEffect, useId, useRef, useState } from "react"
import { createTauriInvoke, type TauriInvoke, type UiApi } from "../../api/client"
import { browserSave } from "../../browserSave"
import { getDocumentLocale } from "../../documentLanguage"
import { userFacingError } from "../../errors"
import { type Locale, type TranslationKey, t } from "../../i18n"
import { Capture, sanitizeImage } from "./Capture"
import { buildOfflineReport, offlineHistory, rememberOfflineReport } from "./offline"
import "./reports.css"

const labels: Record<ReportPart, TranslationKey> = {
  versions: "Informações do aplicativo e do computador",
  doctor: "Funcionamento do aplicativo",
  logs: "Atividade recente do aplicativo",
  errors: "Erros recentes",
  states: "Atividade dos bots",
  database: "Resumo dos dados guardados",
  memory: "Uso de memória do computador pelo touri",
  runs: "Tarefas recentes",
  transcript: "Incluir a conversa selecionada",
}
const descriptions: Record<ReportPart, TranslationKey> = {
  versions: "Ajuda a identificar incompatibilidades entre a versão do touri e o computador.",
  doctor: "Mostra o resultado das verificações do funcionamento e da conexão.",
  logs: "Inclui as 500 linhas mais recentes, com dados sensíveis ocultados automaticamente.",
  errors: "Ajuda a identificar erros que se repetem.",
  states: "Mostra quais bots estão em execução e o estado dos computadores usados por eles.",
  database: "Inclui o tamanho e a quantidade de registros, sem o conteúdo.",
  memory: "Ajuda a investigar uso elevado de memória e travamentos.",
  runs: "Inclui o estado, a duração e o tipo de erro das últimas 20 tarefas.",
  transcript: "Selecione um bot e uma conversa acima para incluir esta parte.",
}
const initialInput = (errorCode?: string, errorMessage?: string): ReportInput => ({
  title: errorCode ? `Problema ${errorCode}` : "",
  happened: errorCode
    ? `O touri apresentou o erro ${errorCode}.${errorMessage ? `\n${errorMessage.slice(0, 15000)}` : ""}`
    : "",
  expected: "",
  steps: "",
  severity: "bug",
  botId: null,
  threadId: null,
  errorCode: errorCode ?? null,
  parts: reportParts.filter((part) => part !== "transcript"),
  images: [],
})
const toBase64 = (bytes: Uint8Array): string => {
  let value = ""
  for (const byte of bytes) value += String.fromCharCode(byte)
  return btoa(value)
}

export const ReportProblem = ({
  api,
  invokeCommand,
  errorCode,
  errorMessage,
  offline = false,
  locale: requestedLocale,
}: {
  api?: UiApi | undefined
  invokeCommand?: TauriInvoke | undefined
  errorCode?: string | undefined
  errorMessage?: string | undefined
  offline?: boolean
  locale?: Locale | undefined
}) => {
  const formId = useId()
  const locale = requestedLocale ?? getDocumentLocale(document.documentElement)
  const [invoke] = useState(() => invokeCommand ?? createTauriInvoke())
  const [input, setInput] = useState(() => initialInput(errorCode, errorMessage))
  const [bots, setBots] = useState<Bot[]>([])
  const [threads, setThreads] = useState<Thread[]>([])
  const [history, setHistory] = useState<ReportHistory[]>(offlineHistory)
  const [cloudAvailable, setCloudAvailable] = useState(false)
  const [snapshot, setSnapshot] = useState<ReportSnapshot | null>(null)
  const [transcriptMessages, setTranscriptMessages] = useState<Message[]>([])
  const [draft, setDraft] = useState<{ reportJson: string; logs: Record<string, string> }>({ reportJson: "", logs: {} })
  const [previewDirty, setPreviewDirty] = useState(false)
  const [localSnapshot, setLocalSnapshot] = useState(false)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState("")
  const mounted = useRef(true)
  useEffect(() => {
    setDraft({ reportJson: snapshot ? JSON.stringify(snapshot.report, null, 2) : "", logs: snapshot?.logs ?? {} })
    setPreviewDirty(false)
  }, [snapshot])
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const update = (patch: Partial<ReportInput>) => {
    setInput((current) => ({ ...current, ...patch }))
    setSnapshot(null)
    setPreviewOpen(false)
  }
  const refreshHistory = async () => {
    if (!api || offline) return
    const pending = offlineHistory()
    if (pending.length) {
      await api.request("POST /reports/history", { history: pending })
      localStorage.removeItem("touri-report-history")
    }
    const result = await api.request("GET /reports", {})
    if (!mounted.current) return
    setHistory([...result.history, ...offlineHistory()].sort((a, b) => b.date - a.date))
    setCloudAvailable(result.cloudAvailable)
    if (result.repository) setInput((current) => ({ ...current, repository: current.repository || result.repository }))
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: only refresh when the report API changes
  useEffect(() => {
    if (!api || offline) return
    void refreshHistory().catch(() => undefined)
    void api
      .request("GET /bots", {})
      .then((result) => {
        if (mounted.current) setBots(result.bots)
      })
      .catch(() => undefined)
  }, [api, offline])
  useEffect(() => {
    setThreads([])
    if (!api || !input.botId || offline) return
    let active = true
    void api
      .request("GET /bots/:id/threads", {}, { id: input.botId })
      .then((result) => {
        if (active) setThreads(result.threads)
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [api, input.botId, offline])
  const includeTranscript = input.parts.includes("transcript")
  useEffect(() => {
    setTranscriptMessages([])
    if (!api || offline || !input.threadId || !includeTranscript) return
    let active = true
    void api
      .request("GET /threads/:id/messages", { all: input.transcriptBranch === "all" }, { id: input.threadId })
      .then((result) => {
        if (active) setTranscriptMessages(result.messages)
      })
      .catch(() => {
        if (active) setNotice("Não foi possível carregar os trechos. Tente selecionar a conversa novamente.")
      })
    return () => {
      active = false
    }
  }, [api, offline, input.threadId, input.transcriptBranch, includeTranscript])
  const act = async (work: () => Promise<void>) => {
    if (busy) return
    setBusy(true)
    setNotice("")
    try {
      await work()
    } catch (error) {
      setNotice(userFacingError(error))
    } finally {
      if (mounted.current) setBusy(false)
    }
  }
  const addImages = (files: File[]) =>
    void act(async () => {
      if (input.images.length + files.length > 8) throw new Error("Anexe até 8 capturas.")
      const images = await Promise.all(files.map(sanitizeImage))
      const combined = [...input.images, ...images]
      if (combined.reduce((sum, image) => sum + (image.dataBase64.length * 3) / 4, 0) > reportSizeLimit)
        throw new Error("As capturas excedem 10 MB. Remova uma imagem.")
      update({ images: combined })
    })
  const preview = () =>
    void act(async () => {
      let next: ReportSnapshot
      const local = offline || !api
      if (api && !offline) {
        // Never silently replace a failed authenticated preview with different content.
        next = await api.request("POST /reports/preview", input)
      } else next = await buildOfflineReport(input, invoke)
      if (reportZip(next).byteLength > reportSizeLimit)
        throw new Error("O relatório excede 10 MB. Remova capturas ou a conversa.")
      setLocalSnapshot(local)
      setSnapshot(next)
      setPreviewOpen(true)
      if (local) setNotice("Relatório reduzido: o sidecar está indisponível. Veja as partes não coletadas na prévia.")
    })
  const deliver = (destination: "zip" | "github" | "cloud") =>
    void act(async () => {
      if (!snapshot || !previewOpen || previewDirty) return
      const result =
        localSnapshot || !api
          ? { id: snapshot.id, zipBase64: toBase64(reportZip(snapshot)), url: snapshot.githubUrl ?? undefined }
          : await api.request("POST /reports/:id/deliver", { destination }, { id: snapshot.id })
      if (destination === "zip") {
        if (!result.zipBase64) throw new Error("ZIP indisponível")
        const saved = await invoke("report_save_zip", { dataBase64: result.zipBase64 })
        if (saved && !saved.path) return setNotice("Salvamento cancelado.")
        if (!saved) browserSave({ name: `touri-relatorio-${snapshot.id}.zip`, base64: result.zipBase64 })
        setNotice(saved ? `Salvo em ${saved.path}` : "Download do .zip iniciado.")
        if (!localSnapshot && api)
          await api.request("POST /reports/:id/saved", { destination: "zip" }, { id: snapshot.id })
      } else if (destination === "github") {
        if (!result.url) throw new Error("Configure o repositório GitHub abaixo.")
        const opened = await invoke("open_external", { url: result.url })
        if (!opened) throw new Error("Não foi possível abrir o GitHub.")
        if (!localSnapshot && api)
          await api.request("POST /reports/:id/saved", { destination: "github" }, { id: snapshot.id })
        setNotice("GitHub aberto com o resumo. Anexe o .zip manualmente e publique a issue.")
      } else setNotice(`Relatório enviado para o touri: ${result.id}`)
      if (localSnapshot) {
        rememberOfflineReport({ id: result.id, date: Date.now(), title: String(snapshot.report.title), destination })
        setHistory(offlineHistory())
      } else await refreshHistory()
    })
  const applyEdits = () =>
    void act(async () => {
      if (!snapshot) return
      const previewEdits = { id: snapshot.id, ...draft }
      const next =
        localSnapshot || !api
          ? editReportSnapshot(snapshot, previewEdits, crypto.randomUUID(), input.repository ?? "")
          : await api.request("POST /reports/preview", { ...input, previewEdits })
      if (reportZip(next).byteLength > reportSizeLimit)
        throw new Error("O relatório excede 10 MB. Reduza o texto da prévia.")
      setSnapshot(next)
      setNotice("Edição aplicada. Revise o conteúdo antes de enviar.")
    })
  return (
    <div className="report-problem">
      <form
        onSubmit={(event) => {
          event.preventDefault()
          preview()
        }}
        onPaste={(event) => {
          const files = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith("image/"))
          if (files.length) {
            event.preventDefault()
            addImages(files)
          }
        }}
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault()
          if (!busy) addImages(Array.from(event.dataTransfer.files))
        }}
      >
        <fieldset disabled={busy}>
          <legend>Conte o que aconteceu</legend>
          {(
            [
              ["title", "Título"],
              ["happened", "O que aconteceu?"],
              ["expected", "O que você esperava?"],
              ["steps", "Passos para reproduzir (opcional)"],
            ] as const
          ).map(([key, label]) => (
            <label key={key} htmlFor={`${formId}-${key}`}>
              {label}
              {key === "title" ? (
                <input
                  id={`${formId}-${key}`}
                  required
                  maxLength={16000}
                  value={input[key]}
                  onChange={(event) => update({ [key]: event.target.value })}
                />
              ) : (
                <textarea
                  id={`${formId}-${key}`}
                  required={key !== "steps"}
                  maxLength={16000}
                  rows={3}
                  value={input[key]}
                  onChange={(event) => update({ [key]: event.target.value })}
                />
              )}
            </label>
          ))}
          <label>
            Severidade
            <select
              value={input.severity}
              onChange={(event) => update({ severity: event.target.value as ReportInput["severity"] })}
            >
              <option value="crash">Travou</option>
              <option value="bug">Algo errado</option>
              <option value="suggestion">Sugestão</option>
            </select>
          </label>
          <div className="report-related">
            <label>
              Bot relacionado (opcional)
              <select
                value={input.botId ?? ""}
                onChange={(event) =>
                  update({
                    botId: event.target.value || null,
                    threadId: null,
                    transcriptMessageIds: undefined,
                    parts: input.parts.filter((part) => part !== "transcript"),
                  })
                }
              >
                <option value="">Nenhum</option>
                {bots.map((bot) => (
                  <option key={bot.id} value={bot.id}>
                    {bot.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Conversa relacionada (opcional)
              <select
                disabled={!input.botId}
                value={input.threadId ?? ""}
                onChange={(event) =>
                  update({
                    threadId: event.target.value || null,
                    transcriptMessageIds: undefined,
                    parts: input.parts.filter((part) => part !== "transcript"),
                  })
                }
              >
                <option value="">Nenhuma</option>
                {threads.map((thread) => (
                  <option key={thread.id} value={thread.id}>
                    {thread.title}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {input.errorCode && (
            <p>
              Código do erro: <code>{input.errorCode}</code>
            </p>
          )}
          <fieldset className="report-checks">
            <legend>{t("Diagnóstico incluído", {}, locale)}</legend>
            {reportParts.map((part) => (
              <div className="report-check-item" key={part}>
                <label>
                  <input
                    type="checkbox"
                    aria-describedby={`${formId}-${part}-description`}
                    checked={input.parts.includes(part)}
                    disabled={part === "transcript" && !input.threadId}
                    onChange={(event) =>
                      update({
                        parts: event.target.checked
                          ? [...input.parts, part]
                          : input.parts.filter((item) => item !== part),
                      })
                    }
                  />
                  <span>{t(labels[part], {}, locale)}</span>
                </label>
                <p id={`${formId}-${part}-description`} className="report-check-description">
                  {t(descriptions[part], {}, locale)}
                </p>
              </div>
            ))}
            <p className="warning-callout">
              A conversa pode conter dados pessoais e informações confidenciais. Inclua somente se necessário e revise o
              conteúdo. O texto das mensagens continua legível após a ocultação automática de credenciais e caminhos.
            </p>
            {includeTranscript && (
              <div>
                <label>
                  Ramos incluídos
                  <select
                    value={input.transcriptBranch ?? "active"}
                    onChange={(event) =>
                      update({
                        transcriptBranch: event.target.value as "active" | "all",
                        transcriptMessageIds: undefined,
                      })
                    }
                  >
                    <option value="active">Somente o ramo ativo</option>
                    <option value="all">Todos os ramos, inclusive os inativos</option>
                  </select>
                </label>
                <p>
                  {input.transcriptBranch === "all"
                    ? "Todos os ramos desta conversa serão incluídos, inclusive os inativos."
                    : "Somente as mensagens do ramo ativo serão incluídas."}{" "}
                  Desmarque os trechos que não deseja enviar.
                </p>
                {transcriptMessages.map((message, index) => (
                  <label key={message.id}>
                    <input
                      type="checkbox"
                      aria-label={`Incluir mensagem ${index + 1}`}
                      checked={!input.transcriptMessageIds || input.transcriptMessageIds.includes(message.id)}
                      onChange={(event) => {
                        const ids = input.transcriptMessageIds ?? transcriptMessages.map((item) => item.id)
                        update({
                          transcriptMessageIds: event.target.checked
                            ? [...ids, message.id]
                            : ids.filter((id) => id !== message.id),
                        })
                      }}
                    />
                    <span>
                      {message.role}: {message.text.slice(0, 200) || "Mensagem sem texto"}
                    </span>
                  </label>
                ))}
              </div>
            )}
          </fieldset>
          <label>
            Anexar capturas (opcional)
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              multiple
              onChange={(event) => {
                addImages(Array.from(event.target.files ?? []))
                event.target.value = ""
              }}
            />
          </label>
          <p>
            Você também pode colar ou arrastar imagens. A ocultação automática procura credenciais, caminhos e alguns
            dados pessoais; outras informações confidenciais podem continuar legíveis. Edite a prévia e oculte dados
            sensíveis nas imagens antes de continuar.
          </p>
          <div className="report-images">
            {input.images.map((image, index) => (
              <div key={image.id ?? image.dataBase64}>
                <Capture
                  image={image}
                  onChange={(next) =>
                    update({
                      images: input.images.map((value, current) =>
                        current === index ? { ...next, ...(image.id ? { id: image.id } : {}) } : value,
                      ),
                    })
                  }
                />
                <button
                  className="button button-quiet"
                  type="button"
                  onClick={() => update({ images: input.images.filter((_, current) => current !== index) })}
                >
                  Remover captura {index + 1}
                </button>
              </div>
            ))}
          </div>
          <label>
            Repositório GitHub (configuração opcional)
            <input
              type="url"
              placeholder="https://github.com/organização/repositório"
              value={input.repository ?? ""}
              onChange={(event) => update({ repository: event.target.value })}
            />
          </label>
          <button className="button button-brand" type="submit">
            {busy ? "Preparando…" : "Ver conteúdo"}
          </button>
        </fieldset>
      </form>
      {snapshot && (
        <section aria-label="Conteúdo exato do relatório" className="report-preview">
          <h4>Ver conteúdo</h4>
          <p>
            Este é o conteúdo exato do .zip e do envio para o touri. O GitHub e a área de transferência recebem somente
            o resumo.
          </p>
          <details open={previewOpen} onToggle={(event) => setPreviewOpen(event.currentTarget.open)}>
            <summary>Prévia completa</summary>
            <h5>report.json</h5>
            <pre>{JSON.stringify(snapshot.report, null, 2)}</pre>
            <label>
              Editar report.json
              <textarea
                rows={12}
                value={draft.reportJson}
                disabled={busy}
                onChange={(event) => {
                  setDraft((current) => ({ ...current, reportJson: event.target.value }))
                  setPreviewDirty(true)
                }}
              />
            </label>
            {Object.entries(snapshot.logs).map(([name, text]) => (
              <div key={name}>
                <h5>logs/{name}</h5>
                <pre>{text}</pre>
                <label>
                  Editar logs/{name}
                  <textarea
                    rows={6}
                    value={draft.logs[name] ?? ""}
                    disabled={busy}
                    onChange={(event) => {
                      setDraft((current) => ({ ...current, logs: { ...current.logs, [name]: event.target.value } }))
                      setPreviewDirty(true)
                    }}
                  />
                </label>
              </div>
            ))}
            {snapshot.images.map((image) => (
              <figure key={image.name}>
                <img src={`data:${image.mime};base64,${image.dataBase64}`} alt={image.name} />
                <figcaption>images/{image.name}</figcaption>
              </figure>
            ))}
            <h5>Resumo</h5>
            <pre>{snapshot.summary}</pre>
            <button type="button" className="button button-quiet" disabled={busy || !previewDirty} onClick={applyEdits}>
              Aplicar edição e revisar
            </button>
            {previewDirty && (
              <p>Há alterações ainda não aplicadas. Aplique a edição para gerar e revisar a nova prévia.</p>
            )}
          </details>
          <div className="report-actions">
            <button
              className="button button-brand"
              disabled={busy || !previewOpen || previewDirty}
              type="button"
              onClick={() => deliver("zip")}
            >
              Salvar .zip
            </button>
            <button
              className="button button-quiet"
              disabled={busy || !previewOpen || previewDirty}
              type="button"
              onClick={() =>
                void act(async () => {
                  await navigator.clipboard.writeText(snapshot.summary)
                  setNotice("Resumo copiado.")
                })
              }
            >
              Copiar resumo
            </button>
            <button
              className="button button-quiet"
              disabled={busy || !previewOpen || previewDirty || !snapshot.githubUrl}
              type="button"
              onClick={() => deliver("github")}
            >
              Abrir issue no GitHub
            </button>
            {cloudAvailable && !localSnapshot && (
              <button
                className="button button-brand"
                disabled={busy || !previewOpen || previewDirty}
                type="button"
                onClick={() => deliver("cloud")}
              >
                Enviar para o touri
              </button>
            )}
            {(!cloudAvailable || localSnapshot) && (
              <p>Envio para a nuvem indisponível: sua nuvem não anunciou suporte a relatórios ou não está conectada.</p>
            )}
          </div>
        </section>
      )}
      {notice && (
        <p role="status" className="settings-inline-note">
          {notice}
        </p>
      )}
      <section aria-label="Relatórios enviados">
        <h4>Relatórios enviados</h4>
        <p>
          Histórico local de exportações, aberturas no GitHub e envios. Abrir o GitHub não confirma a publicação da
          issue.
        </p>
        {history.length ? (
          <div className="report-history">
            <table>
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Data</th>
                  <th>Título</th>
                  <th>Destino</th>
                </tr>
              </thead>
              <tbody>
                {history.map((item) => (
                  <tr key={`${item.id}-${item.destination}`}>
                    <td data-label="ID">{item.id}</td>
                    <td data-label="Data">{new Date(item.date).toLocaleString("pt-BR")}</td>
                    <td data-label="Título">{item.title}</td>
                    <td data-label="Destino">{item.destination}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p>Nenhum relatório ainda.</p>
        )}
      </section>
    </div>
  )
}
