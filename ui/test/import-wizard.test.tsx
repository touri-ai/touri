import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import type { ApiRoutes, ImportCounts, ImportReport, LegacyImportOptions } from "@touri/contracts"
import { StrictMode } from "react"
import { afterEach, expect, it, vi } from "vitest"
import type { ApiRequest, UiApi } from "../src/api/client"
import { createMockApi } from "../src/api/mock"
import { ImportWizard } from "../src/components/Modals"
import { t } from "../src/i18n"

type ImportStatus = ApiRoutes["GET /imports/:id"]["res"]

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

it("waits for a running job before advancing with the actual imported counts", async () => {
  vi.useFakeTimers()
  const fixture = getFixture()
  fixture.getStatus
    .mockResolvedValueOnce({ status: "running", report: null })
    .mockResolvedValueOnce({ status: "succeeded", report: getReport() })
  const { notice } = openReview(fixture)

  await clickRun(false)

  expect(screen.getByRole("status")).toHaveTextContent(t("Waiting for the import result…"))
  expect(screen.getByText(t("Import step", { step: 3 }))).toBeVisible()
  expect(screen.getByRole("button", { name: t("Import now") })).toBeDisabled()
  expect(screen.getByRole("button", { name: t("Checking…") })).toBeDisabled()
  expect(screen.getByRole("button", { name: t("Back") })).toBeDisabled()
  expect(screen.queryByText(t("Import finished"))).toBeNull()
  expect(screen.queryByText(t("Report"))).toBeNull()
  expect(notice).not.toHaveBeenCalled()

  await act(async () => vi.advanceTimersByTimeAsync(1000))

  expect(screen.getByRole("heading", { name: t("Import finished") })).toBeVisible()
  expect(screen.getByText(t("Import counts", { messages: 23, threads: 4 }))).toBeVisible()
  expect(screen.getByText(t("Import step", { step: 4 }))).toBeVisible()
  expect(screen.getByRole("button", { name: t("Show cut-over checklist") })).toBeEnabled()
  expect(fixture.start).toHaveBeenCalledExactlyOnceWith(
    {
      source: { kind: "local", root: "/tmp/legacy-fixture" },
      botIds: [],
      importCodexSessions: false,
      cwdMap: [],
      includeAttachments: true,
      dryRun: false,
    },
    expect.any(AbortSignal),
  )
  expect(fixture.getStatus).toHaveBeenNthCalledWith(1, "import-one", expect.any(AbortSignal))
  expect(fixture.getStatus).toHaveBeenNthCalledWith(2, "import-one", expect.any(AbortSignal))
  expect(notice).toHaveBeenCalledExactlyOnceWith(t("Import complete. Imported routines stay disabled."))

  await act(async () => vi.advanceTimersByTimeAsync(60_000))

  expect(fixture.getStatus).toHaveBeenCalledTimes(2)
})

it("imports the source archive even when no local bot exists", async () => {
  const fixture = { ...getFixture(), bots: [] }
  fixture.getStatus.mockResolvedValue({ status: "succeeded", report: getReport() })
  openReview(fixture)

  await clickRun(false)

  expect(fixture.start.mock.calls[0]?.[0].botIds).toEqual([])
  expect(screen.getByText(t("History is in touri"))).toBeVisible()
})

it.each([false, true])("rejects an empty warning report (dry run: %s)", async (dryRun) => {
  const fixture = getFixture()
  const report = getReport({ dryRun, warnings: ["Selected bot not found: synthetic-local-id"] })
  fixture.getStatus.mockResolvedValue({
    status: "succeeded",
    report: { ...report, bots: getCounts(0), threads: getCounts(0), messages: getCounts(0) },
  })
  const { notice } = openReview(fixture)

  await clickRun(dryRun)

  expect(screen.getByRole("alert")).toBeVisible()
  expect(screen.queryByText(t("History is in touri"))).toBeNull()
  expect(screen.getByRole("button", { name: t("ob.retry") })).toBeEnabled()
  expect(notice).not.toHaveBeenCalled()
})

