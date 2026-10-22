import type { ChannelPerson } from "@touri/contracts"

export const getPersonHandle = (name: string, accountName: string): string => {
  const displayName = name.trim()
  if (displayName && !/^(você|you|owner)$/iu.test(displayName)) return displayName

  return accountName.trim().slice(0, 80) || "owner"
}

type MentionIdentity = Pick<ChannelPerson, "id" | "name" | "handle">

/** Match complete names before prefixes, without treating person mentions as bot requests. */
export const getMentionedPeople = <Person extends MentionIdentity>(
  text: string,
  people: readonly Person[],
): Person[] => {
  const normalized = getNormalized(text.slice(0, 64_000))
  const candidates = people.flatMap((person) =>
    Array.from(new Set([person.handle ?? person.name, person.name]))
      .filter((name) => name.trim())
      .map((name) => ({ person, name: getNormalized(name.trim()) })),
  )
  // Sort only newly derived candidates; channel identities remain unchanged.
  candidates.sort((first, second) => second.name.length - first.name.length)
  const mentions = Array.from(normalized.matchAll(/(?:^|[^\p{L}\p{N}_@.-])@/gu)).slice(0, 128)
  const matches = mentions.flatMap((mention) => {
    const start = mention.index + mention[0].length
    const candidate = candidates.find(({ name }) => {
      const token = normalized[start] === '"' ? JSON.stringify(name) : name
      if (!normalized.startsWith(token, start)) return false

      return !/[\p{L}\p{N}_-]/u.test(normalized[start + token.length] ?? "")
    })
    return candidate ? [candidate.person] : []
  })

  return Array.from(new Map(matches.map((person) => [person.id, person])).values())
}

const getNormalized = (value: string): string => value.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase()
