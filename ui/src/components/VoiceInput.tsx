import { useId, useLayoutEffect, useRef, useState } from "react"
import { type Locale, t } from "../i18n"
import {
  getSpeechRecognition,
  type SpeechRecognitionConstructor,
  type SpeechRecognitionSession,
} from "../speechRecognition"
import { Modal } from "./Modal"
import "./VoiceInput.css"

export const VoiceInput = ({
  contextKey,
  disabled,
  onTranscript,
  onActiveChange,
  locale = "pt-BR",
  recognition = getSpeechRecognition(),
}: {
  contextKey: string
  disabled: boolean
  onTranscript: (text: string) => void
  onActiveChange: (active: boolean) => void
  locale?: Locale
  recognition?: SpeechRecognitionConstructor | undefined
}) => {
  const [consent, setConsent] = useState(false)
  const [active, setActive] = useState(false)
  const [recording, setRecording] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const session = useRef<SpeechRecognitionSession | null>(null)
  const progress = useRef({ nextResult: 0, remainingCharacters: 32_000 })
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const callbacks = useRef({ onTranscript, onActiveChange })
  callbacks.current = { onTranscript, onActiveChange }
  const descriptionId = useId()

  const release = () => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    const current = session.current
    session.current = null
    if (!current) return
    // Detach first: abort may emit late results or errors in browser implementations.
    current.onstart = null
    current.onend = null
    current.onerror = null
    current.onresult = null
    try {
      current.abort()
    } catch {
      // Already-ended browser sessions need no further cleanup.
    }
  }
  const finish = () => {
    release()
    setActive(false)
    setRecording(false)
    setStopping(false)
    callbacks.current.onActiveChange(false)
  }
  const finishRef = useRef(finish)
  finishRef.current = finish

  // biome-ignore lint/correctness/useExhaustiveDependencies: these identity changes must cancel capture even when the handlers are held in refs
  useLayoutEffect(() => {
    const stopWhenHidden = () => {
      if (document.hidden) finishRef.current()
    }
    // A conversation, language or availability change invalidates the entire capture session.
    setConsent(false)
    setError(null)
    finishRef.current()
    document.addEventListener("visibilitychange", stopWhenHidden)
    return () => {
      document.removeEventListener("visibilitychange", stopWhenHidden)
      finishRef.current()
    }
  }, [contextKey, disabled, locale, recognition])

  const start = () => {
    if (!recognition || disabled || session.current) return
    setConsent(false)
    setError(null)
    try {
      const current = new recognition()
      session.current = current
      progress.current = { nextResult: 0, remainingCharacters: 32_000 }
      current.lang = locale
      current.continuous = false
      current.interimResults = false
      current.maxAlternatives = 1
      current.onstart = () => {
        if (session.current === current) setRecording(true)
      }
      // A single dictation has bounded text and lifetime, even with a noisy browser implementation.
      current.onresult = (event) => {
        if (session.current !== current) return
        const end = Math.min(event.results.length, 256)
        const results = Array.from({ length: end }, (_, index) => event.results[index])
        const pending = results.slice(progress.current.nextResult)
        // Browser result lists reuse indexes for interim text; advance only after a final result.
        const interim = pending.findIndex((result) => !result?.isFinal)
        const finalResults = interim === -1 ? pending : pending.slice(0, interim)
        const text = finalResults
          .filter((result) => result?.isFinal)
          .map((result) => result?.[0]?.transcript.slice(0, 8_000) ?? "")
          .reduce((text, part) => getBoundedTranscript(text, part, progress.current.remainingCharacters), "")
        const remainingCharacters = progress.current.remainingCharacters - text.length

        progress.current = {
          nextResult: progress.current.nextResult + finalResults.length,
          remainingCharacters,
        }
        if (text.trim()) callbacks.current.onTranscript(text)
        if (remainingCharacters === 0) finishRef.current()
      }
      current.onend = () => {
        if (session.current === current) finishRef.current()
      }
      current.onerror = (event) => {
        if (session.current !== current) return
        finishRef.current()
        if (event.error === "aborted") return
        setError(getDictationError(event.error, locale))
      }
      setActive(true)
      callbacks.current.onActiveChange(true)
      timer.current = setTimeout(() => finishRef.current(), 60_000)
      current.start()
    } catch {
      finishRef.current()
      setError(t("Dictation failed", {}, locale))
    }
  }

  const stop = () => {
    if (!session.current || stopping) return
    setStopping(true)
    if (timer.current) clearTimeout(timer.current)
    // stop allows a final result; abort after a short grace period if the browser never ends.
    timer.current = setTimeout(() => finishRef.current(), 2_000)
    try {
      session.current.stop()
    } catch {
      finishRef.current()
    }
  }

  if (!recognition) return null
  const getLabel = () => {
    if (!active) return t("Dictate message", {}, locale)
    return t(recording ? "Stop dictation" : "Dictation waiting", {}, locale)
  }
  const label = getLabel()
  const statusKey = recording ? "Dictation recording" : "Dictation waiting"
  const status = t(stopping ? "Dictation stopping" : statusKey, {}, locale)
  return (
    <>
      <button
        type="button"
        className={active ? "composer-stop composer-dictation" : "composer-icon composer-dictation"}
        aria-label={label}
        aria-pressed={active}
        title={label}
        disabled={disabled || stopping}
        onClick={() => {
          if (!active) return setConsent(true)
          if (!recording) return finishRef.current()
          stop()
        }}
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          aria-hidden="true"
        >
          {active ? (
            <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" />
          ) : (
            <path d="M9 5a3 3 0 0 1 6 0v7a3 3 0 0 1-6 0V5ZM5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8" />
          )}
        </svg>
        {active && t(recording ? "Dictation stop short" : "Cancelar", {}, locale)}
      </button>
      <span className="visually-hidden" role="status">
        {active ? status : ""}
      </span>
      {consent && (
        <Modal
          className="dictation-dialog"
          title={t("Dictate message", {}, locale)}
          onClose={() => setConsent(false)}
          describedBy={descriptionId}
        >
          <p className="dictation-copy" id={descriptionId}>
            {t("Dictation privacy", {}, locale)}
          </p>
          <div className="modal-actions">
            <button type="button" className="button button-quiet" onClick={() => setConsent(false)}>
              {t("Cancelar", {}, locale)}
            </button>
            <button type="button" className="button button-primary" onClick={start}>
              {t("Start dictation", {}, locale)}
            </button>
          </div>
        </Modal>
      )}
      {error && (
        <Modal
          className="dictation-dialog"
          title={t("Dictation unavailable", {}, locale)}
          onClose={() => setError(null)}
        >
          <p className="dictation-copy" role="alert">
            {error}
          </p>
          <div className="modal-actions">
            <button type="button" className="button" onClick={() => setError(null)}>
              {t("Close dialog", {}, locale)}
            </button>
          </div>
        </Modal>
      )}
    </>
  )
}

const getBoundedTranscript = (text: string, part: string, budget: number): string => {
  if (text.length >= budget) return text

  const separator = text ? " " : ""
  return `${text}${separator}${part}`.slice(0, budget)
}

const getDictationError = (code: string, locale: Locale): string => {
  if (code === "not-allowed" || code === "service-not-allowed") return t("Dictation permission denied", {}, locale)
  if (code === "no-speech") return t("Dictation no speech", {}, locale)
  if (code === "audio-capture") return t("Dictation no microphone", {}, locale)
  return t("Dictation failed", {}, locale)
}