it.each([{ warnings: [] }, { warnings: ["An optional attachment is unavailable."] }])(
  "describes an unchanged import neutrally: %s",
  async ({ warnings }) => {
    const fixture = getFixture()
    const report = getReport({ warnings })
    fixture.getStatus.mockResolvedValue({
      status: "succeeded",
      report: {
        ...report,
        bots: { ...getCounts(0), unchanged: 1 },
        threads: { ...getCounts(0), unchanged: 4 },
        messages: { ...getCounts(0), unchanged: 23 },
      },
    })
    openReview(fixture)

    await clickRun(false)

    expect(screen.getByText(t("Everything was already up to date"))).toBeVisible()
    expect(screen.getByText(t("Unchanged import counts", { messages: 23, threads: 4 }))).toBeVisible()
    expect(document.querySelector(".success-card")).toBeNull()
    expect(screen.queryByRole("alert")).toBeNull()
  },
)

it.each([
  [
    "Source messages.db must be a regular file inside the source root",
    "No history was found in this folder. Check the source path.",
  ],
  ["Selected bot not found: synthetic-private-id", "A selected bot was not found in the source archive."],
  [
    "No cwd mapping for attachment-helper; using /archive/default",
    "Bots use local working folders. You can change them in each bot’s settings.",
  ],
  ["attachment-helper: local memory edit kept for MEMORY.md", "Your local edits were kept."],
  [
    "Unexpected failure /tmp/synthetic-import/private-id 2026-11-08T02:24:34.375Z",
    "The source archive contains an item that could not be imported. Check the source and try again.",
  ],
])("localizes server warning without exposing diagnostics: %s", async (warning, message) => {
  const fixture = getFixture()
  fixture.getStatus.mockResolvedValue({ status: "failed", report: getReport({ warnings: [warning] }) })
  openReview(fixture)

  await clickRun(false)

  expect(screen.getByRole("alert")).toHaveTextContent(t(message))
  expect(screen.getByRole("alert")).not.toHaveTextContent(warning)
  expect(screen.getByRole("alert")).not.toHaveTextContent(/private-id|2026-11|\/tmp\//)
})

it.each(["failed", "succeeded"] as const)(
  "hides staging details and groups translated warnings (%s)",
  async (status) => {
    const fixture = getFixture()
    fixture.getStatus.mockResolvedValue({
      status,
      report: getReport({
        warnings: [
          "Failed import staging retained at /archive/private-id until 2026-11-08T02:24:34.375Z",
          "Selected bot not found: one",
          "Selected bot not found: two",
          "Attachment not found in allowlisted attachments/: foto.png",
        ],
      }),
    })
    openReview(fixture)

    await clickRun(false)

    const surface = status === "failed" ? screen.getByRole("alert") : getReportView()
    expect(within(surface).getByText(/2 ocorrências/)).toBeVisible()
    expect(surface.querySelectorAll("p")).toHaveLength(2)
    expect(surface).toHaveTextContent(
      t("1 attachment was not copied: {name}. Check it in the source folder.", { name: "foto.png" }),
    )
    expect(surface).not.toHaveTextContent(/temporários|Temporary|private-id|2026-11|staging/)
  },
)

it.each(["../private-id", "folder/private-id", "C:\\private-id", "<script>.png", ".."])(
  "keeps unsafe attachment details hidden: %s",
  async (name) => {
    const fixture = getFixture()
    fixture.getStatus.mockResolvedValue({
      status: "failed",
      report: getReport({ warnings: [`Attachment not found in allowlisted attachments/: ${name}`] }),
    })
    openReview(fixture)

    await clickRun(false)

    expect(screen.getByRole("alert")).toHaveTextContent(
      t("A source file could not be copied. Check the source folder."),
    )
    expect(screen.getByRole("alert")).not.toHaveTextContent(name)
  },
)

it.each([false, true])("makes source correction primary and preserves retry mode (dry run: %s)", async (dryRun) => {
  const fixture = getFixture()
  fixture.getStatus.mockResolvedValue({
    status: "failed",
    report: getReport({ warnings: ["Source messages.db must be a regular file inside the source root"] }),
  })
  openReview(fixture)

  await clickRun(dryRun)

  const correct = screen.getByRole("button", { name: t("Correct source path") })
  expect(correct).toHaveClass("button-dark")
  expect(screen.getByRole("button", { name: t("ob.retry") })).toHaveClass("button-quiet")

  await act(async () => fireEvent.click(screen.getByRole("button", { name: t("ob.retry") })))

  expect(fixture.start.mock.calls.map(([options]) => options.dryRun)).toEqual([dryRun, dryRun])

  fireEvent.click(screen.getByRole("button", { name: t("Correct source path") }))

  expect(screen.getByLabelText(t("legacy app root"))).toHaveFocus()
  expect(screen.getByLabelText(t("legacy app root"))).toHaveValue("/tmp/legacy-fixture")
  expect(screen.queryByRole("alert")).toBeNull()
  expect(fixture.start).toHaveBeenCalledTimes(2)
})

it.each([false, true])("shows failure warnings and retries the same mode (dry run: %s)", async (dryRun) => {
  vi.useFakeTimers()
  const fixture = getFixture()
  fixture.start.mockResolvedValueOnce({ importId: "import-one" }).mockResolvedValueOnce({ importId: "import-two" })
  fixture.getStatus
    .mockResolvedValueOnce({ status: "running", report: null })
    .mockResolvedValueOnce({
      status: "failed",
      report: getReport({
        dryRun,
        warnings: ["The source archive is incomplete.", "No attachments were copied."],
      }),
    })
    .mockResolvedValueOnce({ status: "running", report: null })
    .mockResolvedValueOnce({ status: "succeeded", report: getReport({ importId: "import-two", dryRun }) })
  const { notice } = openReview(fixture)

  await clickRun(dryRun)
  await act(async () => vi.advanceTimersByTimeAsync(1000))

  expect(screen.getByRole("alert")).toHaveTextContent(t("Import failed. Review the report and try again."))
  expect(
    within(screen.getByRole("alert")).getByText(
      t("The source archive contains an item that could not be imported. Check the source and try again."),
    ),
  ).toBeVisible()
  expect(
    within(screen.getByRole("alert")).getByText(t("A source file could not be copied. Check the source folder.")),
  ).toBeVisible()
  expect(screen.getByText(t("Import step", { step: 3 }))).toBeVisible()
  expect(screen.queryByText(t("Import finished"))).toBeNull()
  expect(screen.getByRole("button", { name: t("ob.retry") })).toBeEnabled()
  expect(screen.queryByRole("button", { name: t("Import now") })).toBeNull()
  expect(screen.getByRole("alert").closest("footer")).toContainElement(
    screen.getByRole("button", { name: t("ob.retry") }),
  )
  expect(document.querySelectorAll(".import-report-grid dd")).toHaveLength(4)
  expect(notice).not.toHaveBeenCalled()

  await act(async () => vi.advanceTimersByTimeAsync(60_000))

  expect(fixture.getStatus).toHaveBeenCalledTimes(2)
  expect(fixture.start).toHaveBeenCalledTimes(1)

  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: t("ob.retry") }))
  })

  expect(screen.queryByRole("alert")).toBeNull()
  expect(screen.queryByText(t("Report"))).toBeNull()
  expect(screen.getByRole("status")).toHaveTextContent(t("Waiting for the import result…"))
  expect(fixture.start.mock.calls.map(([options]) => options.dryRun)).toEqual([dryRun, dryRun])
  expect(fixture.getStatus).toHaveBeenNthCalledWith(3, "import-two", expect.any(AbortSignal))

  await act(async () => vi.advanceTimersByTimeAsync(1000))

  expect(screen.getByText(t("Import step", { step: dryRun ? 3 : 4 }))).toBeVisible()
  expect(screen.queryByRole("alert")).toBeNull()
  expect(notice).toHaveBeenCalledExactlyOnceWith(
    t(dryRun ? "Dry run complete. Nothing was written." : "Import complete. Imported routines stay disabled."),
  )
})

