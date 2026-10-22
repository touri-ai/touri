import type { Bot, BotGroup, ChannelPerson, Message, Run } from "@touri/contracts"
import { useMemo } from "react"
import type { UiApi } from "../api/client"
import { useChannelPeople } from "../features/channelBrowser/useChannelPeople"
import { t } from "../i18n"
import { BotAvatar } from "./BotAvatar"
import { getGroupProjection, getIdleMemberState } from "./groupProjection"
import "./groups.css"

export const GroupPanel = ({
  group,
  api,
  currentPersonId,
  bots,
  threadId,
  messages = [],
  runs = [],
  onClose,
  onEdit,
  channelMode = false,
}: {
  group: BotGroup
  api?: UiApi | null | undefined
  currentPersonId?: string | null | undefined
  bots: Bot[]
  threadId?: string | undefined
  messages?: Message[]
  runs?: Run[]
  onClose: () => void
  onEdit: () => void
  channelMode?: boolean
}) => {
  const people = useChannelPeople(api, channelMode ? group.id : null)
  const { board, members, removed } = useMemo(
    () => getGroupProjection(threadId, messages, runs),
    [threadId, messages, runs],
  )

  return (
    <aside
      className="bot-panel group-panel"
      id="bot-panel"
      aria-label={t(channelMode ? "Channel panel for {name}" : "Painel do grupo {name}", { name: group.name })}
    >
      <div className="bot-panel-top">
        <span>{t(channelMode ? "Your channel" : "Seu grupo")}</span>
        <button
          type="button"
          className="toolbar-icon"
          aria-label={t(channelMode ? "Close channel panel" : "Fechar painel do grupo")}
          onClick={onClose}
        >
          ×
        </button>
      </div>
      <header className="bot-panel-identity">
        <BotAvatar
          bot={{ id: group.id, color: group.color, avatarShape: group.avatarShape, avatarSeed: group.avatarSeed }}
          size={72}
        />
        <h2>{group.name}</h2>
      </header>
      <div className="bot-panel-body">
        <h3>{t(channelMode ? "Channel members" : "Membros do grupo")}</h3>
        <ol
          className="group-context-members group-status-members"
          aria-label={t(channelMode ? "Channel members" : "Membros do grupo")}
        >
          <ChannelPeople people={people} currentPersonId={currentPersonId} />
          {bots.map((bot) => {
            const member = members.get(bot.id) ?? getIdleMemberState()
            return (
              <li key={bot.id}>
                <BotAvatar bot={bot} size={28} />
                <div>
                  <strong>{bot.name}</strong>
                  <small>{t(bot.id === group.coordinatorBotId ? "Coordenador" : "Membro")}</small>
                  {bot.roleLine && <small>{bot.roleLine}</small>}
                  <span className={`group-member-state group-member-state-${member.state}`}>{t(member.label)}</span>
                  <p className="group-member-result">{member.result || t("Sem resultado confirmado.")}</p>
                </div>
              </li>
            )
          })}
        </ol>
        <section className="group-board" aria-label={t("Resultados do turno")}>
          <h3>{t("Resultados do turno")}</h3>
          <p className="muted-copy">{t("Somente respostas finais confirmadas. Este quadro é apenas para leitura.")}</p>
          {board.map((result) => (
            <article key={result.id}>
              <strong>{result.sender?.name}</strong>
              <p>{result.text}</p>
            </article>
          ))}
          {removed.map((message) => (
            <article key={message.id}>
              <strong>{message.sender?.name}</strong>
              <p>{t(channelMode ? "The member was removed from the channel." : "O membro foi removido do grupo.")}</p>
            </article>
          ))}
          {board.length === 0 && removed.length === 0 && (
            <p className="muted-copy">{t("Sem resultados confirmados neste turno.")}</p>
          )}
        </section>
        <p className="group-routing-note">{t("Os bots só respondem quando você os chama com @nome.")}</p>
        <p className="muted-copy">
          {t(
            channelMode
              ? "Each bot keeps its own computer and permissions."
              : "Cada bot mantém seu computador e suas permissões.",
          )}
        </p>
        <button type="button" className="button button-quiet" onClick={onEdit}>
          {t(channelMode ? "Edit channel" : "Editar membros")}
        </button>
      </div>
    </aside>
  )
}

const ChannelPeople = ({
  people,
  currentPersonId,
}: {
  people: ChannelPerson[]
  currentPersonId?: string | null | undefined
}) =>
  people.map((person) => (
    <li key={`person:${person.id}`}>
      <span className="channel-person-avatar" aria-hidden="true">
        {Array.from(person.name.trim())[0]?.toLocaleUpperCase("pt-BR")}
      </span>
      <div>
        <strong>{person.id === currentPersonId ? t("Você") : person.name}</strong>
        <small>
          {t("Person")} · @{person.handle ?? person.name}
        </small>
      </div>
    </li>
  ))
