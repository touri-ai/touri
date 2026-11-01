import type { ApiRoutes, LegacyImportOptions } from "@touri/contracts"
import type { UiApi } from "../api/client"

type ImportRoute = "POST /imports/legacy" | "GET /imports/:id"
type ImportStatus = ApiRoutes["GET /imports/:id"]["res"]

export const runLegacyImport = async (
  api: UiApi,
  options: LegacyImportOptions,
  signal: AbortSignal,
  onStatusUnavailable: (unavailable: boolean) => void,
): Promise<ImportStatus> => {
  const response = await sendLegacyImportRequest(api, "POST /imports/legacy", options, {}, signal)

  // Only a terminal job result ends the wait; a request deadline does not end the import.
  while (!signal.aborted) {
    const status = await sendLegacyImportRequest(api, "GET /imports/:id", {}, { id: response.importId }, signal).catch(
      () => null,
    )
    signal.throwIfAborted()

    if (status?.status === "failed") return status
    if (status?.status === "succeeded" && status.report) return status

    onStatusUnavailable(!status || status.status === "succeeded")
    await waitForNextImportPoll(signal)
  }

  throw signal.reason
}

const sendLegacyImportRequest = async <Route extends ImportRoute>(
  api: UiApi,
  route: Route,
  input: ApiRoutes[Route]["req"],
  path: Record<string, string>,
  signal: AbortSignal,
): Promise<ApiRoutes[Route]["res"]> => {
  signal.throwIfAborted()
  const deadline = new AbortController()
  const timer = setTimeout(() => deadline.abort(), 30_000)
  const requestSignal = AbortSignal.any([signal, deadline.signal])

  try {
    return await api.request(route, input, path, { signal: requestSignal })
  } finally {
    clearTimeout(timer)
  }
}

const waitForNextImportPoll = (signal: AbortSignal): Promise<void> => {
  signal.throwIfAborted()

  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort)
      resolve()
    }, 1000)

    signal.addEventListener("abort", abort, { once: true })
  })
}
