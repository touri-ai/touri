import type { Bot, GroupAction, Id, Project, Run } from "@touri/contracts"
import { getApiModelProviderId } from "@touri/contracts"
import { type ComponentProps, type RefObject, useEffect, useId, useLayoutEffect, useRef, useState } from "react"
import type { UiApi } from "../api/client"
import { attachmentAccept, maxAttachmentBytes } from "../attachmentFiles"
import { composerKeyAction } from "../composerKeys"
import { userFacingError } from "../errors"
import { useCloudAccount } from "../features/cloud/useCloudAccount"
import { useIsServerMode } from "../features/server/serverMode"
import { dropRejectionMessage, type FileDrop, listenForFileDrops } from "../fileDrops"
import { type Locale, t } from "../i18n"
import { useComposerMachineIntent } from "../machineIntents"
import { getDraftWithTranscript } from "../speechRecognition"
import { useProviderLogin } from "../useProviderLogin"
import type { ThreadCreationStatus } from "../workspaceState"
import { useMascotComposer } from "./AvatarRuntime"
import { BotAvatar } from "./BotAvatar"
import { ComposerNotice } from "./ComposerNotice"
import { ComposerProjectChip } from "./ComposerProjectChip"
import { ErrorText } from "./ErrorDetails"
import { ProviderLoginFlow } from "./ProviderLoginFlow"
import { getBotModelName, getBotProviderName } from "./ProviderMark"
import { useReveal } from "./Reveal"
import { VoiceInput } from "./VoiceInput"
import "./Composer.css"

type AttachedFile = { key: string; name: string; id: Id | null; status: "loading" | "ready" | "failed" }
type ComposerProps = {
  locale?: Locale
  threadCreation?: Exclude<ThreadCreationStatus, "draft"> | undefined
  onRetryCreateThread?: (() => void) | undefined
  mentionBots?: Bot[]
  groupName?: string | undefined
  bot: Bot | null
  threadId: Id
  parentId: Id | null
  api: UiApi
  draft: string
  onDraft: (draft: string) => void
  inputRef: RefObject<HTMLTextAreaElement | null>
  attachmentButtonRef?: RefObject<HTMLButtonElement | null> | undefined
  activeRun: Run | null
  botActive?: boolean
  projects?: Project[] | undefined
  onOpenModel?: (() => void) | undefined
  onSelectProject?: ((projectId: Id | null) => Promise<void>) | undefined
  onAddProject?: (() => void) | undefined
  queuedCount: number
  onSend: (text: string, parentId?: Id | null, attachmentIds?: Array<Id>, groupAction?: GroupAction) => Promise<void>
  onCancel: (runId: Id) => Promise<void>
  onOpenPermissions?: (() => void) | undefined
  onOpenProviderLogin?: (() => void) | undefined
  notice?: Omit<ComponentProps<typeof ComposerNotice>, "api" | "active" | "loginFlowShown">
}

/** Focusing a draft can invite the mascot to listen; only the runtime can signal work. */
const useComposerAttention = (botId: Id | undefined, threadId: Id, focused: boolean) => {
  const composer = useMascotComposer()
  useEffect(() => {
    if (!botId || !composer) return
    composer({ botId, threadId, focused, typing: false })
    return () => composer({ botId, threadId, focused: false, typing: false })
  }, [botId, threadId, focused, composer])
}

