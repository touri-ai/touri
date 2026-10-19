import { validAvatarColor, validAvatarShape } from "./avatar"
import { normalizeBotName } from "./bot-name"
import type { TeamProposalReview } from "./types"

/** UI guard uses no generated validators, so it also works under the desktop CSP. */
export const getTeamProposalReview = (value: unknown): TeamProposalReview | null => {
  const review = getRecord(value)
  const proposal = getRecord(review?.proposal)
  if (
    !proposal ||
    !hasOnly(proposal, ["bots", "group"]) ||
    !Array.isArray(proposal.bots) ||
    !proposal.bots.length ||
    proposal.bots.length > 8
  )
    return null
  const bots = proposal.bots.map(getRecord)
  if (
    bots.some(
      (bot) =>
        !bot ||
        !hasOnly(bot, [
          "name",
          "provider",
          "roleLine",
          "instructions",
          "model",
          "color",
          "avatarShape",
          "avatarSeed",
        ]) ||
        !normalizeBotName(bot.name) ||
        hasTeamHiddenCharacters(bot.name) ||
        !["codex", "claude", "opencode"].includes(String(bot.provider)) ||
        !isText(bot.roleLine, 160) ||
        hasTeamHiddenCharacters(bot.roleLine) ||
        /[\p{Zl}\p{Zp}]/u.test(bot.roleLine) ||
        !isText(bot.instructions, 12000) ||
        hasTeamHiddenCharacters(bot.instructions, true) ||
        (bot.model != null && (typeof bot.model !== "string" || bot.model.length > 200)) ||
        (bot.color != null && !validAvatarColor(bot.color)) ||
        (bot.avatarShape != null && !validAvatarShape(bot.avatarShape)) ||
        (bot.avatarSeed != null &&
          (typeof bot.avatarSeed !== "string" || !bot.avatarSeed.length || bot.avatarSeed.length > 200)),
    )
  )
    return null
  const names = bots.map((bot) => normalizeBotName(bot?.name))
  if (new Set(names.map((name) => name?.toLocaleLowerCase())).size !== bots.length) return null
  if (proposal.group !== undefined) {
    const group = getRecord(proposal.group)
    if (
      !group ||
      !hasOnly(group, ["name", "members", "coordinator"]) ||
      !normalizeBotName(group.name) ||
      hasTeamHiddenCharacters(group.name) ||
      !Array.isArray(group.members) ||
      !group.members.length ||
      group.members.length > 8 ||
      new Set(group.members).size !== group.members.length ||
      group.members.some((name) => !names.includes(name)) ||
      (group.coordinator !== undefined && !group.members.includes(group.coordinator))
    )
      return null
  }
  const providers = review?.providers
  if (
    !Array.isArray(providers) ||
    providers.length > 3 ||
    bots.some(
      (bot) =>
        !providers.some((item: unknown) => {
          const provider = getRecord(item)
          return (
            provider?.provider === bot?.provider &&
            ["ready", "needs-setup", "unknown"].includes(String(provider?.status))
          )
        }),
    )
  )
    return null
  return value as TeamProposalReview
}

export const hasTeamHiddenCharacters = (value: unknown, multiline = false): boolean => {
  if (typeof value !== "string") return false

  // Only pictographic emoji sequences may carry a single VS16 or a joiner between their elements.
  const visible = value.replace(
    /\p{Extended_Pictographic}\uFE0F?\p{Emoji_Modifier}?(?:\u200D\p{Extended_Pictographic}\uFE0F?\p{Emoji_Modifier}?)*/gu,
    "",
  )
  const text = multiline ? visible.replace(/[\t\n\r]/g, "") : visible

  return /[\p{Default_Ignorable_Code_Point}\p{Cf}\p{Cc}]/u.test(text)
}

const getRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null
const isText = (value: unknown, max: number): value is string =>
  typeof value === "string" && !!value.trim() && value.length <= max
const hasOnly = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).every((key) => keys.includes(key))
