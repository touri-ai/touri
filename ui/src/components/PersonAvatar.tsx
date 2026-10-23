import type { ChannelPerson } from "@touri/contracts"
import { BotAvatar } from "./BotAvatar"

export const PersonAvatar = ({
  person,
  size = 28,
}: {
  person: Pick<ChannelPerson, "id" | "avatarSeed">
  size?: number
}) => <BotAvatar bot={{ id: person.id, color: null, avatarSeed: person.avatarSeed }} size={size} state="idle" still />
