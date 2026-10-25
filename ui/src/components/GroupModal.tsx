import type { AvatarShape, Bot, BotGroup, GroupInput } from "@touri/contracts"
import { avatarColorFor, avatarProfileFor } from "@touri/contracts/avatar"
import { useEffect, useRef, useState } from "react"
import { userFacingError } from "../errors"
import { t } from "../i18n"
import { AvatarPicker } from "./AvatarPicker"
import { BotAvatar } from "./BotAvatar"
import { Disclosure } from "./Disclosure"
import "./groups.css"
import "./group-modal.css"

export const GroupModal = ({
  group,
  initial,
  bots,
  onClose,
  onSave,
  channelMode = false,
}: {
  group: BotGroup | null
  initial?: Pick<GroupInput, "name" | "memberIds"> | null
  bots: Bot[]
  onClose: () => void
  onSave: (input: GroupInput) => Promise<void>
  channelMode?: boolean
}) => {
  const [name, setName] = useState(group?.name ?? initial?.name ?? "")
  const [memberIds, setMembers] = useState(group?.memberIds ?? initial?.memberIds ?? [])
  const [coordinatorBotId, setCoordinator] = useState<string | null>(group?.coordinatorBotId ?? null)
  // A new group has no server seed yet; a fresh one per dialog gives each group its own look.
  const [avatarSeed] = useState(() => group?.avatarSeed ?? crypto.randomUUID())
  const [color, setColor] = useState<string | null>(group?.color ?? null)
  // The stored shape is sent back untouched (even an older silhouette id) until the user picks a look.
  const [shape, setShape] = useState<AvatarShape>(() => group?.avatarShape ?? getNewGroupAvatarShape(avatarSeed))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const dialog = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    dialog.current?.querySelector<HTMLInputElement>("input")?.focus()
    return () => previous?.focus()
  }, [])
  const avatarPicker = (
    <AvatarPicker
      label={t(channelMode ? "Channel mascot" : "avatar.group")}
      bot={{ id: group?.id ?? avatarSeed, avatarShape: shape, color, avatarSeed }}
      onChange={(v) => {
        if (v.avatarShape) setShape(v.avatarShape)
        if (v.color !== undefined) setColor(v.color)
      }}
    />
  )
  const coordinatorField = (
    <label className="group-field">
      {t(channelMode ? "Channel coordinator" : "Group coordinator")} <span className="muted-copy">{t("optional")}</span>
      <select
        aria-label={t(channelMode ? "Channel coordinator" : "Group coordinator")}
        value={coordinatorBotId ?? ""}
        disabled={saving}
        onChange={(e) => setCoordinator(e.target.value || null)}
      >
        <option value="">{t(channelMode ? "No channel coordinator" : "Sem coordenador")}</option>
        {memberIds.map((id) => (
          <option key={id} value={id}>
            {bots.find((b) => b.id === id)?.name}
          </option>
        ))}
      </select>
    </label>
  )

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
              await onSave({
                name,
                color: color ?? avatarColorFor({ id: avatarSeed, color: null }),
                avatarShape: group ? shape : getNewGroupAvatarShape(avatarSeed, shape),
                memberIds,
                coordinatorBotId,
              })
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
              {!channelMode && <p className="eyebrow">{t("Bots together")}</p>}
              <h2 id="group-modal-title">
                {channelMode ? t(group ? "Edit channel" : "Create channel") : t(group ? "Editar grupo" : "Criar grupo")}
              </h2>
            </div>
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              aria-label={t(channelMode ? "Close channel" : "Close group")}
            >
              ×
            </button>
          </div>
          <p className="muted-copy">
            {t(
              channelMode
                ? "A shared channel. Each bot keeps its own computer and permissions."
                : "A shared group conversation. Each bot keeps its own computer and permissions.",
            )}
          </p>
          <label className="group-field">
            {t(channelMode ? "Channel name" : "Group name")}
            <input
              aria-label={t(channelMode ? "Channel name" : "Group name")}
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={80}
              required
              placeholder={t("Example: Product")}
              disabled={saving}
            />
          </label>
          {!channelMode && avatarPicker}
          <fieldset disabled={saving}>
            <legend>{t(channelMode ? "Channel members" : "Group members · response order")}</legend>
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
                    {!channelMode && memberIds.includes(bot.id) && <small>{memberIds.indexOf(bot.id) + 1}</small>}
                  </label>
                ))}
            </div>
          </fieldset>
          {channelMode ? (
            <Disclosure summary={t("Advanced")}>
              {avatarPicker}
              {coordinatorField}
            </Disclosure>
          ) : (
            coordinatorField
          )}
          <p className="group-routing-note">{t("Os bots só respondem quando você os chama com @nome.")}</p>
          {error && <p role="alert">{error}</p>}
          <div className="group-modal-actions">
            <button type="button" className="button button-quiet" onClick={onClose} disabled={saving}>
              {t("Cancelar")}
            </button>
            <button
              type="submit"
              className="button button-brand"
              disabled={saving || !name.trim() || !memberIds.length}
            >
              {saving
                ? t("Saving…")
                : channelMode
                  ? t(group ? "Save channel" : "Create channel")
                  : t(group ? "Salvar grupo" : "Criar grupo")}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// The server assigns a permanent seed on creation; keep the head and look the user previewed, including after reset.
const getNewGroupAvatarShape = (avatarSeed: string, avatarShape?: AvatarShape): AvatarShape => {
  const profile = avatarProfileFor({ id: avatarSeed, color: null, avatarShape: avatarShape ?? null })

  return `${profile.headShape}:${profile.shape}`
}
