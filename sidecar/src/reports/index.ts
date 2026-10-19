import type { Database } from "bun:sqlite"
import {
  editReportSnapshot,
  type Kernel,
  type ReportHistory,
  type ReportInput,
  type ReportSnapshot,
  redactReportText,
  reportParts,
  reportSizeLimit,
  reportZip,
} from "@touri/contracts"
import { buildReport, reportRepository } from "./bundle"

export const validateReportInput = (value: unknown): value is ReportInput => {
  if (!value || typeof value !== "object") return false
  const input = value as ReportInput
  return (
    (input.repository === undefined || (typeof input.repository === "string" && input.repository.length <= 300)) &&
    [input.title, input.happened, input.expected, input.steps].every(
      (text) => typeof text === "string" && text.length <= 16000,
    ) &&
    Boolean(input.title.trim() && input.happened.trim() && input.expected.trim()) &&
    ["crash", "bug", "suggestion"].includes(input.severity) &&
    [input.botId, input.threadId].every((id) => id === null || (typeof id === "string" && id.length <= 200)) &&
    (input.errorCode === null || (typeof input.errorCode === "string" && /^TOURI-E\d{4}$/.test(input.errorCode))) &&
    Array.isArray(input.parts) &&
    input.parts.length <= reportParts.length &&
    input.parts.every((part) => reportParts.includes(part)) &&
    (!input.parts.includes("transcript") || Boolean(input.botId && input.threadId)) &&
    (input.transcriptBranch === undefined || ["active", "all"].includes(input.transcriptBranch)) &&
    (input.transcriptMessageIds === undefined ||
      (Array.isArray(input.transcriptMessageIds) &&
        input.transcriptMessageIds.length <= 10000 &&
        input.transcriptMessageIds.every((id) => typeof id === "string" && id.length <= 200))) &&
    (input.previewEdits === undefined ||
      (input.previewEdits !== null &&
        typeof input.previewEdits.id === "string" &&
        input.previewEdits.id.length <= 200 &&
        typeof input.previewEdits.reportJson === "string" &&
        input.previewEdits.reportJson.length <= 8 * 1024 * 1024 &&
        input.previewEdits.logs !== null &&
        typeof input.previewEdits.logs === "object" &&
        !Array.isArray(input.previewEdits.logs) &&
        Object.entries(input.previewEdits.logs).length <= 3 &&
        Object.entries(input.previewEdits.logs).every(
          ([name, text]) => name.length <= 100 && typeof text === "string" && text.length <= 2 * 1024 * 1024,
        ))) &&
    Array.isArray(input.images) &&
    input.images.length <= 8 &&
    input.images.every((image) => {
      if (
        !image ||
        !["image/png", "image/jpeg", "image/webp"].includes(image.mime) ||
        typeof image.dataBase64 !== "string" ||
        image.dataBase64.length > Math.ceil(reportSizeLimit / 3) * 4
      )
        return false
      const bytes = Buffer.from(image.dataBase64, "base64")
      return (
        bytes.toString("base64") === image.dataBase64 &&
        bytes.length > 12 &&
        bytes.length <= reportSizeLimit &&
        (image.mime === "image/png"
          ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
          : image.mime === "image/jpeg"
            ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
            : bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP")
      )
    }) &&
    input.images.reduce((sum, image) => sum + image.dataBase64.length, 0) <= 14 * 1024 * 1024
  )
}
export const init = async (kernel: Kernel) => {
  const db = kernel.db as Database
  const prepared = new Map<string, { snapshot: ReportSnapshot; zip: Uint8Array<ArrayBuffer> }>()
  const cloudAvailable = async () => {
    if (kernel.services.use("store.settings")?.().cloud !== true) return false
    const cloud = kernel.services.use("cloud.account")
    try {
      if (!cloud || !(await cloud.connected())) return false
      const capabilities = await cloud.request<{ protocolVersion: number; capabilities: string[] }>(
        "GET",
        "/v1/capabilities",
        undefined,
        AbortSignal.timeout(5000),
      )
      return (
        capabilities.protocolVersion === 1 &&
        Array.isArray(capabilities.capabilities) &&
        capabilities.capabilities.includes("reports")
      )
    } catch {
      return false
    }
  }
  const history = (id: string, snapshot: ReportSnapshot, destination: string) => {
    db.query("INSERT OR REPLACE INTO problem_reports(id,date,title,destination) VALUES (?,?,?,?)").run(
      id,
      Date.now(),
      String(snapshot.report.title),
      destination,
    )
    db.exec(
      "DELETE FROM problem_reports WHERE rowid NOT IN (SELECT rowid FROM problem_reports ORDER BY date DESC LIMIT 100)",
    )
  }
  kernel.registerRoutes({
    name: "reports",
    routes: [
      {
        method: "POST",
        path: "/reports/history",
        handler: async ({ body }) => {
          const items = (body as { history?: unknown } | null)?.history
          if (
            !Array.isArray(items) ||
            items.length > 100 ||
            items.some(
              (item) =>
                !item ||
                typeof item.id !== "string" ||
                !/^[\w-]{1,200}$/.test(item.id) ||
                typeof item.title !== "string" ||
                item.title.length > 16000 ||
                !Number.isSafeInteger(item.date) ||
                item.date < 0 ||
                item.date > Date.now() + 60000 ||
                !["zip", "github"].includes(item.destination),
            )
          )
            return { status: 400, json: { error: "Histórico inválido" } }
          db.transaction(() => {
            for (const item of items as ReportHistory[])
              db.query("INSERT OR IGNORE INTO problem_reports(id,date,title,destination) VALUES (?,?,?,?)").run(
                item.id,
                item.date,
                redactReportText(item.title, kernel.redact),
                item.destination,
              )
            db.exec(
              "DELETE FROM problem_reports WHERE rowid NOT IN (SELECT rowid FROM problem_reports ORDER BY date DESC LIMIT 100)",
            )
          }).immediate()
          return { status: 200, json: {} }
        },
      },
      {
        method: "GET",
        path: "/reports",
        handler: async () => ({
          status: 200,
          json: {
            history: db
              .query("SELECT id,date,title,destination FROM problem_reports ORDER BY date DESC LIMIT 100")
              .all(),
            cloudAvailable: await cloudAvailable(),
            repository: reportRepository(),
          },
        }),
      },
      {
        method: "POST",
        path: "/reports/preview",
        handler: async ({ body }) => {
          if (!validateReportInput(body))
            return {
              status: 400,
              json: {
                error: "Preencha o título, o que aconteceu e o resultado esperado. Revise os anexos (até 8 imagens).",
              },
            }
          // Bound snapshot retention, including failed/abandoned forms. No report content is persisted before delivery.
          for (const [id, item] of prepared) if (Date.now() - item.snapshot.createdAt > 30 * 60_000) prepared.delete(id)
          let snapshot: ReportSnapshot
          if (body.previewEdits) {
            const original = prepared.get(body.previewEdits.id)
            if (!original || Date.now() - original.snapshot.createdAt > 30 * 60_000)
              return { status: 404, json: { error: "Prévia expirada. Gere o conteúdo novamente." } }
            try {
              snapshot = editReportSnapshot(
                original.snapshot,
                body.previewEdits,
                kernel.newId(),
                body.repository || reportRepository(),
                kernel.redact,
              )
            } catch {
              return {
                status: 400,
                json: { error: "Prévia inválida. Preserve os campos do relatório e revise o JSON." },
              }
            }
          } else snapshot = await buildReport(kernel, body)
          const zip = reportZip(snapshot)
          if (zip.length > reportSizeLimit)
            return { status: 413, json: { error: "O relatório excede 10 MB. Remova capturas ou a conversa." } }
          prepared.set(snapshot.id, { snapshot, zip })
          while (prepared.size > 5) prepared.delete(prepared.keys().next().value ?? "")
          return { status: 200, json: snapshot }
        },
      },
      {
        method: "POST",
        path: "/reports/:id/deliver",
        handler: async ({ params, body }) => {
          const item = prepared.get(params.id ?? "")
          if (!item || Date.now() - item.snapshot.createdAt > 30 * 60_000)
            return { status: 404, json: { error: "Prévia expirada. Gere o conteúdo novamente." } }
          const destination = (body as { destination?: unknown } | null)?.destination
          if (destination === "zip")
            return { status: 200, json: { id: item.snapshot.id, zipBase64: Buffer.from(item.zip).toString("base64") } }
          // ZIP history is recorded after the desktop confirms the write, via a separate route below.
          if (destination === "github") {
            if (!item.snapshot.githubUrl)
              return { status: 409, json: { error: "Repositório não configurado. Defina TOURI_REPORT_REPOSITORY." } }
            return { status: 200, json: { id: item.snapshot.id, url: item.snapshot.githubUrl } }
          }
          if (destination !== "cloud") return { status: 400, json: { error: "Destino inválido" } }
          if (!(await cloudAvailable())) return { status: 401, json: { error: "Conecte sua conta touri" } }
          const cloud = kernel.services.use("cloud.account")
          if (!cloud) return { status: 401, json: { error: "Conecte sua conta touri" } }
          const result = await cloud.uploadReport(item.zip, item.snapshot.id)
          if (!result || typeof result.id !== "string" || !/^[\w-]{1,200}$/.test(result.id))
            return { status: 502, json: { error: "Resposta inválida da nuvem" } }
          history(result.id, item.snapshot, "cloud")
          return { status: 200, json: { id: result.id } }
        },
      },
      {
        method: "POST",
        path: "/reports/:id/saved",
        handler: async ({ params, body }) => {
          const destination = (body as { destination?: unknown } | null)?.destination
          if (destination !== "zip" && destination !== "github")
            return { status: 400, json: { error: "Destino inválido" } }
          const item = prepared.get(params.id ?? "")
          if (!item) return { status: 404, json: { error: "Prévia expirada" } }
          history(item.snapshot.id, item.snapshot, destination)
          return { status: 200, json: {} }
        },
      },
    ],
  })
}
