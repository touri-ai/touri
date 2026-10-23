import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { errorRegistry, publicError, resolveErrorCode } from "@touri/contracts"
import { createKernel } from "../../src/kernel"
import { normalizeErrorBody, TouriError } from "../../src/kernel/errors"

test("the registry has stable four-digit codes, Portuguese messages and complete metadata", () => {
  for (const [code, definition] of Object.entries(errorRegistry)) {
    expect(code).toMatch(/^TOURI-E\d{4}$/)
    expect(definition.origin.length).toBeGreaterThan(0)
    expect(definition.domain.length).toBeGreaterThan(0)
    expect(typeof definition.retryable).toBe("boolean")
    expect(definition.message.length).toBeGreaterThan(10)
  }
  expect(resolveErrorCode("cli_auth")).toBe("TOURI-E3001")
  expect(resolveErrorCode("ENOSPC")).toBe("TOURI-E2002")
  expect(resolveErrorCode("unregistered", 404)).toBe("TOURI-E1002")
  expect(resolveErrorCode("__proto__")).toBe("TOURI-E1000")
  expect(publicError("DEADLINE_EXCEEDED")).toMatchObject({ code: "TOURI-E1008", retryable: true })
  expect(publicError("STALE_REF")).toMatchObject({ domain: "browser", code: "TOURI-E4001" })
  expect(publicError("SITE_BLOCKED")).toMatchObject({ domain: "browser", code: "TOURI-E4005", retryable: false })
  expect(publicError("LOCAL_BROWSER_UNAVAILABLE")).toMatchObject({
    domain: "browser",
    code: "TOURI-E4006",
    retryable: false,
  })
  expect(publicError("COMPUTER_NOT_GRANTED")).toMatchObject({ domain: "computer", code: "TOURI-E5000" })
  expect(publicError("PROCESS_START_FAILED")).toMatchObject({ domain: "project", code: "TOURI-E6000" })
  expect(publicError("IMPORT_FAILED")).toMatchObject({ domain: "import", code: "TOURI-E7000" })
})

test("normalization ignores invalid public codes and does not echo diagnostic error codes", () => {
  expect(normalizeErrorBody({ code: "bad", errorCode: "cli_auth", error: "raw detail" }, 500)).toMatchObject({
    code: "TOURI-E3001",
    errorCode: "cli_auth",
  })
  const body = normalizeErrorBody({ errorCode: "/private/user/path\nsecret", error: "raw detail" }, 500)
  expect(body).toMatchObject({ code: "TOURI-E1000", errorCode: "TOURI-E1000" })
  expect(JSON.stringify(body)).not.toContain("secret")
})

test("HTTP errors keep internal codes but expose safe public codes; thrown errors never leak details", async () => {
  const root = mkdtempSync(join(tmpdir(), "touri-errors-"))
  const runtime = createKernel({ appData: root })
  runtime.kernel.registerRoutes({
    name: "storage-test",
    routes: [
      {
        method: "GET",
        path: "/legacy",
        handler: async () => ({ status: 429, json: { errorCode: "RATE_LIMITED", error: "secret raw diagnostics" } }),
      },
      {
        method: "GET",
        path: "/throw",
        handler: async () => {
          throw new Error("secret /private/user/path")
        },
      },
      {
        method: "GET",
        path: "/disk",
        handler: async () => {
          throw new TouriError("TOURI-E2002")
        },
      },
      { method: "GET", path: "/params/:id", handler: async () => ({ status: 200, json: {} }) },
    ],
  })
  const headers = {
    Authorization: `Bearer ${process.env.TOURI_UI_TOKEN ?? "dev-ui-token"}`,
    Origin: "tauri://localhost",
  }
  const get = (path: string) => fetch(`http://127.0.0.1:${runtime.handshake.port}/api/v1${path}`, { headers })
  try {
    const limited = await get("/legacy")
    expect(await limited.json()).toMatchObject({ errorCode: "RATE_LIMITED", code: "TOURI-E1006", retryable: true })
    const thrown = await get("/throw")
    expect(thrown.status).toBe(500)
    const text = await thrown.text()
    expect(text).toContain("TOURI-E1000")
    expect(text).not.toContain("secret")
    expect(text).not.toContain("/private")
    const disk = await get("/disk")
    expect(disk.status).toBe(507)
    expect(await disk.json()).toMatchObject({ code: "TOURI-E2002", domain: "storage", retryable: false })
    expect((await get("/params/%E0%A4%A")).status).toBe(400)
    expect(await (await get("/missing")).json()).toMatchObject({ code: "TOURI-E1002" })
    const unauthorized = await fetch(`http://127.0.0.1:${runtime.handshake.port}/api/v1/health`)
    expect(await unauthorized.json()).toMatchObject({ code: "TOURI-E1003" })
  } finally {
    runtime.stop()
    rmSync(root, { recursive: true, force: true })
  }
})

