import { publicError } from "./errors"
import type { MessagePart, RunErrorClass } from "./types"

/** Unknown tool outcomes are effects too: a missing acknowledgement is not proof of rollback. */
export const hasRecordedActions = (parts: ReadonlyArray<MessagePart>): boolean =>
  parts.some((part) => part.type === "tool_call" || part.type === "command" || part.type === "file_change")

export type RunFailureStage =
  | "machine_boot"
  | "sealed_connection"
  | "provider_login"
  | "provider_output"
  | "machine_service"
  | "provider_install"
  | "provider_memory"
  | "provider_protocol"
  | "provider_busy"
  | "turn"

export type FailureAction =
  | { kind: "setting"; settingId: "vmMemory" | "providerLogin" | "browserEnabled" | "computerUse"; label: string }
  | { kind: "doctor"; label: string }
  | { kind: "machine_service"; label: string }

export type RunFailureDetail = {
  stage: RunFailureStage
  detail: string
  hint?: string
  action?: FailureAction
}

type Rule = {
  test: RegExp
  errorClass?: RunErrorClass
  build: (text: string, duration: string) => RunFailureDetail
}

const MAX_PUBLIC_DIAGNOSTIC = 240
const REFINABLE: ReadonlyArray<string> = ["unknown", "cli_crash", "cli_protocol", "tool_error"]
const MESSAGE_CLASSES: ReadonlyArray<string> = ["unknown", "cli_crash", "cli_protocol", "tool_error", ""]
const PROVIDERS = ["codex", "claude", "opencode"] as const
const MODEL_AT_CAPACITY =
  /\bmodel is (?:currently )?at capacity\b|O modelo selecionado está sem capacidade no momento\./i

const PROVIDER_LOGIN: FailureAction = { kind: "setting", settingId: "providerLogin", label: "Abrir login do provedor" }
const VM_MEMORY: FailureAction = { kind: "setting", settingId: "vmMemory", label: "Abrir memória da máquina" }
const DOCTOR: FailureAction = { kind: "doctor", label: "Abrir o Doctor" }
const MACHINE_SERVICE: FailureAction = { kind: "machine_service", label: "Iniciar serviço de máquinas" }

export const isModelAtCapacity = (text: string): boolean => MODEL_AT_CAPACITY.test(text)

