import type { Bot, MachineState, MessagePart } from "@touri/contracts"
import { createContext, useContext, useEffect, useRef, useState } from "react"
import type { UiApi } from "../../api/client"
import { asToolRecord, parseToolValue, toolIdentity, toolStatus } from "../../components/toolPresentation"
import { startInlineFrameSource } from "./inlineFrameSource"
import { useInlinePreviewPreference } from "./inlinePreviewPreference"
import "./inline-preview.css"

export const InlinePreviewContext = createContext<{
  api: UiApi
  bot: Bot | null
  machine: MachineState | undefined
  activeCallId: string | undefined
  onOpenComputer: () => void
} | null>(null)

export const screenTool = (part: MessagePart): boolean =>
  part.type === "tool_call" && ["browser", "computer"].includes(toolIdentity(part.tool).kind)

// One live decoder/poller for the entire window, including multiple chat roots.
let owner: symbol | undefined
const listeners = new Set<() => void>()
const notify = () => {
  for (const listener of listeners) listener()
}

export const InlineLivePreview = ({ parts, finished }: { parts: MessagePart[]; finished: boolean }) => {
  const context = useContext(InlinePreviewContext)
  const enabled = useInlinePreviewPreference()
  const part =
    parts.find((part) => part.type === "tool_call" && part.callId === context?.activeCallId) ??
    [...parts].reverse().find(screenTool)
  const tool = part?.type === "tool_call" ? part : undefined
  const running = !!tool && !finished && toolStatus(tool) === "running" && context?.activeCallId === tool.callId
  const root = useRef<HTMLElement>(null)
  const identity = useRef(Symbol("inline-preview"))
  const [visible, setVisible] = useState(false)
  const [hidden, setHidden] = useState(document.hidden)
  const [lease, setLease] = useState(false)
  const [image, setImage] = useState<{ src: string; title: string; url: string }>()
  const [expanded, setExpanded] = useState(false)
  const [failed, setFailed] = useState(false)
  const [reason, setReason] = useState<string | null>(null)
  const [waitingReason, setWaitingReason] = useState<string | null>(null)
  const bot = context?.bot
  const botId = bot?.id
  const machineKind = bot?.machine
  const eligible = enabled && running && !!bot && (bot.machine === "local" || context?.machine?.status === "running")
  const wanted = eligible && visible && !hidden && !failed
  const api = context?.api
  const tabId = tool ? asToolRecord(parseToolValue(tool.inputJson))?.tabId : undefined
  useEffect(() => {
    if (tool?.callId) {
      setFailed(false)
      setReason(null)
      setWaitingReason(null)
    }
  }, [tool?.callId])

  useEffect(() => {
    const node = root.current
    if (!node || typeof IntersectionObserver === "undefined") return
    const observer = new IntersectionObserver(([entry]) => setVisible(entry?.isIntersecting ?? false))
    observer.observe(node)
    const visibility = () => setHidden(document.hidden)
    document.addEventListener("visibilitychange", visibility)
    return () => {
      observer.disconnect()
      document.removeEventListener("visibilitychange", visibility)
    }
  }, [])
  useEffect(() => {
    const id = identity.current
    const claim = () => {
      if (wanted && !owner) owner = id
      setLease(wanted && owner === id)
    }
    listeners.add(claim)
    claim()
    return () => {
      listeners.delete(claim)
      if (owner === id) {
        owner = undefined
        notify()
      }
    }
  }, [wanted])
  useEffect(() => {
    if (!wanted || !lease || !api || !botId || !machineKind) return
    return startInlineFrameSource(
      api,
      { id: botId, machine: machineKind },
      typeof tabId === "string" ? tabId : undefined,
      (frame) => setImage(frame),
      (why) => {
        setReason(why ?? null)
        setFailed(true)
      },
      setWaitingReason,
      { onReset: () => setImage(undefined) },
    )
  }, [wanted, lease, api, botId, machineKind, tabId])

  return (
    <section
      ref={root}
      className={`inline-live-preview${expanded ? " inline-live-preview-expanded" : ""}`}
      hidden={!enabled || (!eligible && !image)}
      aria-label="Prévia do computador no chat"
    >
      <div className="inline-preview-page" title={image?.url}>
        <strong>{image?.title || "Tela do computador"}</strong>
        {image?.url && <span>{image.url}</span>}
      </div>
      <button
        type="button"
        className="inline-preview-screen"
        aria-label="Ampliar prévia do computador"
        aria-expanded={expanded}
        disabled={!image}
        onClick={() => setExpanded((value) => !value)}
      >
        {image ? (
          <img src={image.src} alt="Última imagem do computador" />
        ) : (
          <span>
            <span>{failed ? "Prévia indisponível" : "Aguardando imagem…"}</span>
            {(failed ? reason : waitingReason) && <small>{failed ? reason : waitingReason}</small>}
          </span>
        )}
      </button>
      <div className="inline-preview-actions">
        <span>{running && lease && wanted ? "Ao vivo · somente observar" : "Última imagem"}</span>
        <button type="button" onClick={() => context?.onOpenComputer()}>
          Abrir no Computador
        </button>
        <button type="button" disabled={!image} aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
          {expanded ? "Recolher" : "Expandir"}
        </button>
      </div>
    </section>
  )
}
