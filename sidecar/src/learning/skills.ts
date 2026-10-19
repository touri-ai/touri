import { existsSync, readdirSync, readFileSync } from "node:fs"
import { mkdir, rename } from "node:fs/promises"
import { join } from "node:path"
import { appendPrivateFileAsync } from "../kernel/async-files"
import { sha256 } from "../runtime/utils"
import { linkFree, writeAtomically } from "./paths"
import { findThreat } from "./threats"

export const SKILL_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/
const SUPPORT_PATH = /^(references|templates|scripts|assets)(\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}){1,4}$/
const SKILL_TRIGGER = /^(use when|use quando|usar quando)\b/i
export const SKILL_LIMITS = { description: 1_024, body: 100_000, supportFile: 1_048_576 } as const

export type SkillOrigin = "chat" | "review"
export type SkillResult = { success: true; message: string } | { success: false; errorCode: string; error: string }

const failure = (errorCode: string, error: string): SkillResult => ({ success: false, errorCode, error })

export const skillsRoot = (homeDir: string): string => join(homeDir, "skills")

export const countSkills = (homeDir: string): number => {
  try {
    return readdirSync(skillsRoot(homeDir), { withFileTypes: true }).filter(
      (entry) => entry.isDirectory() && !entry.name.startsWith("."),
    ).length
  } catch {
    return 0
  }
}

const writableLedger = (homeDir: string): boolean =>
  linkFree(homeDir, join(skillsRoot(homeDir), ".ledger.jsonl"), "file")