it("shows a completed dry-run report and clears it while the real import runs", async () => {
  vi.useFakeTimers()
  const fixture = getFixture()
  fixture.getStatus
    .mockResolvedValueOnce({ status: "running", report: null })
    .mockResolvedValueOnce({
      status: "succeeded",
      report: getReport({ dryRun: true, warnings: ["Routines will remain disabled."] }),
    })
    .mockResolvedValueOnce({ status: "running", report: null })
    .mockResolvedValueOnce({ status: "succeeded", report: getReport() })
  const { notice } = openReview(fixture)

  await clickRun(true)

  expect(screen.getByRole("status")).toBeVisible()
  expect(screen.queryByText(t("Report"))).toBeNull()
  expect(notice).not.toHaveBeenCalled()

  await act(async () => vi.advanceTimersByTimeAsync(1000))

  expect(screen.getByRole("heading", { name: t("Review a safe dry run") })).toBeVisible()
  expect(screen.getByText(t("Import step", { step: 3 }))).toBeVisible()
  expect(screen.getByText(t("All archive bots count", { count: 1 }))).toBeVisible()
  expect(within(getReportView()).getByText("23", { selector: "dd" })).toBeVisible()
  expect(within(getReportView()).getByText("4", { selector: "dd" })).toBeVisible()
  expect(screen.getByText(`⚠ ${t("Imported routines stay disabled.")}`)).toBeVisible()
  expect(screen.queryByText(t("History is in touri"))).toBeNull()
  expect(notice).toHaveBeenCalledExactlyOnceWith(t("Dry run complete. Nothing was written."))

  await clickRun(false)

  expect(screen.queryByText(t("Report"))).toBeNull()
  expect(screen.queryByText(t("Import finished"))).toBeNull()
  expect(screen.getByRole("status")).toBeVisible()
  expect(fixture.start.mock.calls.map(([options]) => options.dryRun)).toEqual([true, false])

  await act(async () => vi.advanceTimersByTimeAsync(1000))

  expect(screen.getByRole("heading", { name: t("Import finished") })).toBeVisible()
  expect(notice).toHaveBeenCalledTimes(2)
})

