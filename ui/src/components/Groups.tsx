import type { Bot, BotGroup, GroupInput, Message, Run, Thread } from "@touri/contracts"
import { useEffect, useMemo, useRef, useState } from "react"
import { userFacingError } from "../errors"
import { type Locale, t } from "../i18n"
import { AvatarPicker } from "./AvatarPicker"
import { BotAvatar } from "./BotAvatar"
import { getGroupProjection, getIdleMemberState } from "./groupProjection"
import "./groups.css"

export const MemberMascots = ({ bots, locale = "pt-BR" }: { bots: Bot[]; locale?: Locale }) => (
  <span
    role="img"
    className="group-mascots"
    aria-label={t(
      bots.length ? "Group members label" : "Group member count",
      {
        count: bots.length,
        names: bots.map((b) => b.name).join(", "),
      },
      locale,
    )}
  >
    {bots.slice(0, 4).map((bot) => (
      <BotAvatar key={bot.id} bot={bot} size={24} />
    ))}
  </span>
)
export const GroupSidebar = ({
  groups,
  bots,
  threads,
  selectedThreadId,
  onSelect,
  onCreate,
  onEdit,
  onNewThread,
}: {
  groups: BotGroup[]
  bots: Bot[]
  threads: Thread[]
  selectedThreadId: string | null
  onSelect: (id: string) => void
  onCreate: () => void
  onEdit: (group: BotGroup) => void
  onNewThread: (group: BotGroup) => void
}) => (
  <section className="group-sidebar" aria-label="Grupos">
    <div className="group-sidebar-heading">
      <span>
        Grupos <small>{groups.length}</small>
      </span>
      <button type="button" aria-label="Criar grupo" onClick={onCreate}>
        +
      </button>
    </div>
    {groups.length === 0 && <p className="group-empty">Reúna seus bots em uma conversa.</p>}
    {groups.map((group) => {
      const own = threads.filter((t) => t.groupId === group.id && !t.groupThreadId)
      const selected = own.some((t) => t.id === selectedThreadId)
      return (
        <div key={group.id} className={`group-sidebar-item ${selected ? "selected" : ""}`}>
          <div className="group-sidebar-row">
            <button
              type="button"
              className="group-select"
              aria-label={group.name}
              onClick={() => {
                if (own[0]) onSelect(own[0].id)
                else onNewThread(group)
              }}
              aria-current={selected ? "page" : undefined}
            >
              <MemberMascots
                bots={group.memberIds.flatMap((id) => {
                  const b = bots.find((b) => b.id === id)
                  return b ? [b] : []
                })}
              />
              <span>{group.name}</span>
            </button>
            <button type="button" aria-label={`Editar grupo ${group.name}`} onClick={() => onEdit(group)}>
              ⋯
            </button>
          </div>
          {selected && (
            <div className="group-thread-list">
              {own.map((thread) => (
                <button
                  type="button"
                  key={thread.id}
                  aria-current={thread.id === selectedThreadId ? "page" : undefined}
                  onClick={() => onSelect(thread.id)}
                >
                  {thread.title}
                </button>
              ))}
              <button type="button" onClick={() => onNewThread(group)}>
                + Nova conversa
              </button>
            </div>
          )}
        </div>
      )
    })}
  </section>
)

export const GroupRoutingNote = ({ group, bots }: { group: BotGroup; bots: Bot[] }) => {
  const coordinator = bots.find((bot) => bot.id === group.coordinatorBotId)
  return (
    <p className="group-routing-note">
      {coordinator
        ? t("{name} coordena as respostas e pode delegar aos membros. Use @nome para falar com um membro.", {
            name: coordinator.name,
          })
        : t("Sem menções, todos os membros respondem na ordem da lista. Use @nome para escolher quem responde.")}
    </p>
  )
}

const GroupMembers = ({ group, bots }: { group: BotGroup; bots: Bot[] }) => (
  <ol className="group-context-members" aria-label={t("Membros do grupo")}>
    {bots.map((bot) => (
      <li key={bot.id}>
        <BotAvatar bot={bot} size={28} />
        <div>
          <strong>{bot.name}</strong>
          {bot.id === group.coordinatorBotId && <small>{t("Coordenador")}</small>}
          {bot.roleLine && <small>{bot.roleLine}</small>}
        </div>
      </li>
    ))}
  </ol>
)

