import type { DoctorCheck } from "@touri/contracts"
import { type Locale, t } from "../../i18n"

const knownChecks: Record<string, { tool: string; kind: "installation" | "login" | "shell" }> = {
  codex: { tool: "Codex", kind: "installation" },
  "codex-auth": { tool: "Codex", kind: "login" },
  claude: { tool: "Claude", kind: "installation" },
  "claude-auth": { tool: "Claude", kind: "login" },
  opencode: { tool: "OpenCode", kind: "installation" },
  "opencode-auth": { tool: "OpenCode", kind: "login" },
  git: { tool: "Git", kind: "installation" },
  node: { tool: "Node.js", kind: "installation" },
  "shell-env": { tool: "", kind: "shell" },
}

export const getDoctorCheckCopy = (check: DoctorCheck, locale: Locale = "pt-BR") => {
  const known = Object.hasOwn(knownChecks, check.id) ? knownChecks[check.id] : undefined
  if (!known) return undefined

  const ready = (check.status ?? (check.ok ? "pass" : "fail")) === "pass"
  const params = { tool: known.tool }
  if (known.kind === "login")
    return {
      label: t(ready ? "Your {tool} sign-in is configured" : "Your {tool} sign-in needs attention", params, locale),
      nextStep: t(
        ready
          ? "Local credentials were found; access to the provider was not tested."
          : "Check your {tool} sign-in, then check again.",
        params,
        locale,
      ),
    }

  if (known.kind === "shell")
    return {
      label: t(ready ? "touri can find your installed tools" : "touri needs help finding your tools", {}, locale),
      nextStep: t(
        ready ? "No action is needed for this check." : "Check your shell startup settings, then reopen touri.",
        {},
        locale,
      ),
    }

  return {
    label: t(ready ? "{tool} is installed" : "{tool} needs attention", params, locale),
    nextStep: t(
      ready ? "No action is needed for this check." : "Check the installation of {tool}, then check again.",
      params,
      locale,
    ),
  }
}
