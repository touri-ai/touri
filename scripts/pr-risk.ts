/**
 * Risk tier of a pull request, from its changed paths and size alone — no model involved.
 *
 *   merge   low risk: the review bot may merge it itself once checks are green and its review has
 *           no 🔴 Important finding (visual polish, tests, docs, copy).
 *   review  a maintainer approves: new features, runtime behaviour, API contracts, larger diffs.
 *   danger  a maintainer reviews with care: security boundaries, credentials, native shell,
 *           release/CI, dependencies, storage schema.
 *
 * A model review can only move a pull request to a stricter tier, never to a looser one.
 * The rules mirror REVIEW.md. Usage:
 *   gh pr view <n> --json title,author,isDraft,isCrossRepository,labels,files | bun scripts/pr-risk.ts
 */

export type RiskTier = "merge" | "review" | "danger"

export type PrFile = { path: string; additions: number; deletions: number }

export type PrFacts = {
  title: string
  author: string
  isDraft: boolean
  isCrossRepository: boolean
  labels: Array<string>
  files: Array<PrFile>
  maintainers: Array<string>
}

export type PrRisk = { tier: RiskTier; reasons: Array<string> }

// danger: changes that can open a security hole, leak credentials, break installs or releases
const DANGER_PATHS: Array<[RegExp, string]> = [
  [/^src-tauri\//, "native shell (src-tauri)"],
  [/^\.github\//, "CI or repository automation"],
  [/(^|\/)package\.json$|^bun\.lockb?$/, "dependencies"],
  [/^scripts\/(build|release|sign)|^scripts\/.*\.(sh|py)$/, "build, signing or release script"],
  [/(^|\/)(security|sandbox|vault|keychain|credential|secret|auth|pairing|token)[^/]*(\/|\.)/i, "security boundary"],
  [/folder-capability|folder-sandbox|approval|egress|permission/i, "access control"],
  [/(^|\/)(schema\.sql|migrations?\/)/, "storage schema"],
  [/^(REVIEW|CLAUDE|AGENTS|SECURITY)\.md$|^scripts\/pr-risk\.ts$/, "review or agent rules"],
]

// merge: paths whose changes cannot alter runtime behaviour or are presentation only
const MERGE_PATHS: Array<[RegExp, string]> = [
  [/\.css$/, "styles"],
  [/^docs\/|\.md$/, "documentation"],
  [/^(ui|sidecar)\/test\/|\.test\.tsx?$|\.spec\.tsx?$/, "tests"],
  [/^ui\/src\/components\/.*\.tsx$/, "UI component"],
  [/\.(png|svg|jpg|webp|ico)$/, "image asset"],
]

const MERGE_MAX_LINES = 150
const COMPONENT_MAX_LINES = 60
const FEATURE_TITLE = /^feat(\(|:|!)/

const getLines = (files: Array<PrFile>) => files.reduce((sum, file) => sum + file.additions + file.deletions, 0)

const getDangerReasons = (files: Array<PrFile>) =>
  files.flatMap((file) =>
    DANGER_PATHS.filter(([pattern]) => pattern.test(file.path)).map(([, why]) => `${why}: ${file.path}`),
  )

const getMergeKind = (path: string) => MERGE_PATHS.find(([pattern]) => pattern.test(path))?.[1]

const getReviewReasons = (pr: PrFacts) => {
  const outside = pr.files.filter((file) => !getMergeKind(file.path)).map((file) => `runtime code: ${file.path}`)
  const components = pr.files.filter((file) => getMergeKind(file.path) === "UI component")
  const bigComponents = components
    .filter((file) => file.additions + file.deletions > COMPONENT_MAX_LINES)
    .map((file) => `component change over ${COMPONENT_MAX_LINES} lines: ${file.path}`)
  const lines = getLines(pr.files)
  return [
    ...(FEATURE_TITLE.test(pr.title) ? ["new feature (feat)"] : []),
    ...(pr.isCrossRepository ? ["pull request from a fork"] : []),
    ...(pr.maintainers.includes(pr.author) ? [] : [`author ${pr.author} is not a maintainer`]),
    ...(lines > MERGE_MAX_LINES ? [`${lines} changed lines (over ${MERGE_MAX_LINES})`] : []),
    ...(pr.files.length === 0 ? ["no changed files reported"] : []),
    ...outside,
    ...bigComponents,
  ]
}

export const getPrRisk = (pr: PrFacts): PrRisk => {
  const flagged = pr.labels.filter((label) => label === "security" || label === "needs-maintainer")
  const danger = [...flagged.map((label) => `label ${label}`), ...getDangerReasons(pr.files)]
  if (danger.length) return { tier: "danger", reasons: danger }
  if (pr.isDraft) return { tier: "review", reasons: ["draft"] }
  const review = getReviewReasons(pr)
  if (review.length) return { tier: "review", reasons: review }
  const kinds = [...new Set(pr.files.map((file) => getMergeKind(file.path)))]
  return { tier: "merge", reasons: [`only ${kinds.join(", ")}; ${getLines(pr.files)} changed lines`] }
}

type GhPr = {
  title: string
  author: { login: string }
  isDraft: boolean
  isCrossRepository: boolean
  labels: Array<{ name: string }>
  files: Array<PrFile>
}

const getMaintainers = (env: Record<string, string | undefined>) =>
  (env.TOURI_MAINTAINERS ?? "Thiago-Mota-Santos").split(",").map((login) => login.trim())

export const getPrFacts = (pr: GhPr, env: Record<string, string | undefined> = process.env): PrFacts => ({
  title: pr.title,
  author: pr.author.login,
  isDraft: pr.isDraft,
  isCrossRepository: pr.isCrossRepository,
  labels: pr.labels.map((label) => label.name),
  files: pr.files,
  maintainers: getMaintainers(env),
})

if (import.meta.main) {
  const input = await Bun.stdin.text()
  console.log(JSON.stringify(getPrRisk(getPrFacts(JSON.parse(input))), null, 2))
}