it("keeps waiting across long imports and a succeeded response without a report", async () => {
  vi.useFakeTimers()
  const fixture = getFixture()
  const { notice } = openReview(fixture)

  await clickRun(false)
  await act(async () => vi.advanceTimersByTimeAsync(180_000))

  expect(fixture.start).toHaveBeenCalledTimes(1)
  expect(fixture.getStatus).toHaveBeenCalledTimes(181)
  expect(screen.getByRole("status")).toBeVisible()
  expect(screen.getByRole("button", { name: t("Import now") })).toBeDisabled()
  expect(screen.queryByText(t("Import finished"))).toBeNull()
  expect(notice).not.toHaveBeenCalled()

  fixture.getStatus.mockResolvedValueOnce({ status: "succeeded", report: null })
  await act(async () => vi.advanceTimersByTimeAsync(1000))

  expect(screen.getByRole("status")).toHaveTextContent(t("Could not check the import status. Retrying…"))
  expect(screen.queryByText(t("Import finished"))).toBeNull()
  expect(notice).not.toHaveBeenCalled()

  fixture.getStatus.mockResolvedValueOnce({ status: "succeeded", report: getReport() })
  await act(async () => vi.advanceTimersByTimeAsync(1000))

  expect(screen.getByText(t("Import counts", { messages: 23, threads: 4 }))).toBeVisible()
  expect(fixture.start).toHaveBeenCalledTimes(1)
})