/** Redact paths, credentials and long opaque strings from a provider diagnostic and bound its size. */
export const sanitizeDiagnostic = (value: string | null | undefined): string => {
  const cleaned = (value ?? "")
    .replace(/https?:\/\/[^\s"')]+/gi, (url) => url.split(/[?#]/)[0] ?? "")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "[segredo]")
    .replace(/\b(?:sk|pk|ghp|gho|xox[abps]|AKIA)[-_A-Za-z0-9]{8,}/g, "[segredo]")
    .replace(/\b(token|secret|password|senha|api[_-]?key|authorization)(\s*[=:]\s*)\S+/gi, "$1$2[segredo]")
    .replace(/(?:~|\$HOME|%USERPROFILE%)(?:[\\/][^\s"']*)?/g, "[caminho]")
    .replace(/(?:\/(?:Users|home|private|var|tmp|opt|etc|root|workspace|Volumes)\b)[^\s"')]*/g, "[caminho]")
    .replace(/[A-Za-z]:\\[^\s"')]*/g, "[caminho]")
    .replace(/\b[A-Za-z0-9+/_-]{32,}={0,2}/g, "[segredo]")
    .replace(/\s+/g, " ")
    .trim()
  return cleaned.length > MAX_PUBLIC_DIAGNOSTIC ? `${cleaned.slice(0, MAX_PUBLIC_DIAGNOSTIC - 1)}…` : cleaned
}

const MCP_STARTUP_REASONS: Readonly<Record<string, string>> = {
  parent_gone: "o processo das ferramentas encerrou porque o provedor deixou de ser o seu pai",
  stdin_closed: "o processo das ferramentas encerrou porque o provedor fechou a entrada",
  terminated: "o processo das ferramentas foi encerrado antes de responder",
  socket_error: "o processo das ferramentas não conseguiu conectar ao touri",
  token_unavailable: "a credencial do turno não estava disponível para as ferramentas",
  closed_before_initialize: "o touri recusou ou fechou a conexão das ferramentas antes da resposta inicial",
  handshake_timeout: "o provedor esgotou o prazo do aperto de mão das ferramentas",
  bridge_closed: "a ponte da máquina fechou antes da resposta inicial",
  unknown: "etapa desconhecida",
}

const mcpStartupReason = (text: string): string => {
  const stage = /\[etapa: ([a-z_]+)\]/.exec(text)?.[1]
  const reason = stage ? MCP_STARTUP_REASONS[stage] : undefined
  return reason ? ` (${reason})` : ""
}

const providerName = (text: string): string => {
  const quoted = /(?:posix_spawn|spawn|Executable not found:)\s*'?([^\s']+)'?/i.exec(text)?.[1] ?? ""
  const base = quoted.split("/").pop() ?? ""
  const named = PROVIDERS.find((name) => base === name || new RegExp(`\\b${name}\\b`, "i").test(text))
  return named ?? "do provedor"
}

const providerLabel = (name: string): string =>
  name === "codex" ? "Codex" : name === "claude" ? "Claude" : name === "opencode" ? "OpenCode" : "provedor"

const RULES: ReadonlyArray<Rule> = [
  {
    test: /\bA máquina não ficou pronta|O início da máquina excedeu/i,
    build: (text, duration) => ({
      stage: "machine_boot",
      detail: `A máquina não ficou pronta${duration}${/Xvfb não iniciou ou o guest não respondeu|o ambiente gráfico não iniciou ou a máquina não respondeu/i.test(text) ? ": o ambiente gráfico não iniciou ou a máquina não respondeu" : "."}`,
      hint: "Aguarde a máquina terminar de iniciar para tentar de novo.",
    }),
  },
  {
    test: /A conexão selada da máquina não ficou pronta/i,
    build: () => ({
      stage: "sealed_connection",
      detail: "A conexão selada da máquina não ficou pronta a tempo.",
      hint: "Aguarde a conexão segura da máquina se restabelecer para tentar de novo.",
    }),
  },
  {
    test: /O login na máquina não ficou pronto/i,
    build: (_text, duration) => ({
      stage: "provider_login",
      detail: `O login na máquina não ficou pronto${duration}.`,
      hint: "Confira o login do provedor nas permissões do bot antes de tentar de novo.",
      action: PROVIDER_LOGIN,
    }),
  },
  {
    test: /O (Codex|Claude) na máquina não produziu saída/i,
    build: (text, duration) => ({
      stage: "provider_output",
      detail: `O ${/O Codex na máquina/i.test(text) ? "Codex" : "Claude"} na máquina não produziu saída${duration}.`,
      hint: "O provedor não respondeu. Com a máquina pronta, tente de novo.",
    }),
  },
  {
    test: /As ferramentas do touri não carregaram nesta máquina/,
    build: (text) => ({
      stage: "turn",
      detail: `As ferramentas do touri não carregaram nesta máquina${mcpStartupReason(text)}. Tente novamente e confira o Doctor.`,
      hint: "Abra o Doctor para conferir as ferramentas e tente de novo.",
      action: DOCTOR,
    }),
  },
  {
    test: /arquivo de login ausente|Keychain do macOS não é exportado/i,
    errorClass: "cli_auth",
    build: () => ({
      stage: "provider_login",
      detail:
        "O login do Claude não está disponível na máquina: o login guardado no Keychain do macOS não é copiado para a VM.",
      hint: "Entre na conta dentro desta máquina (Login do provedor) ou escolha outra origem de login.",
      action: PROVIDER_LOGIN,
    }),
  },
  {
    test: /cofre de segredos não respondeu/i,
    errorClass: "cli_auth",
    build: () => ({
      stage: "provider_login",
      detail: "O cofre de segredos do macOS não respondeu ao pedir o login do provedor.",
      hint: "Autorize o acesso ao Keychain ou salve um login do provedor nas permissões do bot.",
      action: PROVIDER_LOGIN,
    }),
  },
  {
    test: /posix_spawn|Executable not found|spawn \S+ ENOENT|\bENOENT\b.*(?:codex|claude|opencode)/i,
    errorClass: "cli_missing",
    build: (text) => {
      const name = providerName(text)
      return {
        stage: "provider_install",
        detail: `O programa ${name === "do provedor" ? name : providerLabel(name)} não foi encontrado neste computador.`,
        hint: "Instale o CLI do provedor ou informe o caminho dele; o Doctor mostra o que falta.",
        action: DOCTOR,
      }
    },
  },
  {
    test: /failed to list containers|XPC connection|container system (?:service|start)|Connection invalid/i,
    errorClass: "machine_service_unavailable",
    build: () => ({
      stage: "machine_service",
      detail: "O serviço de máquinas do macOS (container) não respondeu.",
      hint: "O touri já tentou de novo. Inicie ou reinicie o serviço de máquinas e tente outra vez.",
      action: MACHINE_SERVICE,
    }),
  },
  {
    test: /exited \((?:137|SIGKILL)\)|out of memory|\bOOM\b|Killed process/i,
    errorClass: "oom",
    build: () => ({
      stage: "provider_memory",
      detail: "O provedor foi encerrado por falta de memória (código 137).",
      hint: "Aumente a memória da máquina virtual nas configurações e tente de novo.",
      action: VM_MEMORY,
    }),
  },
  {
    test: MODEL_AT_CAPACITY,
    errorClass: "rate_limit",
    build: () => ({
      stage: "turn",
      detail: "O modelo selecionado está sem capacidade no momento.",
      hint: "Escolha outro modelo nas configurações do bot ou tente de novo em alguns minutos.",
    }),
  },
  {
    test: /database is locked|SQLITE_BUSY|database table is locked/i,
    errorClass: "cli_protocol",
    build: () => ({
      stage: "provider_busy",
      detail: "O banco de dados do provedor estava ocupado por outro processo.",
      hint: "O touri já tentou de novo. Feche outras sessões do provedor e tente outra vez.",
    }),
  },
  {
    test: /Invalid request|did not match any variant|unknown variant|invalid params|missing field/i,
    errorClass: "cli_protocol",
    build: (text) => ({
      stage: "provider_protocol",
      detail: `O provedor rejeitou uma solicitação do touri: ${sanitizeDiagnostic(text.replace(/^.*?(?=Invalid request|did not match|unknown variant|invalid params|missing field)/i, ""))}`,
      hint: "Tente de novo sem anexos; se repetir, abra o Doctor e envie o relatório.",
      action: DOCTOR,
    }),
  },
  {
    test: /A imagem anexada não está mais disponível/,
    build: () => ({
      stage: "turn",
      detail: "A imagem anexada não está mais disponível.",
      hint: "Anexe a imagem de novo e envie a mensagem outra vez.",
    }),
  },
  {
    test: /^\s*(?:(Codex|Claude|OpenCode) reported an error|Provider turn failed)\s*$/i,
    build: (text) => ({
      stage: "turn",
      detail: `${/Claude/i.test(text) ? "O Claude" : /OpenCode/i.test(text) ? "O OpenCode" : "O provedor"} falhou sem informar o motivo.`,
      hint: "Confira o login do provedor no Doctor e tente de novo.",
      action: DOCTOR,
    }),
  },
]

const secondsOf = (text: string): string => {
  const seconds = /\b(?:em|excedeu) (\d{1,5}(?:\.\d{1,3})?) s\b/.exec(text)?.[1]
  return seconds ? ` em ${Number(seconds)} s` : " a tempo"
}

const matchRule = (text: string): Rule | undefined => RULES.find((rule) => rule.test.test(text))

/** Specific error class implied by a diagnostic, used when the adapter could only say "unknown". */
export const refineErrorClass = (errorClass: RunErrorClass, diagnostic: string | null | undefined): RunErrorClass => {
  if (!REFINABLE.includes(errorClass)) return errorClass
  const refined = matchRule(diagnostic ?? "")?.errorClass
  return refined ?? errorClass
}

/** Project diagnostics onto known public phrases. Unknown provider errors show the sanitized message, never raw stderr. */
export const safeRunFailure = (errorClass: string | null, diagnostic: string | null): RunFailureDetail => {
  const text = diagnostic ?? ""
  const rule = matchRule(text)
  if (rule) return rule.build(text, secondsOf(text))
  const message = sanitizeDiagnostic(text)
  const registry = publicError(errorClass).error
  if (message && MESSAGE_CLASSES.includes(errorClass ?? ""))
    return {
      stage: "turn",
      detail: `${registry === publicError("unknown").error ? "O provedor informou" : "Detalhe do provedor"}: ${message}`,
      hint: "Tente de novo; se repetir, abra o Doctor.",
      action: DOCTOR,
    }
  return { stage: "turn", detail: registry }
}

export const failureStageLabel = (stage: RunFailureStage): string =>
  ({
    machine_boot: "Inicialização da máquina",
    sealed_connection: "Conexão selada",
    provider_login: "Login no provedor",
    provider_output: "Primeira resposta do provedor",
    machine_service: "Serviço de máquinas",
    provider_install: "Instalação do provedor",
    provider_memory: "Memória da máquina",
    provider_protocol: "Protocolo do provedor",
    provider_busy: "Banco do provedor",
    turn: "Execução do turno",
  })[stage]

export const failureRetryHint = (stage: RunFailureStage, machineReady = false): string => {
  if (machineReady && stage === "machine_boot") return "A máquina está pronta para uma nova tentativa."
  if (machineReady && stage === "sealed_connection")
    return "A máquina está pronta. Tente restabelecer a conexão segura."
  return {
    machine_boot: "Aguarde a máquina terminar de iniciar para tentar de novo.",
    sealed_connection: "Aguarde a conexão segura da máquina se restabelecer para tentar de novo.",
    provider_login: "Confira o login do provedor nas permissões do bot antes de tentar de novo.",
    provider_output: "O provedor não respondeu. Com a máquina pronta, tente de novo.",
    machine_service: "Inicie ou reinicie o serviço de máquinas e tente de novo.",
    provider_install: "Instale o CLI do provedor ou confira o Doctor.",
    provider_memory: "Aumente a memória da máquina virtual e tente de novo.",
    provider_protocol: "Tente de novo; se repetir, abra o Doctor.",
    provider_busy: "Aguarde alguns segundos e tente de novo.",
    turn: "Confira o estado da máquina e tente de novo.",
  }[stage]
}
