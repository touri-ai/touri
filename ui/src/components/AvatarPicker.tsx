import type { AvatarAccessory, AvatarHorns, AvatarShape } from "@touri/contracts"
import {
  AVATAR_ACCESSORIES,
  AVATAR_COLOR_CHOICES,
  AVATAR_HORNS,
  type AvatarIdentity,
  type AvatarMood,
  avatarProfileFor,
  avatarShapeFor,
  getAvatarShapeForLook,
  LEGACY_AVATAR_SHAPES,
} from "@touri/contracts/avatar"
import { memo, useId, useMemo, useState } from "react"
import { type TranslationKey, t } from "../i18n"
import { BotAvatar } from "./BotAvatar"

const HORN_LABEL: Record<AvatarHorns, TranslationKey> = {
  classic: "avatar.horns.classic",
  short: "avatar.horns.short",
  long: "avatar.horns.long",
  none: "avatar.horns.none",
}
const ACCESSORY_LABEL: Record<AvatarAccessory, TranslationKey> = {
  none: "avatar.accessory.none",
  ring: "avatar.accessory.ring",
  glasses: "avatar.accessory.glasses",
  headphones: "avatar.accessory.headphones",
  cap: "avatar.accessory.cap",
  flower: "avatar.accessory.flower",
  crown: "avatar.accessory.crown",
}
const PREVIEW_MOODS: { mood: AvatarMood; label: TranslationKey; line: TranslationKey }[] = [
  { mood: "idle", label: "avatar.preview.idle", line: "avatar.line.idle" },
  { mood: "connecting", label: "avatar.preview.thinking", line: "avatar.line.thinking" },
  { mood: "working", label: "avatar.preview.working", line: "avatar.line.working" },
  { mood: "waiting", label: "avatar.preview.waiting", line: "avatar.line.waiting" },
  { mood: "responded", label: "avatar.preview.done", line: "avatar.line.done" },
  { mood: "failed", label: "avatar.preview.failed", line: "avatar.line.failed" },
  { mood: "asleep", label: "avatar.preview.asleep", line: "avatar.line.asleep" },
]

