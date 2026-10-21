import type { DoctorCheck } from "@touri/contracts"
import { describe, expect, it } from "vitest"
import { getDoctorCheckCopy } from "../src/features/doctor/getDoctorCheckCopy"

const getCheck = (id: string, values: Partial<DoctorCheck> = {}): DoctorCheck => ({
  id,
  label: "Original label",
  status: "pass",
  ok: true,
  detail: "Original diagnostic",
  fix: null,
  ...values,
})

const checks = [
  ["codex", "Codex está instalado", "Codex is installed"],
  ["codex-auth", "Login do Codex configurado", "Your Codex sign-in is configured"],
  ["claude", "Claude está instalado", "Claude is installed"],
  ["claude-auth", "Login do Claude configurado", "Your Claude sign-in is configured"],
  ["opencode", "OpenCode está instalado", "OpenCode is installed"],
  ["opencode-auth", "Login do OpenCode configurado", "Your OpenCode sign-in is configured"],
  ["git", "Git está instalado", "Git is installed"],
  ["node", "Node.js está instalado", "Node.js is installed"],
  ["shell-env", "O touri consegue encontrar suas ferramentas", "touri can find your installed tools"],
] as const

describe.each(checks)("plain diagnostic copy for %s", (id, portuguese, english) => {
  it("describes the observed passing check in both languages", () => {
    expect(getDoctorCheckCopy(getCheck(id))?.label).toBe(portuguese)
    expect(getDoctorCheckCopy(getCheck(id), "en")?.label).toBe(english)
  })

  it.each(["warn", "fail"] as const)("does not call a %s result ready and supplies a next step", (status) => {
    const check = getCheck(id, { status, ok: true })
    const pt = getDoctorCheckCopy(check)
    const en = getDoctorCheckCopy(check, "en")

    expect(pt?.label).not.toBe(portuguese)
    expect(en?.label).not.toBe(english)
    expect(pt?.nextStep).toContain(id === "shell-env" ? "reabra o touri" : "verifique novamente")
    expect(en?.nextStep).toContain(id === "shell-env" ? "reopen touri" : "check again")
  })

  it("supports the older ok boolean without overriding an explicit status", () => {
    expect(getDoctorCheckCopy(getCheck(id, { status: undefined, ok: true }))?.label).toBe(portuguese)
    expect(getDoctorCheckCopy(getCheck(id, { status: undefined, ok: false }))?.label).not.toBe(portuguese)
    expect(getDoctorCheckCopy(getCheck(id, { status: "pass", ok: false }))?.label).toBe(portuguese)
  })
})

it.each(["new-provider", "constructor", "toString", "__proto__"])("keeps unknown check %s out of the mapping", (id) => {
  expect(getDoctorCheckCopy(getCheck(id))).toBeUndefined()
})

it.each(["codex-auth", "claude-auth", "opencode-auth"])(
  "keeps the local-only credential qualification for %s",
  (id) => {
    expect(getDoctorCheckCopy(getCheck(id), "en")?.nextStep).toContain("access to the provider was not tested")
    expect(getDoctorCheckCopy(getCheck(id))?.nextStep).toContain("o acesso ao provedor não foi testado")
  },
)

it("directs an empty shell path to shell startup settings instead of reinstalling tools", () => {
  const check = getCheck("shell-env", { status: "fail", ok: false })
  expect(getDoctorCheckCopy(check, "en")?.nextStep).toBe("Check your shell startup settings, then reopen touri.")
  expect(getDoctorCheckCopy(check)?.nextStep).toBe(
    "Revise as configurações de inicialização do seu shell e reabra o touri.",
  )
})
