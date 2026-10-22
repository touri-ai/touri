import { expect, test } from "bun:test"
import type { ChannelPerson } from "@touri/contracts"
import { getMentionedPeople, getPersonHandle } from "../../src/groups/people"

const getPeople = (): ChannelPerson[] => [
  { id: "owner", name: "Você", handle: "thiago", avatarSeed: "owner", role: "admin" },
  { id: "ana", name: "Ana", handle: "Ana", avatarSeed: "ana", role: "member" },
  { id: "ana-maria", name: "Ána Maria", handle: "Ána Maria", avatarSeed: "ana-maria", role: "member" },
]

test("matching is accent/case insensitive, longest first, quoted, unique and preserves mention order", () => {
  const people = getPeople()

  const mentions = getMentionedPeople('@ANA MARIA, @"thiágo" @Ana @ana', people)

  expect(mentions.map(({ id }) => id)).toEqual(["ana-maria", "owner", "ana"])
  expect(getMentionedPeople("@Ana-Maria @Anabela @Ana_foo", people)).toEqual([])
})

test.each(["Você", "", "You", "Owner"])("a generic owner display name %s uses the account handle", (name) => {
  expect(getPersonHandle(name, "thiago")).toBe("thiago")
  expect(getPersonHandle("Ána Maria", "synthetic-account")).toBe("Ána Maria")
})

test("mention matching stays responsive with a full roster and a long message", () => {
  const people = Array.from({ length: 500 }, (_, index) => ({ id: String(index), name: `pessoa${index}` }))
  const text = `${"x".repeat(62_000)}${people
    .slice(0, 100)
    .map(({ name }) => ` @${name}`)
    .join("")}`
  const samples = Array.from({ length: 50 }, () => {
    const started = process.cpuUsage()
    const matches = getMentionedPeople(text, people)
    const elapsed = process.cpuUsage(started)
    expect(matches).toHaveLength(100)

    return (elapsed.user + elapsed.system) / 1000
  })
  // Sort only the fresh measurement samples to report the CPU percentile.
  const p99 = samples.sort((first, second) => first - second)[49] ?? 0

  console.info(`Mention matcher: 500 people, 100 mentions, 63k characters, 50 samples, CPU p99 ${p99.toFixed(2)}ms`)
  expect(p99).toBeLessThan(50)
})
