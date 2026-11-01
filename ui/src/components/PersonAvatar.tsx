import type { ChannelPerson, OwnerAvatar } from "@touri/contracts"
import { BotAvatar } from "./BotAvatar"

export const PersonAvatar = ({
  person,
  avatar,
  size = 28,
}: {
  person: Pick<ChannelPerson, "id" | "avatarSeed"> & { name?: string }
  avatar?: OwnerAvatar | null | undefined
  size?: number
}) => {
  if (avatar === undefined)
    return (
      <BotAvatar bot={{ id: person.id, color: null, avatarSeed: person.avatarSeed }} size={size} state="idle" still />
    )
  if (avatar?.kind === "image")
    return <img className="person-avatar" src={avatar.dataUrl} alt="" width={size} height={size} />
  if (avatar?.kind === "mascot") return <BotAvatar bot={{ id: person.id, ...avatar }} size={size} state="idle" still />

  const initials = (person.name?.trim() || person.id)
    .split(/\s+/u)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toLocaleUpperCase()
  return (
    <span
      className="person-avatar person-initials"
      style={{ width: size, height: size }}
      aria-hidden="true"
      title={person.name}
    >
      {initials}
    </span>
  )
}
