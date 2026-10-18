import { describe, expect, test } from "bun:test"
import { getPrRisk, type PrFacts } from "../../../scripts/pr-risk"

const getPr = (overrides: Partial<PrFacts>): PrFacts => ({
  title: "fix(chat): align the activity summary with the bot name",
  author: "maintainer",
  isDraft: false,
  isCrossRepository: false,
  labels: [],
  files: [],
  maintainers: ["maintainer"],
  ...overrides,
})

const file = (path: string, additions = 3, deletions = 2) => ({ path, additions, deletions })

describe("getPrRisk", () => {
  test("a small visual fix can be merged by the review bot", () => {
    const risk = getPrRisk(
      getPr({ files: [file("ui/src/components/TurnActivity.tsx"), file("ui/src/components/turn-activity.css")] }),
    )
    expect(risk.tier).toBe("merge")
  })

  test("tests and docs only can be merged", () => {
    const risk = getPrRisk(getPr({ files: [file("ui/test/home.test.tsx", 40, 10), file("docs/guide.md")] }))
    expect(risk.tier).toBe("merge")
  })

  test("runtime code needs a maintainer", () => {
    const risk = getPrRisk(getPr({ files: [file("sidecar/src/runtime/codex.ts")] }))
    expect(risk).toEqual({ tier: "review", reasons: ["runtime code: sidecar/src/runtime/codex.ts"] })
  })

  test("a new feature needs a maintainer even when it only touches components", () => {
    const risk = getPrRisk(getPr({ title: "feat(ui): new panel", files: [file("ui/src/components/Panel.tsx")] }))
    expect(risk.tier).toBe("review")
  })

  test("a large component change needs a maintainer", () => {
    const risk = getPrRisk(getPr({ files: [file("ui/src/components/Composer.tsx", 50, 20)] }))
    expect(risk.tier).toBe("review")
  })

  test("outside authors, forks and drafts are never merged by the bot", () => {
    const css = [file("ui/src/app.css")]
    expect(getPrRisk(getPr({ author: "someone", files: css })).tier).toBe("review")
    expect(getPrRisk(getPr({ isCrossRepository: true, files: css })).tier).toBe("review")
    expect(getPrRisk(getPr({ isDraft: true, files: css })).tier).toBe("review")
  })

  test("security, native, CI, dependencies, schema and review rules are dangerous", () => {
    const paths = [
      "sidecar/src/kernel/folder-capability.ts",
      "src-tauri/src/main.rs",
      ".github/workflows/ci.yml",
      "ui/package.json",
      "packages/contracts/schema.sql",
      "REVIEW.md",
      "scripts/pr-risk.ts",
      "sidecar/src/security/vault.ts",
    ]
    const tiers = paths.map((path) => getPrRisk(getPr({ files: [file(path)] })).tier)
    expect(tiers).toEqual(paths.map(() => "danger"))
  })

  test("the security label outranks a harmless diff", () => {
    const risk = getPrRisk(getPr({ labels: ["security"], files: [file("docs/a.md")] }))
    expect(risk).toEqual({ tier: "danger", reasons: ["label security"] })
  })
})
