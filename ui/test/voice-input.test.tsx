import { act, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { VoiceInput } from "../src/components/VoiceInput"
import { type Locale, t } from "../src/i18n"
import {
  getDraftWithTranscript,
  getSpeechRecognition,
  type SpeechRecognitionSession,
  type SpeechResultEvent,
} from "../src/speechRecognition"

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const hideDocument = () => vi.spyOn(document, "hidden", "get").mockReturnValue(true)

const setup = (locale: Locale = "pt-BR") => {
  const sessions: SpeechRecognitionSession[] = []
  class Recognition implements SpeechRecognitionSession {
    lang = ""
    continuous = true
    interimResults = true
    maxAlternatives = 4
    onstart: (() => void) | null = null
    onend: (() => void) | null = null
    onerror: ((event: { error: string }) => void) | null = null
    onresult: ((event: SpeechResultEvent) => void) | null = null
    start = vi.fn()
    stop = vi.fn()
    abort = vi.fn()
    constructor() {
      sessions.push(this)
    }
  }
  const transcript = vi.fn()
  const active = vi.fn()
  const props = {
    contextKey: "thread-a",
    disabled: false,
    locale,
    recognition: Recognition,
    onTranscript: transcript,
    onActiveChange: active,
  }
  const view = render(<VoiceInput {...props} />)
  const start = () => {
    fireEvent.click(screen.getByRole("button", { name: t("Dictate message", {}, locale) }))
    fireEvent.click(screen.getByRole("button", { name: t("Start dictation", {}, locale) }))
    const session = sessions.at(-1)
    if (!session) throw new Error("Expected a dictation session")
    act(() => session.onstart?.())
    return session
  }
  return { ...view, sessions, transcript, active, props, start }
}
const result = (text: string, isFinal = true): SpeechResultEvent => ({
  resultIndex: 0,
  results: [{ isFinal, 0: { transcript: text } }],
})

describe("optional browser dictation", () => {
  for (const locale of ["pt-BR", "en"] as const) {
    it(`requires informed consent before creating a microphone session in ${locale}`, () => {
      const { sessions, start } = setup(locale)
      expect(sessions).toHaveLength(0)

      fireEvent.click(screen.getByRole("button", { name: t("Dictate message", {}, locale) }))

      expect(screen.getByRole("dialog")).toHaveTextContent(t("Dictation privacy", {}, locale))
      expect(sessions).toHaveLength(0)
      fireEvent.click(screen.getByRole("button", { name: t("Cancelar", {}, locale) }))
      const session = start()
      expect(session.lang).toBe(locale === "en" ? "en-US" : "pt-BR")
      expect(session.start).toHaveBeenCalledOnce()
      expect(screen.getByRole("button", { name: t("Stop dictation", {}, locale) })).toHaveAttribute(
        "aria-pressed",
        "true",
      )
    })
  }

  it("accepts final plain text once, preserves interim indexes, and exposes no send action", () => {
    const { start, transcript } = setup()
    const session = start()

    act(() => session.onresult?.(result("Ainda ouvindo", false)))
    expect(transcript).not.toHaveBeenCalled()
    act(() => session.onresult?.(result("<script>texto ditado</script>")))
    act(() => session.onresult?.(result("<script>texto ditado</script>")))

    expect(transcript).toHaveBeenCalledExactlyOnceWith("<script>texto ditado</script>")
    expect(screen.queryByRole("button", { name: "Enviar" })).toBeNull()
  })

  it("allows the final result after Stop, then aborts a browser that never ends", () => {
    vi.useFakeTimers()
    const { start, transcript, active } = setup()
    const session = start()

    fireEvent.click(screen.getByRole("button", { name: "Gravando… Parar ditado" }))
    act(() => session.onresult?.(result("Últimas palavras")))
    act(() => vi.advanceTimersByTime(2_000))

    expect(session.stop).toHaveBeenCalledOnce()
    expect(session.abort).toHaveBeenCalledOnce()
    expect(transcript).toHaveBeenCalledExactlyOnceWith("Últimas palavras")
    expect(active).toHaveBeenLastCalledWith(false)
  })

  it("cancels on conversation changes and rejects late callbacks", () => {
    const { start, rerender, props, transcript } = setup()
    const session = start()
    const lateResult = session.onresult
    const lateError = session.onerror

    rerender(<VoiceInput {...props} contextKey="thread-b" />)
    act(() => lateResult?.(result("Não pode ir para a outra conversa")))
    act(() => lateError?.({ error: "not-allowed" }))

    expect(session.abort).toHaveBeenCalledOnce()
    expect(transcript).not.toHaveBeenCalled()
    expect(screen.queryByRole("alert")).toBeNull()
  })

  it("stops on unmount and bounds a session to one minute", () => {
    vi.useFakeTimers()
    const { start, unmount, active } = setup()
    const session = start()

    act(() => vi.advanceTimersByTime(60_000))

    expect(session.abort).toHaveBeenCalledOnce()
    const second = start()
    unmount()
    expect(second.abort).toHaveBeenCalledOnce()
    const finishedCalls = active.mock.calls.length

    act(() => vi.advanceTimersByTime(60_000))

    expect(active).toHaveBeenCalledTimes(finishedCalls)
  })

  for (const code of ["not-allowed", "no-speech", "audio-capture", "network"]) {
    it(`shows safe recovery for ${code}`, () => {
      const { start, transcript } = setup()
      const session = start()

      act(() => session.onerror?.({ error: code }))

      expect(screen.getByRole("alert")).not.toBeEmptyDOMElement()
      expect(session.abort).toHaveBeenCalledOnce()
      expect(transcript).not.toHaveBeenCalled()
    })
  }

  it("hides the button when no recognition implementation is available", () => {
    render(<VoiceInput contextKey="unsupported" disabled={false} onTranscript={vi.fn()} onActiveChange={vi.fn()} />)

    expect(getSpeechRecognition()).toBeUndefined()
    expect(screen.queryByRole("button")).toBeNull()
  })

  it("supports the prefixed API and hides it in insecure browser contexts", () => {
    const { props } = setup()

    expect(getSpeechRecognition({ webkitSpeechRecognition: props.recognition })).toBe(props.recognition)
    expect(getSpeechRecognition({ SpeechRecognition: props.recognition, isSecureContext: false })).toBeUndefined()
  })

  it("bounds result text and ends capture after the session character budget", () => {
    const { start, transcript } = setup()
    const session = start()

    act(() =>
      session.onresult?.({
        resultIndex: 0,
        results: Array.from({ length: 256 }, () => ({ isFinal: true, 0: { transcript: "x".repeat(10_000) } })),
      }),
    )

    expect(transcript.mock.calls[0]?.[0].length).toBeLessThanOrEqual(32_000)
    expect(session.abort).toHaveBeenCalledOnce()
  })

  it("cancels capture when the browser tab becomes hidden", () => {
    const { start } = setup()
    const session = start()

    hideDocument()
    fireEvent(document, new Event("visibilitychange"))

    expect(session.abort).toHaveBeenCalledOnce()
  })

  it("allows cancelling a pending microphone prompt before recording begins", () => {
    const { sessions } = setup()

    fireEvent.click(screen.getByRole("button", { name: "Ditar mensagem" }))
    fireEvent.click(screen.getByRole("button", { name: "Iniciar ditado" }))
    fireEvent.click(screen.getByRole("button", { name: "Aguardando microfone… Cancelar ditado" }))

    expect(sessions[0]?.abort).toHaveBeenCalledOnce()
    expect(screen.getByRole("button", { name: "Ditar mensagem" })).toHaveAttribute("aria-pressed", "false")
  })

  it("preserves the draft callback when the browser refuses to start", () => {
    const { props, rerender, transcript } = setup()
    class Unavailable extends props.recognition {
      start = vi.fn().mockImplementation(() => {
        throw new Error("Synthetic browser refusal")
      })
    }
    rerender(<VoiceInput {...props} recognition={Unavailable} />)

    fireEvent.click(screen.getByRole("button", { name: "Ditar mensagem" }))
    fireEvent.click(screen.getByRole("button", { name: "Iniciar ditado" }))

    expect(screen.getByRole("alert")).toHaveTextContent("Seu rascunho foi preservado")
    expect(transcript).not.toHaveBeenCalled()
  })

  it("appends dictation without discarding an edited draft or its trailing whitespace", () => {
    expect(getDraftWithTranscript("Rascunho editado", "  texto ditado  ")).toBe("Rascunho editado texto ditado")
    expect(getDraftWithTranscript("Linha\n", "texto")).toBe("Linha\ntexto")
    expect(getDraftWithTranscript("Preservar", "  ")).toBe("Preservar")
  })
})