const getSkillText = (path: string): string | null => {
  try {
    return readFileSync(path, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
}

/** Append-only record of every change, so the user can see what was learned and from where. */
const record = async ({
  homeDir,
  entry,
}: {
  homeDir: string
  entry: {
    action: string
    skill: string
    file: string
    origin: SkillOrigin
    threadId: string
    before: string | null
    after: string | null
  }
}): Promise<void> => {
  await appendPrivateFileAsync({
    root: skillsRoot(homeDir),
    path: join(skillsRoot(homeDir), ".ledger.jsonl"),
    content: `${JSON.stringify({
      at: new Date().toISOString(),
      action: entry.action,
      skill: entry.skill,
      file: entry.file,
      origin: entry.origin,
      threadId: entry.threadId,
      before: entry.before === null ? null : sha256(entry.before),
      after: entry.after === null ? null : sha256(entry.after),
    })}\n`,
    mode: 0o600,
  })
}

/** Decode generated JSON quotes while preserving the text of legacy YAML scalars. */
export const getSkillDescription = (value: string): string => {
  if (!value.startsWith('"')) return value
  try {
    const decoded: unknown = JSON.parse(value)
    return typeof decoded === "string" ? decoded : value
  } catch {
    return value
  }
}

export const renderSkill = ({ name, description, body }: { name: string; description: string; body: string }) =>
  `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n${body.trim()}\n`

export const validateNewSkill = ({
  homeDir,
  name,
  description,
  body,
}: {
  homeDir: string
  name: string
  description: string
  body: string
}): SkillResult | null => {
  if (!SKILL_NAME.test(name)) return failure("INVALID_ARGS", "Use letras minúsculas, dígitos, '-' ou '_' no nome.")
  const trigger = description.trim()
  if (!trigger || trigger.length > SKILL_LIMITS.description || /[\r\n]/.test(trigger))
    return failure("INVALID_ARGS", "A descrição deve ter uma linha de até 1024 caracteres.")
  if (!SKILL_TRIGGER.test(trigger))
    return failure("INVALID_ARGS", "Comece a descrição com 'Use when' dizendo quando carregar a skill.")
  if (!body.trim() || body.length > SKILL_LIMITS.body)
    return failure("INVALID_ARGS", "O corpo deve ter até 100 mil caracteres.")
  const threat = findThreat(`${trigger}\n${body}`, "skill")
  if (threat) return failure("UNSAFE_CONTENT", `Skill recusada: ${threat}.`)
  const root = skillsRoot(homeDir)
  const dir = join(root, name)
  if (!linkFree(homeDir, dir) || !writableLedger(homeDir))
    return failure("INVALID_PATH", "O caminho da skill não é permitido.")
  if (existsSync(dir)) return failure("EXISTS", `A skill ${name} já existe; use skill_patch.`)
  return null
}

export const createSkill = async ({
  homeDir,
  name,
  description,
  body,
  origin,
  threadId,
}: {
  homeDir: string
  name: string
  description: string
  body: string
  origin: SkillOrigin
  threadId: string
}): Promise<SkillResult> => {
  const invalid = validateNewSkill({ homeDir, name, description, body })
  if (invalid) return invalid
  const content = renderSkill({ name, description: description.trim(), body })
  await writeAtomically(join(skillsRoot(homeDir), name, "SKILL.md"), content)
  await record({
    homeDir,
    entry: { action: "create", skill: name, file: "SKILL.md", origin, threadId, before: null, after: content },
  })
  return { success: true, message: `Skill ${name} criada. Esta alteração está concluída; não repita.` }
}

export type SkillPatch = { name: string; old_string: string; new_string: string; file_path?: string }

/** Validates a patch and returns the file it would write, without writing it. */
export const planSkillPatch = ({
  homeDir,
  patch,
}: {
  homeDir: string
  patch: SkillPatch
}):
  | { success: true; path: string; file: string; before: string | null; after: string }
  | (SkillResult & { success: false }) => {
  const fail = (errorCode: string, error: string) => ({ success: false as const, errorCode, error })
  if (!SKILL_NAME.test(patch.name)) return fail("INVALID_ARGS", "Nome de skill inválido.")
  const root = skillsRoot(homeDir)
  const dir = join(root, patch.name)
  if (!linkFree(homeDir, dir) || !existsSync(join(dir, "SKILL.md")))
    return fail("NOT_FOUND", `A skill ${patch.name} não existe.`)
  const file = patch.file_path?.trim() || "SKILL.md"
  if (file !== "SKILL.md" && !SUPPORT_PATH.test(file))
    return fail("INVALID_PATH", "Arquivos de apoio ficam em references/, templates/, scripts/ ou assets/.")
  const path = join(dir, file)
  if (!linkFree(homeDir, path, "file") || !linkFree(homeDir, join(dir, "SKILL.md"), "file") || !writableLedger(homeDir))
    return fail("INVALID_PATH", "O caminho do arquivo não é permitido.")
  const before = getSkillText(path)
  let after: string
  if (before === null) {
    if (file === "SKILL.md" || patch.old_string !== "") return fail("NOT_FOUND", `O arquivo ${file} não existe.`)
    after = patch.new_string
  } else {
    if (!patch.old_string) return fail("INVALID_ARGS", "Informe old_string com um trecho do arquivo.")
    const count = before.split(patch.old_string).length - 1
    if (count === 0) return fail("NO_MATCH", "old_string não aparece no arquivo.")
    if (count > 1) return fail("AMBIGUOUS_MATCH", `old_string aparece ${count} vezes; use um trecho mais longo.`)
    after = before.replace(patch.old_string, () => patch.new_string)
  }
  const limit = file === "SKILL.md" ? SKILL_LIMITS.body + SKILL_LIMITS.description * 2 + 256 : SKILL_LIMITS.supportFile
  if (after.length > limit) return fail("TOO_LARGE", `O arquivo passaria do limite de ${limit} caracteres.`)
  if (file === "SKILL.md" && !after.startsWith(`---\nname: ${patch.name}\n`))
    return fail("INVALID_ARGS", "Mantenha o cabeçalho name/description no início do SKILL.md.")
  if (file === "SKILL.md" && !/^description:\s*\S/m.test(after))
    return fail("INVALID_ARGS", "O SKILL.md precisa de uma linha description.")
  let inspected = after
  if (file === "SKILL.md") {
    const header = after.match(/^---\nname: [a-z0-9_-]+\ndescription: ([^\r\n]+)\n---\n/)
    if (
      !header ||
      !SKILL_TRIGGER.test(getSkillDescription(header[1]?.trim() ?? "")) ||
      getSkillDescription(header[1]?.trim() ?? "").length > SKILL_LIMITS.description
    )
      return fail("INVALID_ARGS", "Mantenha o cabeçalho e uma descrição começando com 'Use when'.")
    const description = getSkillDescription(header[1]?.trim() ?? "")
    if (/[\r\n]/.test(description)) return fail("INVALID_ARGS", "A descrição deve ter uma linha.")
    const body = after.slice(header[0].length).trim()
    inspected = `${description}\n${body}`
    if (!body || body.length > SKILL_LIMITS.body)
      return fail("INVALID_ARGS", "O corpo deve ter até 100 mil caracteres.")
  }
  const threat = findThreat(inspected, "skill")
  if (threat) return fail("UNSAFE_CONTENT", `Alteração recusada: ${threat}.`)
  return { success: true, path, file, before, after }
}

export const patchSkill = async ({
  homeDir,
  patch,
  origin,
  threadId,
}: {
  homeDir: string
  patch: SkillPatch
  origin: SkillOrigin
  threadId: string
}): Promise<SkillResult> => {
  const plan = planSkillPatch({ homeDir, patch })
  if (!plan.success) return plan
  await writeAtomically(plan.path, plan.after)
  await record({
    homeDir,
    entry: {
      action: "patch",
      skill: patch.name,
      file: plan.file,
      origin,
      threadId,
      before: plan.before,
      after: plan.after,
    },
  })
  return { success: true, message: `Skill ${patch.name} atualizada. Esta alteração está concluída; não repita.` }
}

export const planSkillArchive = ({
  homeDir,
  name,
}: {
  homeDir: string
  name: string
}): { success: true; dir: string; archive: string; before: string | null } | (SkillResult & { success: false }) => {
  if (!SKILL_NAME.test(name)) return { success: false, errorCode: "INVALID_ARGS", error: "Nome de skill inválido." }
  const root = skillsRoot(homeDir)
  const dir = join(root, name)
  const archive = join(root, ".archive")
  if (
    !linkFree(homeDir, join(dir, "SKILL.md"), "file") ||
    !linkFree(homeDir, archive, "directory") ||
    !writableLedger(homeDir)
  )
    return { success: false, errorCode: "INVALID_PATH", error: "O caminho do arquivo não é permitido." }
  if (!existsSync(join(dir, "SKILL.md")))
    return { success: false, errorCode: "NOT_FOUND", error: `A skill ${name} não existe.` }
  return { success: true, dir, archive, before: getSkillText(join(dir, "SKILL.md")) }
}

export const archiveSkill = async ({
  homeDir,
  name,
  origin,
  threadId,
}: {
  homeDir: string
  name: string
  origin: SkillOrigin
  threadId: string
}): Promise<SkillResult> => {
  const plan = planSkillArchive({ homeDir, name })
  if (!plan.success) return plan
  const { dir, archive, before } = plan
  await mkdir(archive, { recursive: true })
  await rename(dir, join(archive, `${name}-${Date.now()}`))
  await record({
    homeDir,
    entry: { action: "archive", skill: name, file: "SKILL.md", origin, threadId, before, after: null },
  })
  return { success: true, message: `Skill ${name} arquivada em skills/.archive.` }
}
