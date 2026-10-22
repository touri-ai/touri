import type { Message, Thread } from "@touri/contracts"
import { getChannelThreadCards } from "../channelThreadCards"
import { getChannelThreadTitle } from "../channelThreads"
import { getDocumentLocale } from "../documentLanguage"
import { t } from "../i18n"

export const ChannelThreads = ({
  groupId,
  threads,
  messages,
  onSelect,
}: {
  groupId: string
  threads: readonly Thread[]
  messages: readonly Message[]
  onSelect: (threadId: string) => void
}) => (
  <section className="channel-conversations" aria-label={t("Channel conversations")}>
    {getChannelThreadCards(threads, messages, groupId).map(({ thread, reply }) => (
      <button type="button" className="channel-conversation" key={thread.id} onClick={() => onSelect(thread.id)}>
        <strong>{getChannelThreadTitle(thread, getDocumentLocale(document.documentElement))}</strong>
        <span>{reply?.text || t("Open conversation")}</span>
      </button>
    ))}
  </section>
)