const Icon = ({ kind }: { kind: "attach" | "send" | "stop" | "queue" | "file" }) => (
  <svg
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {kind === "attach" && <path d="m21 11-8.5 8.5a5 5 0 0 1-7-7L14 4a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 0 1-3-3L15 7" />}
    {kind === "send" && <path d="M12 19V5M5 12l7-7 7 7" />}
    {kind === "stop" && <rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor" stroke="none" />}
    {kind === "queue" && <path d="M4 6h12M4 12h8M4 18h8M18 12v8M14 16h8" />}
    {kind === "file" && <path d="M14 3H6v18h12V7zM14 3v5h4M9 12h6M9 16h4" />}
  </svg>
)

export const Composer = ({
  locale = "pt-BR",
  threadCreation,
  onRetryCreateThread,
  mentionBots = [],
  groupName,
  bot,
  threadId,
  parentId,
  api,
  draft,
  onDraft,
  inputRef,
  attachmentButtonRef,
  activeRun,
  botActive = false,
  projects = [],
  onOpenModel,
  onSelectProject,
  onAddProject,
  queuedCount,
  onSend,
  onCancel,
  notice,
}: ComposerProps) => {
  const serverMode = useIsServerMode()
  const apiModel = bot?.provider === "opencode" && !!getApiModelProviderId(bot.model)
  const login = useProviderLogin(
    api,
    bot?.id ?? "",
    bot?.provider ?? "codex",
    !!bot && bot.machine !== "cloud" && !apiModel,
    false,
  )
  const { account: cloudAccount } = useCloudAccount(api, bot?.machine === "cloud")
  const cloudUnavailable = bot?.machine === "cloud" && cloudAccount?.runtimeAvailable !== true
  const [focused, setFocused] = useState(false)
  const [caret, setCaret] = useState(draft.length)
  const [mentionIndex, setMentionIndex] = useState(0)
  const [mentionClosed, setMentionClosed] = useState(false)
  const mentionListId = useId()
  const mention = draft.slice(0, caret).match(/(?:^|\s)@([^@\n]*)$/u)
  const suggestions =
    !mentionClosed && focused && mention
      ? mentionBots
          .filter((b) => b.name.toLocaleLowerCase().startsWith((mention[1] ?? "").toLocaleLowerCase()))
          .slice(0, 8)
      : []
  const activeMention = suggestions[mentionIndex] ?? suggestions[0]
  const insertMention = (bot: Bot) => {
    const start = caret - (mention?.[1]?.length ?? 0) - 1
    const token = `@${/\s/.test(bot.name) ? JSON.stringify(bot.name) : bot.name} `
    onDraft(draft.slice(0, start) + token + draft.slice(caret))
    setMentionClosed(true)
    requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.setSelectionRange(start + token.length, start + token.length)
    })
  }
  const [files, setFiles] = useState<Array<AttachedFile>>([])
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [dictating, setDictating] = useState(false)
  const [stoppingRunId, setStoppingRunId] = useState<string | null>(null)
  const [picking, setPicking] = useState(false)
  const [dragging, setDragging] = useState(false)
  const sendingRef = useRef(false)
  const pendingSend = useRef<{
    api: UiApi
    botId: string | undefined
    provider: Bot["provider"] | undefined
    threadId: Id
    parentId: Id | null
    text: string
    files: Array<AttachedFile>
    groupAction: GroupAction | undefined
  } | null>(null)
  const stoppingRef = useRef<string | null>(null)
  const stopping = Boolean(activeRun && activeRun.id === stoppingRunId)
  const alive = useRef(true)
  const draftRef = useRef(draft)
  draftRef.current = draft
  const fileInput = useRef<HTMLInputElement>(null)
  const island = useReveal<HTMLFormElement>()
  const helpId = useId()
  const machineIntent = useComposerMachineIntent(api, bot)
  useComposerAttention(bot?.id, threadId, focused)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  // Measure at intrinsic height, then restore the current height so CSS can interpolate to the target.
  // biome-ignore lint/correctness/useExhaustiveDependencies: draft changes can change wrapping without changing the input ref
  useLayoutEffect(() => {
    const input = inputRef.current
    if (!input) return
    // Native sizing avoids forcing transcript layout several times on every edit.
    // Keep the measured fallback for webviews that do not support it yet.
    if (typeof CSS !== "undefined" && CSS.supports?.("field-sizing", "content")) return
    const measure = () => {
      const current = input.getBoundingClientRect().height
      input.style.transition = "none"
      input.style.height = "0px"
      const target = Math.max(38, Math.min(input.scrollHeight, 190))
      input.style.height = `${current || target}px`
      input.getBoundingClientRect()
      input.style.transition = ""
      input.style.height = `${target}px`
      input.style.overflowY = input.scrollHeight > 190 ? "auto" : "hidden"
    }
    measure()
    let width = input.clientWidth
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            if (width === input.clientWidth) return
            width = input.clientWidth
            measure()
          })
    observer?.observe(input)
    return () => observer?.disconnect()
  }, [draft, inputRef])

  const attachGranted = async ({ granted, rejected }: FileDrop) => {
    setDragging(false)
    setError(rejected.length ? rejected.map(dropRejectionMessage).join(" ") : null)
    const pending = granted.map((grant) => ({ ...grant, key: crypto.randomUUID() }))
    setFiles((current) => [
      ...current,
      ...pending.map(({ key, name }) => ({ key, name, id: null, status: "loading" as const })),
    ])
    for (const file of pending) {
      try {
        const { attachment } = await api.request("POST /attachments", { grantId: file.id })
        if (!alive.current) return
        setFiles((current) =>
          current.map((item) => (item.key === file.key ? { ...item, id: attachment.id, status: "ready" } : item)),
        )
      } catch (failure) {
        if (!alive.current) return
        setFiles((current) => current.map((item) => (item.key === file.key ? { ...item, status: "failed" } : item)))
        setError(t("Could not attach file", { name: file.name, reason: userFacingError(failure) }))
      }
    }
  }
  const attachGrantedRef = useRef(attachGranted)
  attachGrantedRef.current = attachGranted
  useEffect(() => {
    if (serverMode || !("__TAURI_INTERNALS__" in window)) return
    return listenForFileDrops({
      onActive: setDragging,
      onDrop: (drop) => void attachGrantedRef.current(drop),
    })
  }, [serverMode])
  const addBrowserFiles = async (selected: FileList | null) => {
    if (!selected?.length) return
    const upload = api.uploadAttachment
    if (!api.isMock && !upload) return
    setError(null)
    setPicking(true)
    for (const file of Array.from(selected)) {
      const key = crypto.randomUUID()
      setFiles((current) => [...current, { key, name: file.name, id: null, status: "loading" }])
      try {
        if (file.size > maxAttachmentBytes) throw new Error(t("Escolha um arquivo de até 15 MB"))
        const attachment = api.isMock
          ? (await api.request("POST /attachments", { path: `/mock/${file.name}` })).attachment
          : await upload?.(file)
        if (!alive.current || !attachment) return
        setFiles((current) =>
          current.map((item) => (item.key === key ? { ...item, id: attachment.id, status: "ready" } : item)),
        )
      } catch (failure) {
        if (!alive.current) return
        setFiles((current) => current.map((item) => (item.key === key ? { ...item, status: "failed" } : item)))
        setError(t("Could not attach file", { name: file.name, reason: userFacingError(failure) }))
      }
    }
    if (alive.current) setPicking(false)
  }
  const chooseFiles = () => fileInput.current?.click()
  const uploading = files.some((file) => file.status === "loading")
  const blocked =
    dictating ||
    Boolean(threadCreation) ||
    cloudUnavailable ||
    sending ||
    uploading ||
    files.some((file) => file.status === "failed") ||
    (!draft.trim() && files.length === 0)
  const submit = async (groupAction?: GroupAction) => {
    if (dictating) return
    const summary = groupAction === "summarize"
    if (sendingRef.current || (summary ? sending || Boolean(activeRun) || Boolean(threadCreation) : blocked)) return
    if (login.blocked) {
      pendingSend.current = {
        api,
        botId: bot?.id,
        provider: bot?.provider,
        threadId,
        parentId,
        text: draft,
        files,
        groupAction,
      }
      if (login.flow?.state !== "waiting" && !login.busy) void login.recheck()
      return
    }
    pendingSend.current = null
    sendingRef.current = true
    setSending(true)
    setError(null)
    const text = draft
    const sentFiles = summary ? [] : files
    const prompt = summary
      ? t("Resuma os resultados confirmados do último turno, com a autoria de cada membro.")
      : text.trim() || t("Review attached files")
    const attachmentIds = sentFiles.flatMap((file) => (file.id ? [file.id] : []))
    try {
      await (groupAction
        ? onSend(prompt, parentId, attachmentIds, groupAction)
        : onSend(prompt, parentId, attachmentIds))
      if (!alive.current) return
      if (!summary && draftRef.current === text) onDraft("")
      setFiles((current) => current.filter((file) => !sentFiles.some((sent) => sent.key === file.key)))
      inputRef.current?.focus()
    } catch (failure) {
      if (alive.current) setError(t("Could not send message", { reason: userFacingError(failure) }))
    } finally {
      sendingRef.current = false
      if (alive.current) setSending(false)
    }
  }
  // Resume only the exact draft the user tried to send, in the same conversation.
  const submitRef = useRef(submit)
  submitRef.current = submit
  useEffect(() => {
    const pending = pendingSend.current
    if (!pending) return
    if (
      pending.api !== api ||
      pending.botId !== bot?.id ||
      pending.provider !== bot?.provider ||
      pending.threadId !== threadId ||
      pending.parentId !== parentId ||
      pending.text !== draft ||
      pending.files !== files
    ) {
      pendingSend.current = null
      return
    }
    if (!login.blocked) {
      pendingSend.current = null
      void submitRef.current(pending.groupAction)
    }
  }, [api, bot?.id, bot?.provider, threadId, parentId, draft, files, login.blocked])
  const stop = async () => {
    if (!activeRun || stoppingRef.current === activeRun.id) return
    const runId = activeRun.id
    stoppingRef.current = runId
    setStoppingRunId(runId)
    setError(null)
    try {
      await onCancel(runId)
    } catch (failure) {
      if (stoppingRef.current !== runId) return
      stoppingRef.current = null
      if (alive.current) {
        setStoppingRunId(null)
        setError(t("Could not stop reply", { reason: userFacingError(failure) }))
      }
    }
  }
  const hasContent = Boolean(draft.trim() || files.length)
  const showStop = Boolean(activeRun && !hasContent && !sending)
  const composer = (
    <form
      ref={island}
      className="composer composer-island"
      aria-label={t("Compose message")}
      aria-busy={sending || uploading}
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
      data-dragging={dragging || undefined}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return
        event.preventDefault()
        setDragging(true)
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false)
      }}
      onDrop={(event) => {
        event.preventDefault()
        setDragging(false)
        if (serverMode || !("__TAURI_INTERNALS__" in window)) addBrowserFiles(event.dataTransfer.files)
      }}
    >
      {dragging && (
        <div className="composer-drop-hint" role="status">
          {t("Drop to attach")}
        </div>
      )}
      {files.length > 0 && (
        <ul className="attachment-strip" aria-label={t("Attached files")}>
          {files.map((file) => (
            <li className="attachment-chip" data-status={file.status} key={file.key}>
              <Icon kind="file" />
              <span className="attachment-name" title={file.name}>
                {file.name}
              </span>
              <span className="attachment-state">
                {file.status === "loading" ? t("Attaching…") : file.status === "failed" ? t("Falhou") : ""}
              </span>
              <button
                type="button"
                aria-label={t("Remove attached file", { name: file.name })}
                onClick={() => setFiles((current) => current.filter((item) => item.key !== file.key))}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      {threadCreation === "pending" && <p role="status">{t("Criando conversa…")}</p>}
      {threadCreation === "failed" && (
        <div role="alert">
          <p>{t("Não foi possível criar a conversa. Seu rascunho foi mantido.")}</p>
          <button type="button" onClick={onRetryCreateThread}>
            {t("Tentar criar conversa novamente")}
          </button>
        </div>
      )}
      {cloudUnavailable && <p role="status">{t("Cloud execution coming soon")}</p>}
      {login.blocked && (
        <aside className="composer-login-card" aria-label={t("Authentication required")}>
          <p>{t("Sua mensagem fica como rascunho até o login estar pronto.")}</p>
          <ProviderLoginFlow login={login} resumeMessage />
        </aside>
      )}
      {groupName && (
        <fieldset className="group-actions" aria-label={t("Ações do grupo")}>
          <button
            type="button"
            className="button button-quiet"
            disabled={blocked}
            onClick={() => void submit("ask_all")}
          >
            {t("Perguntar a todos")}
          </button>
          <button
            type="button"
            className="button button-quiet"
            disabled={sending || Boolean(activeRun) || Boolean(threadCreation)}
            onClick={() => void submit("summarize")}
          >
            {t("Pedir resumo do time")}
          </button>
        </fieldset>
      )}
      <textarea
        disabled={cloudUnavailable}
        ref={inputRef}
        value={draft}
        rows={1}
        aria-label={t("Message to bot", { name: groupName ?? bot?.name ?? "touri" })}
        placeholder={
          groupName ? t("Message to group", { name: groupName }) : t("Message to bot", { name: bot?.name ?? "touri" })
        }
        aria-describedby={helpId}
        onFocus={() => {
          setFocused(true)
          machineIntent("composer-focus")
        }}
        onBlur={() => setFocused(false)}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
        aria-controls={suggestions.length ? mentionListId : undefined}
        aria-autocomplete={groupName ? "list" : undefined}
        aria-activedescendant={activeMention ? `${mentionListId}-${activeMention.id}` : undefined}
        onChange={(event) => {
          setCaret(event.target.selectionStart)
          setMentionIndex(0)
          setMentionClosed(false)
          onDraft(event.target.value)
          machineIntent("composer-typing")
        }}
        onPaste={(event) => {
          if (event.clipboardData.files.length) {
            event.preventDefault()
            addBrowserFiles(event.clipboardData.files)
          }
        }}
        onKeyDown={(event) => {
          if (
            suggestions.length &&
            ["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"].includes(event.key) &&
            !event.nativeEvent.isComposing
          ) {
            event.preventDefault()
            if (event.key === "Escape") setMentionClosed(true)
            else if (event.key === "ArrowDown") setMentionIndex((i) => (i + 1) % suggestions.length)
            else if (event.key === "ArrowUp") setMentionIndex((i) => (i + suggestions.length - 1) % suggestions.length)
            else {
              if (activeMention) insertMention(activeMention)
            }
            return
          }
          if (
            composerKeyAction({
              key: event.key,
              shiftKey: event.shiftKey,
              metaKey: event.metaKey,
              ctrlKey: event.ctrlKey,
              altKey: event.altKey,
              isComposing: event.nativeEvent.isComposing,
              keyCode: event.keyCode,
            }) !== "send"
          )
            return
          event.preventDefault()
          void submit()
        }}
      />
      {suggestions.length > 0 && (
        <div className="group-mentions" id={mentionListId} role="listbox" aria-label={t("Mention member")}>
          {suggestions.map((bot) => (
            <button
              type="button"
              role="option"
              id={`${mentionListId}-${bot.id}`}
              aria-label={`@${bot.name}`}
              tabIndex={-1}
              aria-selected={bot.id === activeMention?.id}
              key={bot.id}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => insertMention(bot)}
            >
              <BotAvatar bot={bot} size={22} />@{bot.name}
            </button>
          ))}
        </div>
      )}
      <span id={helpId} className="visually-hidden">
        {t("Composer keyboard help")}
      </span>
      <div className="composer-footer">
        <div className="composer-tools-left">
          <input
            ref={fileInput}
            type="file"
            accept={attachmentAccept}
            multiple
            tabIndex={-1}
            className="visually-hidden"
            aria-label={t("Anexar arquivos")}
            onChange={(event) => {
              addBrowserFiles(event.target.files)
              event.target.value = ""
            }}
          />
          <button
            type="button"
            ref={attachmentButtonRef}
            className="composer-icon"
            aria-label={t("Anexar arquivo")}
            title={t("Texto, Markdown, JSON, CSV, PDF e imagens · até 15 MB por arquivo.")}
            disabled={picking || cloudUnavailable}
            onClick={() => void chooseFiles()}
          >
            <Icon kind="attach" />
          </button>
          {bot && bot.machine !== "cloud" && (
            <>
              {onOpenModel && (
                <button
                  type="button"
                  className="composer-model"
                  aria-label={t("Choose model with selection", {
                    selection: `${getBotProviderName(bot)} · ${getBotModelName(bot)}`,
                  })}
                  title={t("Bot model sentence", {
                    provider: getBotProviderName(bot),
                    model: getBotModelName(bot),
                  })}
                  onClick={onOpenModel}
                >
                  <span className="composer-model-name">
                    {getBotProviderName(bot)} · {getBotModelName(bot)}
                  </span>
                  <span aria-hidden="true">⌄</span>
                </button>
              )}
              {onSelectProject && (
                <ComposerProjectChip
                  key={bot.id}
                  bot={bot}
                  projects={projects}
                  active={botActive || Boolean(activeRun)}
                  onSelect={onSelectProject}
                  onAdd={onAddProject}
                />
              )}
            </>
          )}
        </div>
        <div className="composer-actions">
          <VoiceInput
            contextKey={`${bot?.id ?? "group"}:${threadId}`}
            disabled={cloudUnavailable || sending || Boolean(threadCreation)}
            locale={locale}
            onActiveChange={setDictating}
            onTranscript={(text) => onDraft(getDraftWithTranscript(draftRef.current, text))}
          />
          {activeRun && !showStop && (
            <button
              type="button"
              className={stopping ? "composer-stop" : "composer-icon"}
              aria-label={stopping ? t("Stopping reply…") : t("Stop reply button")}
              title={t("Stop reply")}
              disabled={stopping}
              onClick={() => void stop()}
            >
              <Icon kind="stop" />
              {stopping && t("Stopping reply…")}
            </button>
          )}
          {showStop ? (
            <button type="button" className="composer-stop" onClick={() => void stop()} disabled={stopping}>
              <Icon kind="stop" />
              {stopping ? t("Stopping reply…") : t("Stop reply button")}
            </button>
          ) : (
            <button
              type="submit"
              className="composer-send"
              aria-label={sending ? t("Sending message…") : activeRun ? t("Queue message") : t("Enviar")}
              title={activeRun ? t("Queue message") : t("Send message button")}
              disabled={blocked}
            >
              <Icon kind={activeRun ? "queue" : "send"} />
            </button>
          )}
        </div>
      </div>
      <span
        className="composer-status"
        role="status"
        hidden={!uploading && !sending && queuedCount === 0 && activeRun?.status !== "queued"}
      >
        {uploading
          ? t("Attaching files…")
          : sending
            ? t("Sending message…")
            : queuedCount > 0
              ? t("Queued messages waiting", { count: queuedCount })
              : activeRun?.status === "queued"
                ? t("Queued waiting for turn")
                : ""}
      </span>
      {error && (
        <div className="composer-error" role="alert">
          <ErrorText text={error} />
          <button type="button" aria-label={t("Close composer notice")} onClick={() => setError(null)}>
            ×
          </button>
        </div>
      )}
    </form>
  )
  return (
    <>
      {notice && <ComposerNotice {...notice} api={api} active={Boolean(activeRun)} loginFlowShown={login.blocked} />}
      {composer}
    </>
  )
}
