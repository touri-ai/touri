import { type ComponentProps, type Ref, useEffect, useImperativeHandle } from "react"
import { useComposerDraft } from "../composerDraft"
import { t } from "../i18n"
import { consumeTaskResume, resumeTaskEvent } from "../recoveryEvents"
import { Composer } from "./Composer"

export type DraftComposerHandle = { setDraft: (draft: string) => void }

type DraftComposerProps = Omit<ComponentProps<typeof Composer>, "draft" | "onDraft"> & {
  draftRef: Ref<DraftComposerHandle>
  draftIdentity?: string | undefined
}

/** Keep edits and durable draft writes local so typing never renders the transcript. */
export const DraftComposer = ({ draftRef, draftIdentity, onSend, ...props }: DraftComposerProps) => {
  const { draft, setDraft, draftSaveFailed } = useComposerDraft(props.threadId, draftIdentity)
  useImperativeHandle(draftRef, () => ({ setDraft }), [setDraft])
  const { threadId, inputRef } = props
  useEffect(() => {
    const resume = () => {
      if (!consumeTaskResume(threadId)) return
      setDraft(
        (current) =>
          current ||
          t(
            "Conferi as ações registradas. Quero continuar a tarefa a partir do estado atual, sem repetir ações já concluídas.",
          ),
      )
      inputRef.current?.focus()
    }
    resume()
    window.addEventListener(resumeTaskEvent, resume)
    return () => window.removeEventListener(resumeTaskEvent, resume)
  }, [threadId, inputRef, setDraft])

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
          setDraft((current) => (current === draft ? "" : current))
        }}
      />
    </>
  )
}