it("aborts a stalled status request and retries without overlapping polls or restarting the import", async () => {
  vi.useFakeTimers()
  const fixture = getFixture()
  fixture.getStatus
    .mockImplementationOnce((_id, signal) => waitForAbort(signal))
    .mockResolvedValueOnce({ status: "succeeded", report: getReport() })
  const { notice } = openReview(fixture)

  await clickRun(false)
  await act(async () => vi.advanceTimersByTimeAsync(29_999))

  expect(fixture.getStatus).toHaveBeenCalledTimes(1)
  expect(fixture.getStatus.mock.calls[0]?.[1]?.aborted).toBe(false)
  expect(notice).not.toHaveBeenCalled()

  await act(async () => vi.advanceTimersByTimeAsync(1))

  expect(fixture.getStatus.mock.calls[0]?.[1]?.aborted).toBe(true)
  expect(screen.getByRole("status")).toHaveTextContent(t("Could not check the import status. Retrying…"))
  expect(screen.getByRole("button", { name: t("Import now") })).toBeDisabled()
  expect(fixture.getStatus).toHaveBeenCalledTimes(1)
  expect(notice).not.toHaveBeenCalled()

  await act(async () => vi.advanceTimersByTimeAsync(1000))

  expect(fixture.getStatus).toHaveBeenCalledTimes(2)
  expect(fixture.start).toHaveBeenCalledTimes(1)
  expect(screen.getByText(t("Import counts", { messages: 23, threads: 4 }))).toBeVisible()
})

it("recovers a rejected status read on the same import", async () => {
  vi.useFakeTimers()
  const fixture = getFixture()
  fixture.getStatus
    .mockRejectedValueOnce(new Error("Status temporarily unavailable"))
    .mockResolvedValueOnce({ status: "running", report: null })
    .mockResolvedValueOnce({ status: "succeeded", report: getReport() })
  const { notice } = openReview(fixture)

  await clickRun(false)

  expect(screen.getByRole("status")).toHaveTextContent(t("Could not check the import status. Retrying…"))
  expect(notice).not.toHaveBeenCalled()

  await act(async () => vi.advanceTimersByTimeAsync(1000))

  expect(screen.getByRole("status")).toHaveTextContent(t("Waiting for the import result…"))

  await act(async () => vi.advanceTimersByTimeAsync(1000))

  expect(screen.getByRole("heading", { name: t("Import finished") })).toBeVisible()
  expect(fixture.start).toHaveBeenCalledTimes(1)
  expect(fixture.getStatus.mock.calls.map(([id]) => id)).toEqual(["import-one", "import-one", "import-one"])
})

it.each(["start", "status"] as const)("cancels an in-flight %s request on unmount", async (stage) => {
  vi.useFakeTimers()
  const fixture = getFixture()
  if (stage === "start") fixture.start.mockImplementationOnce((_options, signal) => waitForAbort(signal))
  if (stage === "status") fixture.getStatus.mockImplementationOnce((_id, signal) => waitForAbort(signal))
  const { view, notice } = openReview(fixture)

  await clickRun(false)
  view.unmount()
  await act(async () => vi.advanceTimersByTimeAsync(60_000))

  const signal = stage === "start" ? fixture.start.mock.calls[0]?.[1] : fixture.getStatus.mock.calls[0]?.[1]
  expect(signal?.aborted).toBe(true)
  expect(fixture.start).toHaveBeenCalledTimes(1)
  expect(fixture.getStatus).toHaveBeenCalledTimes(stage === "start" ? 0 : 1)
  expect(notice).not.toHaveBeenCalled()
})

it("clears the next poll on unmount", async () => {
  vi.useFakeTimers()
  const fixture = getFixture()
  const { view, notice } = openReview(fixture)

  await clickRun(false)
  view.unmount()
  await act(async () => vi.advanceTimersByTimeAsync(60_000))

  expect(fixture.getStatus).toHaveBeenCalledTimes(1)
  expect(fixture.start).toHaveBeenCalledTimes(1)
  expect(notice).not.toHaveBeenCalled()
})

it("ignores a late terminal response after unmount", async () => {
  vi.useFakeTimers()
  const fixture = getFixture()
  const pending = Promise.withResolvers<ImportStatus>()
  fixture.getStatus.mockReturnValueOnce(pending.promise)
  const { view, notice } = openReview(fixture)

  await clickRun(false)
  view.unmount()
  await act(async () => pending.resolve({ status: "succeeded", report: getReport() }))

  expect(fixture.getStatus.mock.calls[0]?.[1]?.aborted).toBe(true)
  expect(notice).not.toHaveBeenCalled()
})

