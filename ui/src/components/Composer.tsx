import type { Bot, Id, Run } from "@touri/contracts"
import { type ComponentProps, type RefObject, useEffect, useId, useLayoutEffect, useRef, useState } from "react"
import type { UiApi } from "../api/client"
import { composerKeyAction } from "../composerKeys"
import { userFacingError } from "../errors"
import { useCloudAccount } from "../features/cloud/useCloudAccount"
import { dropRejectionMessage, type FileDrop, listenForFileDrops } from "../fileDrops"
import { t } from "../i18n"
import { useComposerMachineIntent } from "../machineIntents"
import { useProviderLogin } from "../useProviderLogin"
import { useMascotComposer } from "./AvatarRuntime"
import { BotAvatar } from "./BotAvatar"
import { ComposerNotice } from "./ComposerNotice"
import { ErrorText } from "./ErrorDetails"
import { ProviderLoginFlow } from "./ProviderLoginFlow"
import { useReveal } from "./Reveal"
import "./Composer.css"

type AttachedFile = { key: string; name: string; id: Id | null; status: "loading" | "ready" | "failed" }
type ComposerProps = {
  mentionBots?: Bot[]
  groupName?: string | undefined
  bot: Bot | null
  threadId: Id
  parentId: Id | null
  api: UiApi
  draft: string
  onDraft: (draft: string) => void
  inputRef: RefObject<HTMLTextAreaElement | null>
  activeRun: Run | null
  queuedCount: number
  onSend: (text: string, parentId?: Id | null, attachmentIds?: Array<Id>) => Promise<void>
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
  mentionBots = [],
  groupName,
  bot,
  threadId,
  parentId,
  api,
  draft,
  onDraft,
  inputRef,
  activeRun,
  queuedCount,
  onSend,
  onCancel,
  onOpenPermissions,
  onOpenProviderLogin,
  notice,
}: ComposerProps) => {
  const login = useProviderLogin(api, bot?.id ?? "", bot?.provider ?? "codex", !!bot && bot.machine !== "cloud")
  const { account: cloudAccount } = useCloudAccount(api, bot?.machine === "cloud")
  const cloudUnavailable = bot?.machine === "cloud" && cloudAccount?.runtimeAvailable !== true
  const [focused, setFocused] = useState(false)
  const [caret, setCaret] = useState(draft.length)
  const [mentionIndex, setMentionIndex] = useState(0)
  const [mentionClosed, setMentionClosed] = useState(false)
  const mention = draft.slice(0, caret).match(/(?:^|\s)@([^@\n]*)$/u)
  const suggestions =
    !mentionClosed && focused && mention
      ? mentionBots
          .filter((b) => b.name.toLocaleLowerCase().startsWith((mention[1] ?? "").toLocaleLowerCase()))
          .slice(0, 8)
      : []
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
  const [stopping, setStopping] = useState(false)
  const [picking, setPicking] = useState(false)
  const [dragging, setDragging] = useState(false)
  const sendingRef = useRef(false)
  const stoppingRef = useRef(false)
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

  const registerPaths = async (paths: Array<string>) => {
    setError(null)
    const pending = paths.map((path) => ({
      path,
      key: crypto.randomUUID(),
      name: path.split(/[\\/]/).at(-1) || t("Attachment fallback name"),
    }))
    setFiles((current) => [
      ...current,
      ...pending.map(({ key, name }) => ({ key, name, id: null, status: "loading" as const })),
    ])
    for (const file of pending) {
      try {
        const { attachment } = await api.request("POST /attachments", { path: file.path })
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
  const attachGranted = async ({ granted, rejected }: FileDrop) => {
    setDragging(false)
    setError(rejected[0] ? dropRejectionMessage(rejected[0]) : null)
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
    if (!("__TAURI_INTERNALS__" in window)) return
    return listenForFileDrops({
      onActive: setDragging,
      onDrop: (drop) => void attachGrantedRef.current(drop),
    })
  }, [])
  const addBrowserFiles = async (selected: FileList | null) => {
    if (!selected?.length) return
    if (api.isMock) return registerPaths(Array.from(selected, (file) => `/mock/${file.name}`))
    if (!api.uploadAttachment) return
    setError(null)
    setPicking(true)
    for (const file of Array.from(selected)) {
      const key = crypto.randomUUID()
      setFiles((current) => [...current, { key, name: file.name, id: null, status: "loading" }])
      try {
        const attachment = await api.uploadAttachment(file)
        if (!alive.current) return
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
    login.blocked ||
    cloudUnavailable ||
    sending ||
    uploading ||
    files.some((file) => file.status === "failed") ||
    (!draft.trim() && files.length === 0)
  const submit = async () => {
    if (blocked || sendingRef.current) return
    sendingRef.current = true
    setSending(true)
    setError(null)
    const text = draft
    const sentFiles = files
    try {
      await onSend(
        text.trim() ? text : t("Review attached files"),
        parentId,
        sentFiles.flatMap((file) => (file.id ? [file.id] : [])),
      )
      if (!alive.current) return
      if (draftRef.current === text) onDraft("")
      setFiles((current) => current.filter((file) => !sentFiles.some((sent) => sent.key === file.key)))
      inputRef.current?.focus()
    } catch (failure) {
      if (alive.current) setError(t("Could not send message", { reason: userFacingError(failure) }))
    } finally {
      sendingRef.current = false
      if (alive.current) setSending(false)
    }
  }
  const stop = async () => {
    if (!activeRun || stoppingRef.current) return
    stoppingRef.current = true
    setStopping(true)
    setError(null)
    try {
      await onCancel(activeRun.id)
    } catch (failure) {
      if (alive.current) setError(t("Could not stop reply", { reason: userFacingError(failure) }))
    } finally {
      stoppingRef.current = false
      if (alive.current) setStopping(false)
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
        if (!("__TAURI_INTERNALS__" in window)) addBrowserFiles(event.dataTransfer.files)
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
      {cloudUnavailable && <p role="status">{t("Cloud execution coming soon")}</p>}
      {login.blocked && (
        <>
          <ProviderLoginFlow login={login} />
          <button type="button" className="text-button" onClick={onOpenProviderLogin ?? onOpenPermissions}>
            {t("Colar token manualmente")}
          </button>
        </>
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
        aria-controls={suggestions.length ? "group-mention-list" : undefined}
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
              const bot = suggestions[mentionIndex] ?? suggestions[0]
              if (bot) insertMention(bot)
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
        <div className="group-mentions" id="group-mention-list" role="listbox" aria-label={t("Mention member")}>
          {suggestions.map((bot, index) => (
            <button
              type="button"
              role="option"
              aria-selected={index === mentionIndex}
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
            className="composer-icon"
            aria-label={t("Anexar arquivo")}
            title={t("Anexar arquivo")}
            disabled={picking || cloudUnavailable}
            onClick={() => void chooseFiles()}
          >
            <Icon kind="attach" />
          </button>
        </div>
        <div className="composer-actions">
          {activeRun && !showStop && (
            <button
              type="button"
              className="composer-icon"
              aria-label={t("Stop reply button")}
              title={t("Stop reply")}
              disabled={stopping}
              onClick={() => void stop()}
            >
              <Icon kind="stop" />
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