export const GroupConversationStart = ({ group, bots }: { group: BotGroup; bots: Bot[] }) => (
  <section className="conversation-start" aria-label={t("Comece uma conversa com {name}", { name: group.name })}>
    <BotAvatar
      bot={{ id: group.id, color: group.color, avatarShape: group.avatarShape, avatarSeed: group.avatarSeed }}
      size={36}
    />
    <h2>{t("Comece uma conversa com {name}", { name: group.name })}</h2>
    <p>{t("Conte o que o grupo deve fazer para começar.")}</p>
    <GroupMembers group={group} bots={bots} />
    <GroupRoutingNote group={group} bots={bots} />
  </section>
)

export const GroupPanel = ({
  group,
  bots,
  threadId,
  messages = [],
  runs = [],
  onClose,
  onEdit,
}: {
  group: BotGroup
  bots: Bot[]
  threadId?: string | undefined
  messages?: Message[]
  runs?: Run[]
  onClose: () => void
  onEdit: () => void
}) => {
  const { board, members } = useMemo(() => getGroupProjection(threadId, messages, runs), [threadId, messages, runs])

  return (
    <aside
      className="bot-panel group-panel"
      id="bot-panel"
      aria-label={t("Painel do grupo {name}", { name: group.name })}
    >
      <div className="bot-panel-top">
        <span>{t("Seu grupo")}</span>
        <button type="button" className="toolbar-icon" aria-label={t("Fechar painel do grupo")} onClick={onClose}>
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
        <h3>{t("Membros do grupo")}</h3>
        <ol className="group-context-members group-status-members" aria-label={t("Membros do grupo")}>
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
          {board.length === 0 && <p className="muted-copy">{t("Sem resultados confirmados neste turno.")}</p>}
        </section>
        <GroupRoutingNote group={group} bots={bots} />
        <p className="muted-copy">{t("Cada bot mantém seu computador e suas permissões.")}</p>
        <button type="button" className="button button-quiet" onClick={onEdit}>
          {t("Editar membros")}
        </button>
      </div>
    </aside>
  )
}

export const GroupHeader = ({
  group,
  bots,
  onEdit,
  panelOpen,
  onTogglePanel,
  locale = "pt-BR",
}: {
  group: BotGroup
  bots: Bot[]
  onEdit: () => void
  panelOpen?: boolean
  onTogglePanel?: (() => void) | undefined
  locale?: Locale
}) => (
  <header className="chat-header group-header" data-tauri-drag-region="deep">
    <div>
      <span className="chat-header-crumb">{t("Grupos / {name}", { name: group.name }, locale)}</span>
      <div className="group-heading-name">
        <BotAvatar
          bot={{ id: group.id, color: group.color, avatarShape: group.avatarShape, avatarSeed: group.avatarSeed }}
          size={30}
        />
        <strong>{group.name}</strong>
        <span className="group-member-count">{t("Group member count", { count: bots.length }, locale)}</span>
      </div>
    </div>
    <div className="group-header-members">
      <MemberMascots bots={bots} locale={locale} />
      <span>
        {bots
          .map((b) => `${b.name}${b.id === group.coordinatorBotId ? t("Group coordinator suffix", {}, locale) : ""}`)
          .join(", ")}
      </span>
    </div>
    {onTogglePanel && (
      <button
        type="button"
        className="toolbar-icon bot-panel-toggle"
        aria-label={t("Painel do grupo", {}, locale)}
        aria-expanded={panelOpen}
        aria-controls="bot-panel"
        onClick={onTogglePanel}
      >
        ◧
      </button>
    )}
    <button type="button" className="button button-quiet" onClick={onEdit}>
      {t("Editar grupo", {}, locale)}
    </button>
  </header>
)

