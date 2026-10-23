import { type ComponentProps, type Ref, useEffect, useImperativeHandle } from "react"
import { useComposerDraft } from "../composerDraft"
import { t } from "../i18n"
import { consumeTaskResume, resumeTaskEvent } from "../recoveryEvents"
import { Composer, getMentionToken } from "./Composer"

export type DraftComposerHandle = { setDraft: (draft: string) => void }

type DraftComposerProps = Omit<ComponentProps<typeof Composer>, "draft" | "onDraft"> & {
  draftRef: Ref<DraftComposerHandle>
  draftIdentity?: string | undefined
}

/** Keep edits and durable draft writes local so typing never renders the transcript. */
export const DraftComposer = ({ draftRef, draftIdentity, onSend, ...props }: DraftComposerProps) => {
  const { draft, setDraft, draftSaveFailed } = useComposerDraft(props.threadId, draftIdentity)
  useImperativeHandle(draftRef, () => ({ setDraft }), [setDraft])
  const { threadId, inputRef, mentionBots } = props
  useEffect(() => {
    const resume = () => {
      const request = consumeTaskResume(threadId)
      if (!request) return
      const bot = mentionBots?.find((member) => member.id === request.botId)
      setDraft((current) => getResumeDraft(current, bot?.name))
      inputRef.current?.focus()
    }
    resume()
    window.addEventListener(resumeTaskEvent, resume)
    return () => window.removeEventListener(resumeTaskEvent, resume)
  }, [threadId, inputRef, setDraft, mentionBots])

  return (
    <>
      {draftSaveFailed && (
        <p role="alert">{t("Não foi possível salvar o rascunho. Copie sua mensagem antes de fechar o touri.")}</p>
      )}
      <Composer
        {...props}
        draft={draft}
        onDraft={setDraft}
        onSend={async (...args) => {
          await onSend(...args)
          // A send can finish after navigation; clear only this conversation's unchanged draft.
          if (args[3] !== "summarize") setDraft((current) => (current === draft ? "" : current))
        }}
      />
    </>
  )
}

/**
 * A channel runs only mentioned bots, so resuming there names the interrupted bot. An existing draft
 * stays below the request instead of being replaced; a direct conversation keeps it as it is.
 */
export const getResumeDraft = (current: string, botName?: string): string => {
  const request = t(
    "Conferi as ações registradas. Quero continuar a tarefa a partir do estado atual, sem repetir ações já concluídas.",
  )
  if (!botName) return current || request
  const mention = getMentionToken(botName)
  if (!current.trim()) return `${mention} ${request}`
  if (current.includes(mention)) return current

  return `${mention} ${request}\n\n${current}`
}
