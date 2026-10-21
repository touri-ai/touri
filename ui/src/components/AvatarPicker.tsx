import type { AvatarAccessory, AvatarHorns, AvatarShape } from "@touri/contracts"
import {
  AVATAR_ACCESSORIES,
  AVATAR_COLOR_CHOICES,
  AVATAR_HORNS,
  type AvatarIdentity,
  avatarProfileFor,
  avatarShapeFor,
  getAvatarShapeForLook,
  LEGACY_AVATAR_SHAPES,
} from "@touri/contracts/avatar"
import { memo, useId, useState } from "react"
import { type Locale, type TranslationKey, t } from "../i18n"
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
export type AvatarChoice = { avatarShape: AvatarShape; color: string | null }
export const AvatarPicker = ({
  bot,
  locale = "pt-BR",
  label = t("Avatar", {}, locale),
  onChange: saveChoice,
}: {
  bot: AvatarIdentity
  label?: string
  locale?: Locale
  onChange: (choice: Partial<AvatarChoice>) => void
}) => {
  const getText = (key: TranslationKey, params: Record<string, string> = {}) => t(key, params, locale)
  const profile = avatarProfileFor(bot)
  const group = useId()
  const [customizing, setCustomizing] = useState(false)
  // Each new look remounts the preview so it plays its one-pixel hop again.
  const [changes, setChanges] = useState(0)
  const onChange = (choice: Partial<AvatarChoice>): void => {
    setChanges((count) => count + 1)
    saveChoice(choice)
  }
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
              <BotAvatar bot={bot} size={48} mood="idle" motion="always" followPointer />
            </span>
          </div>
        </div>
        <div className="avatar-picker-actions">
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
            {getText("avatar.shuffle")}
          </button>
          <button
            type="button"
            className="avatar-picker-customize"
            aria-expanded={customizing}
            aria-controls={`${group}-customize`}
            onClick={() => setCustomizing((current) => !current)}
          >
            {getText("avatar.customize")}
          </button>
        </div>
      </div>
      <div id={`${group}-customize`} hidden={!customizing}>
        {customizing && (
          <div className="avatar-picker-controls">
            <fieldset className="avatar-colors">
              <legend>{getText("Color")}</legend>
              <div>
                <label className="avatar-color-auto">
                  <input
                    type="radio"
                    className="avatar-choice"
                    name={`${group}-color`}
                    aria-label={getText("Avatar color", { color: getText("Automatic") })}
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
                      aria-label={getText("Avatar color", { color: getText(color.label) })}
                      checked={bot.color !== null && profile.color === color.hex}
                      onChange={() => onChange({ color: color.hex })}
                    />
                  </label>
                ))}
              </div>
            </fieldset>
            <fieldset className="avatar-options avatar-horns">
              <legend>{getText("avatar.horns")}</legend>
              <div>
                {AVATAR_HORNS.map((horns) => (
                  <label key={horns} title={getText(HORN_LABEL[horns])}>
                    <input
                      type="radio"
                      className="avatar-choice"
                      name={`${group}-horns`}
                      aria-label={getText("avatar.horns.choice", { horns: getText(HORN_LABEL[horns]) })}
                      checked={profile.horns === horns}
                      onChange={() => onChange({ avatarShape: getAvatarShapeForLook(bot, horns, profile.accessory) })}
                    />
                    <AvatarThumbnail bot={getPreviewBot(bot, horns, "none")} size={48} mood="idle" still />
                    <span aria-hidden="true">{getText(HORN_LABEL[horns])}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            <fieldset className="avatar-options avatar-accessories">
              <legend>{getText("avatar.accessory")}</legend>
              <div>
                {AVATAR_ACCESSORIES.map((accessory) => (
                  <label key={accessory} title={getText(ACCESSORY_LABEL[accessory])}>
                    <input
                      type="radio"
                      className="avatar-choice"
                      name={`${group}-accessory`}
                      aria-label={getText("avatar.accessory.choice", {
                        accessory: getText(ACCESSORY_LABEL[accessory]),
                      })}
                      checked={profile.accessory === accessory}
                      onChange={() => onChange({ avatarShape: getAvatarShapeForLook(bot, profile.horns, accessory) })}
                    />
                    <AvatarThumbnail bot={getPreviewBot(bot, profile.horns, accessory)} size={40} mood="idle" still />
                    <span aria-hidden="true">{getText(ACCESSORY_LABEL[accessory])}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            <button type="button" className="avatar-picker-reset" onClick={reset}>
              {getText("avatar.reset")}
            </button>
          </div>
        )}
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
