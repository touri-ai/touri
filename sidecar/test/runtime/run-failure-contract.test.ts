import { expect, test } from "bun:test"
import type { RunErrorClass } from "@touri/contracts"
import { publicError } from "@touri/contracts"
import { refineErrorClass, safeRunFailure, sanitizeDiagnostic } from "@touri/contracts/run-failure"
import { classifyProviderError } from "../../src/runtime/utils"

const GENERIC = publicError("unknown").error

const KNOWN: ReadonlyArray<readonly [RunErrorClass, string, RunErrorClass, string]> = [
  [
    "timeout",
    "A máquina não ficou pronta em 90 s: Xvfb não iniciou ou o guest não respondeu",
    "timeout",
    "ambiente gráfico",
  ],
  [
    "cli_crash",
    "Error: claude: arquivo de login ausente. Claude no Keychain do macOS não é exportado; faça login na VM.",
    "cli_auth",
    "Keychain",
  ],
  ["timeout", "A conexão selada da máquina não ficou pronta a tempo", "timeout", "conexão selada"],
  [
    "cli_missing",
    "ENOENT: no such file or directory, posix_spawn '/opt/homebrew/bin/codex'",
    "cli_missing",
    "Codex não foi encontrado",
  ],
  ["timeout", "O login na máquina não ficou pronto em 15 s", "timeout", "login na máquina"],
  [
    "cli_crash",
    'Error: internalError: "failed to list containers" (cause: "interrupted: "XPC connection error: Connection invalid"")',
    "machine_service_unavailable",
    "serviço de máquinas",
  ],
  ["timeout", "O Codex na máquina não produziu saída em 90 s", "timeout", "não produziu saída"],
  [
    "unknown",
    "Invalid request: data did not match any variant of untagged enum ImageReference",
    "cli_protocol",
    "rejeitou uma solicitação",
  ],
  [
    "cli_auth",
    "O cofre de segredos não respondeu. Autorize o acesso ou salve um login com codex login --device-auth nas permissões do bot",
    "cli_auth",
    "cofre de segredos",
  ],
  ["cli_crash", "Codex exited (137)", "oom", "falta de memória"],
  ["cli_protocol", "database is locked", "cli_protocol", "ocupado"],
  ["unknown", "Codex reported an error", "unknown", "sem informar o motivo"],
  ["unknown", "Provider turn failed", "unknown", "sem informar o motivo"],
  ["cli_missing", "Executable not found: claude", "cli_missing", "Claude não foi encontrado"],
  ["cli_crash", "Codex exited (SIGKILL)", "oom", "falta de memória"],
  ["tool_error", "A imagem anexada não está mais disponível. Anexe a imagem de novo.", "tool_error", "imagem anexada"],
  [
    "cli_crash",
    "Codex exited (1): unexpected provider failure /Users/alice/.codex/auth.json sk-abcdefghijk1234",
    "cli_crash",
    "Detalhe do provedor",
  ],
  ["rate_limit", "429 usage limit reached", "rate_limit", "Muitas solicitações"],
  ["context_overflow", "context window exceeded", "context_overflow", "grande demais"],
  ["cli_auth", "401 Unauthorized", "cli_auth", "Entre na sua conta"],
]

test.each(KNOWN)("class %s with %p never falls back to the generic message", (errorClass, message, refined, phrase) => {
  const resolved = refineErrorClass(errorClass, message)
  expect(resolved).toBe(refined)
  const failure = safeRunFailure(resolved, message)
  expect(failure.detail).not.toBe(GENERIC)
  expect(failure.detail).toContain(phrase)
  expect(failure.detail).not.toMatch(/alice|sk-abc|\/Users/)
  expect(failure.detail.length).toBeGreaterThan(10)
})

test("adapter-side classification already yields the specific class for the histogram messages", () => {
  expect(classifyProviderError("Invalid request: data did not match any variant of untagged enum ImageReference")).toBe(
    "cli_protocol",
  )
  expect(classifyProviderError("posix_spawn '/opt/homebrew/bin/codex'")).toBe("cli_missing")
  expect(classifyProviderError("failed to list containers")).toBe("machine_service_unavailable")
  expect(classifyProviderError("something nobody has seen")).toBe("unknown")
})

test.each([
  "Selected model is at capacity. Please try a different model.",
  "The model is currently at capacity. Please try again later.",
  "Selected MODEL IS AT CAPACITY. Please try a different model.",
])("a model capacity response preserves the recovery advice: %s", (diagnostic) => {
  const errorClass = classifyProviderError(diagnostic)
  const failure = safeRunFailure(errorClass, diagnostic)

  expect(errorClass).toBe("rate_limit")
  expect(refineErrorClass("unknown", diagnostic)).toBe("rate_limit")
  expect(failure.detail).toBe("O modelo selecionado está sem capacidade no momento.")
  expect(failure.hint).toBe("Escolha outro modelo nas configurações do bot ou tente de novo em alguns minutos.")
  expect(safeRunFailure(errorClass, failure.detail)).toEqual(failure)
})

test.each(["The buffer capacity was exceeded", "model download failed: disk at capacity"])(
  "unrelated capacity diagnostics remain unknown: %s",
  (diagnostic) => {
    const errorClass = classifyProviderError(diagnostic)

    expect(errorClass).toBe("unknown")
  },
)

test("authentication still takes precedence over model capacity", () => {
  const errorClass = classifyProviderError("401 Unauthorized: selected model is at capacity")

  expect(errorClass).toBe("cli_auth")
})

test("every actionable cause carries a precise CTA", () => {
  expect(
    safeRunFailure("cli_auth", "Error: claude: arquivo de login ausente. Keychain do macOS não é exportado").action,
  ).toEqual({
    kind: "setting",
    settingId: "providerLogin",
    label: "Abrir login do provedor",
  })
  expect(safeRunFailure("oom", "Codex exited (137)").action).toMatchObject({ kind: "setting", settingId: "vmMemory" })
  expect(safeRunFailure("cli_missing", "posix_spawn '/opt/homebrew/bin/codex'").action).toMatchObject({
    kind: "doctor",
  })
  expect(safeRunFailure("machine_service_unavailable", "failed to list containers").action).toMatchObject({
    kind: "machine_service",
  })
})

test("unknown errors show the sanitized real provider message, never secrets, paths or tokens", () => {
  const raw =
    "The upstream refused: quota policy 42 at /Users/alice/.codex/session.json token=abc123 Bearer eyJhbGciOi.payload.sig https://api.example.com/v1?key=secret sk-live1234567890 ~/notes"
  const failure = safeRunFailure("unknown", raw)
  expect(failure.stage).toBe("turn")
  expect(failure.detail).toContain("The upstream refused: quota policy 42")
  expect(failure.detail).not.toMatch(/alice|abc123|eyJhbGci|key=secret|sk-live|~\/notes|\/Users/)
  expect(failure.detail).not.toBe(GENERIC)
  expect(failure.detail.length).toBeLessThan(400)
})

test("sanitizeDiagnostic bounds length and collapses whitespace", () => {
  const long = sanitizeDiagnostic(`erro\n\n${"palavra ".repeat(200)}`)
  expect(long.length).toBeLessThanOrEqual(240)
  expect(long).not.toContain("\n")
  expect(sanitizeDiagnostic(null)).toBe("")
})

test("without any diagnostic the registry message is the only fallback", () => {
  expect(safeRunFailure("unknown", null).detail).toBe(GENERIC)
})
