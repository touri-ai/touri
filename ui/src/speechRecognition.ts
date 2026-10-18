export type SpeechResult = { isFinal: boolean; readonly [index: number]: { transcript: string } }
export type SpeechResultEvent = { resultIndex: number; results: ArrayLike<SpeechResult> }
export type SpeechRecognitionSession = {
  lang: string
  continuous: boolean
  interimResults: boolean
  maxAlternatives: number
  onstart: (() => void) | null
  onend: (() => void) | null
  onerror: ((event: { error: string }) => void) | null
  onresult: ((event: SpeechResultEvent) => void) | null
  start: () => void
  stop: () => void
  abort: () => void
}
export type SpeechRecognitionConstructor = new () => SpeechRecognitionSession
type SpeechWindow = {
  isSecureContext?: boolean
  SpeechRecognition?: SpeechRecognitionConstructor
  webkitSpeechRecognition?: SpeechRecognitionConstructor
}

export const getSpeechRecognition = (host: SpeechWindow = window): SpeechRecognitionConstructor | undefined => {
  if (host.isSecureContext === false) return undefined
  const recognition = host.SpeechRecognition ?? host.webkitSpeechRecognition
  return typeof recognition === "function" ? recognition : undefined
}

export const getDraftWithTranscript = (draft: string, transcript: string): string => {
  const text = transcript.trim()
  if (!text) return draft
  const separator = draft && !/\s$/.test(draft) ? " " : ""
  return `${draft}${separator}${text}`
}
