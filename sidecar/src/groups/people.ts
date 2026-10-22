import type { ChannelPerson } from "@touri/contracts"

export const getPersonHandle = (name: string, accountName: string): string => {
  const displayName = name.trim()
  if (displayName && !/^(você|you|owner)$/iu.test(displayName)) return displayName

  return accountName.trim().slice(0, 80) || "owner"
}

type MentionIdentity = Pick<ChannelPerson, "id" | "name" | "handle">
type MentionIndex<Person> = { children: Map<string, MentionIndex<Person>>; person: Person | null }

/** A character index keeps longest-name matching linear in the roster and message size. */
export const getMentionedPeople = <Person extends MentionIdentity>(
  text: string,
  people: readonly Person[],
): Person[] => {
  const normalized = getNormalized(text.slice(0, 64_000))
  const index = getMentionIndex(people)
  const mentions = Array.from(normalized.matchAll(/(?:^|[^\p{L}\p{N}_@.-])@/gu)).slice(0, 128)
  const matches = mentions.flatMap((mention) => {
    const person = getMentionMatch(normalized, mention.index + mention[0].length, index)
    return person ? [person] : []
  })

  return Array.from(new Map(matches.map((person) => [person.id, person])).values())
}

const getMentionIndex = <Person extends MentionIdentity>(people: readonly Person[]): MentionIndex<Person> => {
  const root: MentionIndex<Person> = { children: new Map(), person: null }
  // Mutate only this fresh index: rebuilding immutable paths for every character would waste the live-path budget.
  getMentionTokens(people).forEach(({ token, person }) => {
    let node = root
    token.split("").forEach((character) => {
      const child: MentionIndex<Person> = node.children.get(character) ?? { children: new Map(), person: null }
      node.children.set(character, child)
      node = child
    })
    node.person ??= person
  })

  return root
}

const getMentionTokens = <Person extends MentionIdentity>(people: readonly Person[]) =>
  people.flatMap((person) =>
    Array.from(new Set([person.handle ?? person.name, person.name]))
      .filter((name) => name.trim())
      .flatMap((name) => {
        const normalized = getNormalized(name.trim())
        return [normalized, JSON.stringify(normalized)].map((token) => ({ token, person }))
      }),
  )

const getMentionMatch = <Person>(text: string, start: number, index: MentionIndex<Person>): Person | null => {
  let node = index
  let matched: Person | null = null
  for (let offset = start; offset < text.length; offset++) {
    const next = node.children.get(text[offset] ?? "")
    if (!next) break
    node = next
    if (node.person && !/[\p{L}\p{N}_-]/u.test(text[offset + 1] ?? "")) matched = node.person
  }

  return matched
}

const getNormalized = (value: string): string => value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase()