it("times out a stalled start request with a visible retry action", async () => {
  vi.useFakeTimers()
  const fixture = getFixture()
  fixture.start.mockImplementationOnce((_options, signal) => waitForAbort(signal))
  const { notice } = openReview(fixture)

  await clickRun(false)
  await act(async () => vi.advanceTimersByTimeAsync(30_000))

  expect(fixture.start.mock.calls[0]?.[1]?.aborted).toBe(true)
  expect(fixture.getStatus).not.toHaveBeenCalled()
  expect(screen.getByRole("alert")).toHaveTextContent(t("The import adapter is unavailable."))
  expect(screen.getByRole("button", { name: t("ob.retry") })).toBeEnabled()
  expect(screen.queryByRole("button", { name: t("Import now") })).toBeNull()
  expect(screen.getByRole("alert").closest("footer")).toContainElement(
    screen.getByRole("button", { name: t("ob.retry") }),
  )
  expect(document.querySelectorAll(".import-report-grid dd")).toHaveLength(0)
  expect(screen.queryByText(t("Import finished"))).toBeNull()
  expect(notice).toHaveBeenCalledExactlyOnceWith(t("The import adapter is unavailable."))
})

const getFixture = () => {
  const base = createMockApi()
  const start = vi
    .fn<(options: LegacyImportOptions, signal?: AbortSignal) => Promise<{ importId: string }>>()
    .mockResolvedValue({ importId: "import-one" })
  const getStatus = vi
    .fn<(id: string | undefined, signal?: AbortSignal) => Promise<ImportStatus>>()
    .mockResolvedValue({ status: "running", report: null })
  const request = (async (route, input, path, transport) => {
    if (route === "POST /imports/legacy") return start(input as LegacyImportOptions, transport?.signal)
    if (route === "GET /imports/:id") return getStatus(path?.id, transport?.signal)

    return base.request(route, input, path, transport)
  }) as ApiRequest
  const api: UiApi = { request, subscribe: base.subscribe, isMock: true }

  return { api, bots: base.getState().bots.slice(0, 1), start, getStatus }
}

const openReview = (fixture: ReturnType<typeof getFixture>) => {
  const notice = vi.fn()
  const view = render(
    <StrictMode>
      <ImportWizard bots={fixture.bots} api={fixture.api} onClose={vi.fn()} onNotice={notice} />
    </StrictMode>,
  )

  fireEvent.change(screen.getByLabelText(t("legacy app root")), { target: { value: "/tmp/legacy-fixture" } })
  fireEvent.click(screen.getByRole("button", { name: t("Continue") }))
  fireEvent.click(screen.getByRole("button", { name: t("Review import") }))

  return { view, notice }
}

const clickRun = (dryRun: boolean) =>
  act(async () => {
    fireEvent.click(screen.getByRole("button", { name: t(dryRun ? "Run dry run" : "Import now") }))
  })

const getCounts = (created: number): ImportCounts => ({ created, updated: 0, unchanged: 0, skipped: 0 })

const getReport = ({ importId = "import-one", dryRun = false, warnings = [] as string[] } = {}): ImportReport => ({
  importId,
  origin: "/tmp/legacy-fixture",
  dryRun,
  bots: getCounts(1),
  threads: getCounts(4),
  messages: getCounts(23),
  routines: getCounts(0),
  attachments: getCounts(0),
  codexSessions: getCounts(0),
  memoryFiles: getCounts(0),
  droppedMessageKinds: {},
  warnings,
})

const getReportView = (): HTMLElement => {
  const report = screen.getByText(t("Report")).parentElement
  if (!report) throw new Error("Missing import report")

  return report
}

const waitForAbort = (signal?: AbortSignal): Promise<never> => {
  if (!signal) throw new Error("Missing request cancellation")
  signal.throwIfAborted()

  return new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true })
  })
}
