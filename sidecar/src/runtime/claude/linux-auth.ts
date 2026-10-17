import { existsSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { canonicalPath, excludedBotFolders, withinFolder } from "../../kernel/bot-folders"
import { readBoundedFile } from "../../kernel/files"
import { asRecord } from "../utils"

export const claudeFileEnvironment = (env: Record<string, string>): Record<string, string> =>
  env.CLAUDE_CODE_USE_BEDROCK === "1"
    ? {
        AWS_SHARED_CREDENTIALS_FILE: env.AWS_SHARED_CREDENTIALS_FILE ?? join(env.HOME ?? homedir(), ".aws/credentials"),
        AWS_CONFIG_FILE: env.AWS_CONFIG_FILE ?? join(env.HOME ?? homedir(), ".aws/config"),
      }
    : {}

/** Named authentication files and executable leaves, never their parent trees. */
export const claudeLinuxAuthentication = ({
  env,
  appData,
  home,
  source,
  settings,
  cwd,
}: {
  env: Record<string, string>
  appData: string
  home: string
  source: string
  settings: string
  cwd: string
}) => {
  const paths = [
    ...Object.values(claudeFileEnvironment(env)),
    ...(env.CLAUDE_CODE_USE_VERTEX === "1" && env.GOOGLE_APPLICATION_CREDENTIALS
      ? [env.GOOGLE_APPLICATION_CREDENTIALS]
      : []),
  ]
  const files = paths.filter(existsSync).map((path) => {
    const real = canonicalPath(path)
    const sourceRoot = canonicalPath(source) === resolve(source) ? canonicalPath(source) : null
    if (
      !statSync(real).isFile() ||
      real !== resolve(path) ||
      excludedBotFolders(appData, home).some(
        (root) => withinFolder(root, real) && !(sourceRoot && withinFolder(sourceRoot, real)),
      )
    )
      throw new Error(
        "Não foi possível acessar o login do bot com segurança. Entre novamente na conta nas configurações.",
      )
    return real
  })
  const configuration = existsSync(settings)
    ? asRecord(
        JSON.parse(readBoundedFile({ root: dirname(settings), path: settings, maxBytes: 1024 * 1024 }).toString()),
      )
    : null
  const executables = ["apiKeyHelper", "awsAuthRefresh", "awsCredentialExport"].flatMap((field) => {
    const command = configuration?.[field]
    if (typeof command !== "string") return []
    // Infer only a literal first program; shell expressions and helper data do
    // not implicitly authorize extra filesystem roots.
    const first = command.match(/^(?:'([^']+)'|"([^"$`]+)"|([^\s"'\\;$|&<>`()]+))/)
    const name = first?.[1] ?? first?.[2] ?? first?.[3]
    const path = name ? Bun.which(name, { PATH: env.PATH ?? "/usr/bin:/bin", cwd }) : null
    return path ? [path] : []
  })
  return { files, executables }
}
