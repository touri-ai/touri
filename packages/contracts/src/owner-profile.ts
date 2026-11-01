import type { OwnerProfile } from "./types"

/** Bound persisted avatar bytes and reject active content or remote image URLs. */
export const isOwnerProfile = (value: unknown): value is OwnerProfile => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const profile = value as Record<string, unknown>
  if (Object.keys(profile).some((key) => key !== "name" && key !== "avatar")) return false
  if (
    typeof profile.name !== "string" ||
    profile.name.length > 80 ||
    Array.from(profile.name).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  )
    return false
  if (profile.avatar === null) return true
  if (!profile.avatar || typeof profile.avatar !== "object" || Array.isArray(profile.avatar)) return false
  const avatar = profile.avatar as Record<string, unknown>
  if (avatar.kind === "image")
    return (
      Object.keys(avatar).length === 2 &&
      typeof avatar.dataUrl === "string" &&
      avatar.dataUrl.length <= 100_000 &&
      /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/u.test(avatar.dataUrl)
    )
  if (avatar.kind !== "mascot" || Object.keys(avatar).length !== 4) return false

  return (
    typeof avatar.avatarSeed === "string" &&
    avatar.avatarSeed.length > 0 &&
    avatar.avatarSeed.length <= 80 &&
    (avatar.avatarShape === null ||
      (typeof avatar.avatarShape === "string" &&
        /^(?:(?:cercle|galet|squircle|capsule|triangle|hexagone|nuage):)?(?:classic|short|long|none)-(?:none|ring|glasses|headphones|cap|flower|crown)$|^(?:cercle|galet|squircle|capsule|triangle|hexagone|nuage)$/u.test(
          avatar.avatarShape,
        ))) &&
    (avatar.color === null || (typeof avatar.color === "string" && /^#[a-f0-9]{6}$/iu.test(avatar.color)))
  )
}