export type AvatarChoice = { avatarShape: AvatarShape; color: string | null }
export const AvatarPicker = ({
  bot,
  name,
  label = t("Avatar"),
  description = t("Make it yours"),
  onChange: saveChoice,
}: {
  bot: AvatarIdentity
  name?: string
  label?: string
  description?: string
  onChange: (choice: Partial<AvatarChoice>) => void
}) => {
  const profile = avatarProfileFor(bot)
  const hornPreviews = useMemo(
    () => AVATAR_HORNS.map((horns) => ({ horns, bot: getPreviewBot(bot, horns, "none") })),
    [bot],
  )
  const accessoryPreviews = useMemo(
    () => AVATAR_ACCESSORIES.map((accessory) => ({ accessory, bot: getPreviewBot(bot, profile.horns, accessory) })),
    [bot, profile.horns],
  )
  const group = useId()
  const [mood, setMood] = useState<AvatarMood>("idle")
  // Each new look remounts the preview so it plays its one-pixel hop again.
  const [changes, setChanges] = useState(0)
  const onChange = (choice: Partial<AvatarChoice>): void => {
    setChanges((count) => count + 1)
    saveChoice(choice)
  }
  const line = PREVIEW_MOODS.find((item) => item.mood === mood)?.line ?? "avatar.line.idle"
  const shuffle = (): void =>
    onChange({
      color: getRandomItem(AVATAR_COLOR_CHOICES).hex,
      avatarShape: getAvatarShapeForLook(bot, getRandomItem(AVATAR_HORNS), getRandomItem(AVATAR_ACCESSORIES)),
    })
  const reset = (): void =>
    onChange({
      color: null,
      avatarShape: getAutomaticShape(bot),
    })

  return (
    <fieldset className="avatar-picker">
      <legend>{label}</legend>
      <div className="avatar-picker-layout">
        <div className="avatar-picker-preview">
          <div className="avatar-picker-stage">
            <span key={changes} className={changes ? "avatar-picker-hop" : undefined}>
              <BotAvatar bot={bot} size={96} mood={mood} motion="always" followPointer />
            </span>
          </div>
          <fieldset className="avatar-picker-moods" aria-label={t("avatar.preview")}>
            {PREVIEW_MOODS.map((item) => (
              <label key={item.mood}>
                <input
                  type="radio"
                  className="avatar-choice"
                  name={`${group}-mood`}
                  checked={mood === item.mood}
                  onChange={() => setMood(item.mood)}
                />
                {t(item.label)}
              </label>
            ))}
          </fieldset>
          {name && (
            <div className="avatar-picker-in-app">
              <span>{t("avatar.inApp")}</span>
              <div className="avatar-picker-row">
                <BotAvatar bot={bot} size={32} mood={mood} motion="always" />
                <span>
                  <strong>{name}</strong>
                  <small>{t(line)}</small>
                </span>
              </div>
              <div className="avatar-picker-pill">
                <BotAvatar bot={bot} size={16} mood={mood} motion="always" />
                <span>{name}</span>
              </div>
            </div>
          )}
        </div>
        <div className="avatar-picker-controls">
          <div className="avatar-picker-heading">
            <span>{description}</span>
            <button type="button" className="avatar-picker-shuffle" onClick={shuffle}>
              <svg
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5" />
              </svg>
              {t("avatar.shuffle")}
            </button>
          </div>
          <fieldset className="avatar-colors">
            <legend>{t("Color")}</legend>
            <div>
              <label className="avatar-color-auto">
                <input
                  type="radio"
                  className="avatar-choice"
                  name={`${group}-color`}
                  aria-label={t("Avatar color", { color: t("Automatic") })}
                  checked={bot.color === null}
                  onChange={() => onChange({ color: null })}
                />
                A
              </label>
              {AVATAR_COLOR_CHOICES.map((color) => (
                <label key={color.hue} style={{ backgroundColor: color.hex }}>
                  <input
                    type="radio"
                    className="avatar-choice"
                    name={`${group}-color`}
                    aria-label={t("Avatar color", { color: t(color.label) })}
                    checked={bot.color !== null && profile.color === color.hex}
                    onChange={() => onChange({ color: color.hex })}
                  />
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset className="avatar-options avatar-horns">
            <legend>{t("avatar.horns")}</legend>
            <div>
              {hornPreviews.map(({ horns, bot: preview }) => (
                <label key={horns} title={t(HORN_LABEL[horns])}>
                  <input
                    type="radio"
                    className="avatar-choice"
                    name={`${group}-horns`}
                    aria-label={t("avatar.horns.choice", { horns: t(HORN_LABEL[horns]) })}
                    checked={profile.horns === horns}
                    onChange={() => onChange({ avatarShape: getAvatarShapeForLook(bot, horns, profile.accessory) })}
                  />
                  <AvatarThumbnail bot={preview} size={48} mood="idle" still />
                  <span aria-hidden="true">{t(HORN_LABEL[horns])}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset className="avatar-options avatar-accessories">
            <legend>{t("avatar.accessory")}</legend>
            <div>
              {accessoryPreviews.map(({ accessory, bot: preview }) => (
                <label key={accessory} title={t(ACCESSORY_LABEL[accessory])}>
                  <input
                    type="radio"
                    className="avatar-choice"
                    name={`${group}-accessory`}
                    aria-label={t("avatar.accessory.choice", { accessory: t(ACCESSORY_LABEL[accessory]) })}
                    checked={profile.accessory === accessory}
                    onChange={() => onChange({ avatarShape: getAvatarShapeForLook(bot, profile.horns, accessory) })}
                  />
                  <AvatarThumbnail bot={preview} size={40} mood="idle" still />
                  <span aria-hidden="true">{t(ACCESSORY_LABEL[accessory])}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <button type="button" className="avatar-picker-reset" onClick={reset}>
            {t("avatar.reset")}
          </button>
        </div>
      </div>
    </fieldset>
  )
}

const AvatarThumbnail = memo(BotAvatar)

const getPreviewBot = (bot: AvatarIdentity, horns: AvatarHorns, accessory: AvatarAccessory): AvatarIdentity => ({
  id: bot.id,
  color: bot.color,
  avatarSeed: bot.avatarSeed ?? null,
  avatarPath: bot.avatarPath ?? null,
  avatarHue: bot.avatarHue ?? null,
  avatarShape: getAvatarShapeForLook(bot, horns, accessory),
})

const getAutomaticShape = (bot: AvatarIdentity): AvatarShape => {
  const head = LEGACY_AVATAR_SHAPES.find(
    (shape) => bot.avatarShape === shape || bot.avatarShape?.startsWith(`${shape}:`),
  )
  if (head) return head

  return avatarShapeFor({ id: bot.id, avatarSeed: bot.avatarSeed ?? null, color: null })
}

const getRandomItem = <Item,>(items: readonly Item[]): Item => {
  const item = items[Math.floor(Math.random() * items.length)] ?? items[0]
  if (item === undefined) throw new Error("Cannot pick from an empty list")

  return item
}