test("errors before route dispatch also use the public error boundary", async () => {
  const root = mkdtempSync(join(tmpdir(), "touri-error-boundary-"))
  const runtime = createKernel({
    appData: root,
    web: {
      hostname: "127.0.0.1",
      port: 0,
      host: () => async () => ({ success: false, errorCode: "HOST_UNAVAILABLE", error: "test" }),
      intercept: async () => {
        throw new Error("secret intercept diagnostics")
      },
    },
  })
  try {
    const response = await fetch(`http://127.0.0.1:${runtime.handshake.port}/api/v1/health`)
    expect(response.status).toBe(500)
    expect(await response.json()).toMatchObject({ code: "TOURI-E1000", domain: "kernel" })
  } finally {
    runtime.stop()
    rmSync(root, { recursive: true, force: true })
  }
})

test("public address errors retain actionable guidance without raw diagnostics", () => {
  const required = normalizeErrorBody({ errorCode: "PUBLIC_ADDRESS_REQUIRED", error: "private diagnostic" }, 409)
  const invalid = normalizeErrorBody({ errorCode: "PUBLIC_ADDRESS_INVALID", error: "private diagnostic" }, 400)

  expect(required).toMatchObject({
    code: "TOURI-E1017",
    error: "Para convidar pessoas, configure o endereço público HTTPS em Pessoas nas preferências.",
  })
  expect(invalid).toMatchObject({ code: "TOURI-E1018", error: "Informe um endereço HTTPS válido, sem caminho." })
  expect(JSON.stringify([required, invalid])).not.toContain("private diagnostic")
})

test("group field errors use only fixed messages and remain safe across repeated normalization", () => {
  const supplied = {
    errorCode: "INVALID_ARGS",
    field: "avatarShape",
    error: "private-value",
    errorMessages: { en: "private-value" },
  }

  const normalized = normalizeErrorBody(supplied, 400)

  expect(normalized).toMatchObject({ field: "avatarShape", code: "TOURI-E1001" })
  expect(JSON.stringify(normalized)).not.toContain("private-value")
  expect(normalizeErrorBody(normalized, 400)).toEqual(normalized)
  expect(normalizeErrorBody({ ...supplied, field: "__proto__" }, 400)).not.toHaveProperty("field")
  expect(normalizeErrorBody({ ...supplied, field: "private-value" }, 400)).not.toHaveProperty("field")
  expect(normalizeErrorBody({ ...supplied, errorCode: "UNAUTHORIZED" }, 401)).not.toHaveProperty("field")
  expect(normalizeErrorBody(supplied, 500)).not.toHaveProperty("field")
})

test("group fields are bounded, allowlisted, deduplicated and rebuilt as bilingual public messages", () => {
  const supplied = {
    errorCode: "INVALID_ARGS",
    fields: ["name", "__proto__", "color", "name", "private-value"],
    error: "private-value",
    errorMessages: { en: "private-value" },
  }

  const normalized = normalizeErrorBody(supplied, 400)

  expect(normalized).toMatchObject({ field: "name", fields: ["name", "color"] })
  expect(JSON.stringify(normalized)).not.toContain("private-value")
  expect(normalizeErrorBody(normalized, 400)).toEqual(normalized)
  expect(normalizeErrorBody({ ...supplied, fields: ["__proto__"] }, 400)).not.toHaveProperty("fields")
  expect(normalizeErrorBody({ ...supplied, fields: Array(100).fill("name") }, 400)).not.toHaveProperty("fields")
  expect(normalizeErrorBody(supplied, 500)).not.toHaveProperty("fields")
})