export const GroupModal = ({
  group,
  initial,
  bots,
  onClose,
  onSave,
}: {
  group: BotGroup | null
  initial?: Pick<GroupInput, "name" | "memberIds"> | null
  bots: Bot[]
  onClose: () => void
  onSave: (input: GroupInput) => Promise<void>
}) => {
  const [name, setName] = useState(group?.name ?? initial?.name ?? "")
  const [memberIds, setMembers] = useState(group?.memberIds ?? initial?.memberIds ?? [])
  const [coordinatorBotId, setCoordinator] = useState<string | null>(group?.coordinatorBotId ?? null)
  const [color, setColor] = useState(group?.color ?? "#dc2626")
  const [shape, setShape] = useState(group?.avatarShape ?? "cercle")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const dialog = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    dialog.current?.querySelector<HTMLInputElement>("input")?.focus()
    return () => previous?.focus()
  }, [])
  return (
    <div className="modal-backdrop group-modal-backdrop">
      <div
        className="modal-card group-modal"
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="group-modal-title"
        onKeyDown={(event) => {
          if (event.key === "Escape" && !saving) onClose()
          if (event.key === "Tab") {
            const controls = dialog.current?.querySelectorAll<HTMLElement>("button:not(:disabled),input,select")
            const first = controls?.[0]
            const last = controls?.[controls.length - 1]
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault()
              last?.focus()
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault()
              first?.focus()
            }
          }
        }}
      >
        <form
          onKeyDown={(event) => {
            // A suggested group needs an explicit save after its prefilled fields are reviewed.
            if (initial && event.key === "Enter" && !(event.target instanceof HTMLButtonElement)) event.preventDefault()
          }}
          onSubmit={async (event) => {
            event.preventDefault()
            setSaving(true)
            setError(null)
            try {
              await onSave({ name, color, avatarShape: shape, memberIds, coordinatorBotId })
              onClose()
            } catch (e) {
              setError(userFacingError(e))
            } finally {
              setSaving(false)
            }
          }}
        >
          <div className="group-modal-heading">
            <div>
              <p className="eyebrow">Bots juntos</p>
              <h2 id="group-modal-title">{group ? "Editar grupo" : "Criar grupo"}</h2>
            </div>
            <button type="button" onClick={onClose} disabled={saving} aria-label="Fechar grupo">
              ×
            </button>
          </div>
          <p className="muted-copy">Uma conversa compartilhada. Cada bot mantém seu computador e suas permissões.</p>
          <label className="group-field">
            Nome do grupo
            <input
              aria-label="Nome do grupo"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={80}
              required
              placeholder="Ex.: Produto"
              disabled={saving}
            />
          </label>
          <AvatarPicker
            label="Mascote do grupo"
            description="Personalize seu grupo"
            bot={{
              id: group?.id ?? "new-group",
              avatarShape: shape,
              color,
              avatarSeed: group?.avatarSeed ?? "new-group",
            }}
            onChange={(v) => {
              if (v.avatarShape) setShape(v.avatarShape)
              if (v.color) setColor(v.color)
            }}
          />
          <fieldset disabled={saving}>
            <legend>
              Membros <small>· ordem das respostas</small>
            </legend>
            <div className="group-member-picker">
              {bots
                .filter((b) => !b.archivedAt)
                .map((bot) => (
                  <label key={bot.id}>
                    <input
                      type="checkbox"
                      aria-label={bot.name}
                      checked={memberIds.includes(bot.id)}
                      onChange={(e) => {
                        setMembers((ids) => (e.target.checked ? [...ids, bot.id] : ids.filter((id) => id !== bot.id)))
                        if (!e.target.checked && coordinatorBotId === bot.id) setCoordinator(null)
                      }}
                    />
                    <BotAvatar bot={bot} size={28} />
                    <span>{bot.name}</span>
                    {memberIds.includes(bot.id) && <small>{memberIds.indexOf(bot.id) + 1}</small>}
                  </label>
                ))}
            </div>
          </fieldset>
          <label className="group-field">
            Coordenador <span className="muted-copy">opcional</span>
            <select
              aria-label="Coordenador"
              value={coordinatorBotId ?? ""}
              disabled={saving}
              onChange={(e) => setCoordinator(e.target.value || null)}
            >
              <option value="">Sem coordenador</option>
              {memberIds.map((id) => (
                <option key={id} value={id}>
                  {bots.find((b) => b.id === id)?.name}
                </option>
              ))}
            </select>
          </label>
          <p className="group-routing-note">
            {coordinatorBotId
              ? "O coordenador recebe o pedido e pode delegar aos membros."
              : "Mencione @nome para escolher quem responde. Sem menções, todos respondem na ordem acima."}
          </p>
          {error && <p role="alert">{error}</p>}
          <div className="group-modal-actions">
            <button type="button" className="button button-quiet" onClick={onClose} disabled={saving}>
              Cancelar
            </button>
            <button
              type="submit"
              className="button button-brand"
              disabled={saving || !name.trim() || !memberIds.length}
            >
              {saving ? "Salvando…" : group ? "Salvar grupo" : "Criar grupo"}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
