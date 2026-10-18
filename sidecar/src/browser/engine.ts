import { AsyncLocalStorage } from "node:async_hooks"
import type {
  BrowserActionRecord,
  BrowserDiagnostic,
  BrowserElement,
  BrowserErrorCode,
  BrowserSnapshot,
  BrowserTarget,
  Id,
  Kernel,
  ToolContent,
  ToolContext,
  ToolResult,
} from "@touri/contracts"
import { approveSecretRelease } from "../approvals/secrets"
import { createBackgroundTask, getMeasuredStage, yieldBackground } from "../kernel/background-task"
import type { PerformanceStageRunner } from "../kernel/performance"
import { hostPlatform } from "../platform"
import * as macos from "../platform/macos"
import { CHALLENGE_ELEMENT_IDS, classifyBlockedPage, describeBlockedPage } from "./blockedPage"
import {
  type ChromeLauncher,
  createChromeLauncher,
  deriveChromeWindowConfig,
  LocalBrowserUnavailableError,
} from "./launcher"
import { assignLegacyCookies } from "./legacyCookieMigration"
import { describeNavigationFailure, isChromeErrorPage, isLoadableUrl, networkErrorCode, stripHash } from "./navigation"
import { withOneTransientRetry } from "./retry"
import {
  emptySession,
  loadBotSession,
  type SavedCookie,
  type SavedSession,
  SessionVaultError,
  saveBotSession,
} from "./sessionVault"
import { createBrowserStore, publicTabInfo } from "./store"
import type {
  BrowserEngine,
  BrowserFailure,
  CdpClient,
  CdpEvent,
  CdpTargetInfo,
  CoveringElement,
  Fingerprint,
  JsonObject,
  NodeRef,
  TabState,
  WindowBounds,
} from "./types"
import { BROWSER_URL_NOT_ALLOWED_MESSAGE, isReadableTabUrl, normalizeBrowserUrl } from "./urlPolicy"
import {
  asArray,
  asBoolean,
  asNumber,
  asRecord,
  asString,
  clamp,
  errorMessage,
  propertyValue,
  raceBudget,
  sleep,
  stringProperty,
} from "./utils"

const DEFAULT_NAVIGATION_BUDGET_MS = 10000
const NAVIGATION_POLL_MS = 50
const LOAD_IDLE_CAP_MS = 3000
const DEADLINE_SLACK_MS = 1000
const DEFAULT_TOOL_TIMEOUT_MS = 10000
const SIDE_EFFECT_BUDGET_MS = 2000
const POPUP_WAIT_MS = 1500
const ENABLED_WAIT_MS = 1500

const actionableRoles = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "combobox",
  "listbox",
  "option",
  "checkbox",
  "radio",
  "switch",
  "tab",
  "menuitem",
  "slider",
  "spinbutton",
  "treeitem",
  "heading",
])
const MAX_SNAPSHOT_NODES = 200
const AX_NODE_INSPECTION_BATCH_SIZE = 32

type PageState = {
  url: string
  title: string
  loading: boolean
  readyState: string
  viewport: { width: number; height: number; scrollY: number; scrollHeight: number }
  text: string
  hasCanvas: boolean
  hasVideo: boolean
  crossOriginIframe: boolean
  active: { role: string; name: string; backendNodeId: number | null }
  mutationVersion: number
}

type AxNode = JsonObject
type OperationFailure = { success: false; failure: BrowserFailure }
type ResolveResult = { success: true; node: NodeRef | null; point: { x: number; y: number } | null } | OperationFailure
type OperationResult<T> = { success: true; value: T } | { success: false; failure: BrowserFailure }
type ImageMode = "auto" | "always" | "never"

const failure = (errorCode: BrowserErrorCode, error: string, covering?: CoveringElement): OperationFailure => ({
  success: false,
  failure: { errorCode, error, ...(covering === undefined ? {} : { covering }) },
})

const success = <T>(value: T): OperationResult<T> => ({ success: true, value })

const toToolError = (item: BrowserFailure): ToolResult => ({
  success: false,
  errorCode: item.errorCode,
  error: item.error,
  ...(item.covering === undefined
    ? {}
    : { content: [{ type: "text", text: `Covering element: ${item.covering.role} "${item.covering.name}"` }] }),
})

const BLOCKED_PAGE_HEADERS = new Set(["server", "cf-mitigated"])

/** Keeps only the response headers the blocked-page classifier reads, names in lower case. */
const blockedPageHeaders = (value: unknown): Record<string, string> => {
  const headers: Record<string, string> = {}
  for (const [name, header] of Object.entries(asRecord(value) ?? {})) {
    const key = name.toLowerCase()
    const text = asString(header)
    if (BLOCKED_PAGE_HEADERS.has(key) && text !== null) headers[key] = text.slice(0, 200)
  }
  return headers
}

const toToolSuccess = ({ content, structured }: { content: Array<ToolContent>; structured?: unknown }): ToolResult => ({
  success: true,
  content,
  ...(structured === undefined ? {} : { structured }),
})

const cdpResult = (value: unknown): JsonObject => asRecord(value) ?? {}

const eventValue = (event: CdpEvent, key: string): unknown => event.params[key]

const targetInfo = (value: unknown): CdpTargetInfo | null => {
  const item = asRecord(value)
  const targetId = asString(item?.targetId)
  const type = asString(item?.type)
  const title = asString(item?.title)
  const url = asString(item?.url)
  if (!targetId || !type || title === null || url === null) return null
  const openerId = asString(item?.openerId)
  return { targetId, type, title, url, ...(openerId === null ? {} : { openerId }) }
}

const waitForEvent = async ({
  client,
  method,
  sessionId,
  timeoutMs,
  signal,
  predicate,
}: {
  client: CdpClient
  method: string
  sessionId?: string
  timeoutMs: number
  signal?: AbortSignal
  predicate?: (event: CdpEvent) => boolean
}): Promise<CdpEvent> =>
  new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const unsubscribe = client.subscribe((event) => {
      if (event.method !== method || (sessionId !== undefined && event.sessionId !== sessionId)) return
      if (predicate && !predicate(event)) return
      if (timer) clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
      unsubscribe()
      resolve(event)
    })
    const onAbort = (): void => {
      if (timer) clearTimeout(timer)
      unsubscribe()
      reject(new Error("Operation aborted"))
    }
    if (signal?.aborted) {
      onAbort()
      return
    }
    signal?.addEventListener("abort", onAbort, { once: true })
    timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      unsubscribe()
      reject(new Error(`Timed out waiting for ${method}`))
    }, timeoutMs)
  })

const operationSignals = new AsyncLocalStorage<AbortSignal>()

const SIDE_EFFECT_METHODS: ReadonlyArray<string> = [
  "Page.navigate",
  "Page.reload",
  "Page.goBack",
  "Page.goForward",
  "Page.navigateToHistoryEntry",
  "DOM.setFileInputFiles",
]

const isSideEffectMethod = (method: string): boolean =>
  method.startsWith("Input.") || SIDE_EFFECT_METHODS.includes(method)

const cdpCall = async <T>(client: CdpClient, method: string, params: JsonObject, sessionId: string): Promise<T> => {
  const signal = operationSignals.getStore()
  if (signal?.aborted && isSideEffectMethod(method)) throw new Error("A operação do navegador foi cancelada.")
  return client.call<T>(method, params, sessionId)
}

const responseText = (value: unknown): string => {
  const item = asRecord(value)
  const argument = asRecord(item?.value)
  if (argument && typeof argument === "object") return JSON.stringify(argument)
  return asString(item?.description) ?? asString(item?.value) ?? ""
}

const runtimeValue = async <T>(client: CdpClient, expression: string, sessionId: string): Promise<T | null> => {
  const result = cdpResult(
    await cdpCall<unknown>(
      client,
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: false },
      sessionId,
    ),
  )
  const exception = asRecord(result.exceptionDetails)
  if (exception) throw new Error(asString(exception.text) ?? "Page evaluation failed")
  const remote = asRecord(result.result)
  return (remote?.value as T | undefined) ?? null
}

const nodeName = (node: AxNode): string => stringProperty(node.role)
const nodeNameText = (node: AxNode): string => stringProperty(node.name)

const boolProperty = (node: AxNode, name: string): boolean => {
  for (const property of asArray(node.properties)) {
    const item = asRecord(property)
    if (asString(item?.name) === name) return asBoolean(propertyValue(item?.value)) === true
  }
  return false
}

const nodeStates = (node: AxNode): BrowserElement["states"] => {
  const states: BrowserElement["states"] = []
  const names: Array<[string, BrowserElement["states"][number]]> = [
    ["checked", "checked"],
    ["disabled", "disabled"],
    ["expanded", "expanded"],
    ["focused", "focused"],
    ["selected", "selected"],
    ["required", "required"],
    ["readonly", "readonly"],
  ]
  for (const [property, state] of names) if (boolProperty(node, property)) states.push(state)
  return states
}

const quadBounds = (quad: Array<unknown>): Array<number> | null => {
  const values = quad.map(asNumber)
  if (values.some((item) => item === null) || values.length < 8) return null
  const points = values as Array<number>
  const xs = [points[0] ?? 0, points[2] ?? 0, points[4] ?? 0, points[6] ?? 0]
  const ys = [points[1] ?? 0, points[3] ?? 0, points[5] ?? 0, points[7] ?? 0]
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
}

const descriptionAttributes = (value: unknown): { tag: string; password: boolean; oneTimeCode: boolean } => {
  const node = asRecord(value)
  const tag = asString(node?.nodeName)?.toLowerCase() ?? "div"
  const attributes = asArray(node?.attributes)
  let password = false
  let oneTimeCode = false
  for (let index = 0; index + 1 < attributes.length; index += 2) {
    const attribute = asString(attributes[index])?.toLowerCase()
    const attributeValue = asString(attributes[index + 1])?.toLowerCase() ?? ""
    if (attribute === "type" && attributeValue === "password") password = true
    if (
      (attribute === "autocomplete" && attributeValue.includes("one-time-code")) ||
      (attribute === "name" && /(otp|code|token)/.test(attributeValue))
    )
      oneTimeCode = true
  }
  return { tag, password, oneTimeCode }
}

const getBox = async (client: CdpClient, sessionId: string, backendNodeId: number): Promise<Array<number> | null> => {
  try {
    const result = cdpResult(await cdpCall<unknown>(client, "DOM.getBoxModel", { backendNodeId }, sessionId))
    const modelBounds = quadBounds(asArray(asRecord(result.model)?.content))
    if (modelBounds) return modelBounds
    const quads = cdpResult(await cdpCall<unknown>(client, "DOM.getContentQuads", { backendNodeId }, sessionId))
    const firstQuad = asArray(quads.quads)[0]
    return quadBounds(asArray(firstQuad))
  } catch {
    try {
      const quads = cdpResult(await cdpCall<unknown>(client, "DOM.getContentQuads", { backendNodeId }, sessionId))
      return quadBounds(asArray(asArray(quads.quads)[0]))
    } catch {
      return null
    }
  }
}

const describe = async (
  client: CdpClient,
  sessionId: string,
  backendNodeId: number,
): Promise<{ tag: string; password: boolean; oneTimeCode: boolean; href: string }> => {
  try {
    const result = cdpResult(await cdpCall<unknown>(client, "DOM.describeNode", { backendNodeId }, sessionId))
    const node = asRecord(result.node)
    const attributes = asArray(node?.attributes)
    const hrefIndex = attributes.indexOf("href")
    return { ...descriptionAttributes(node), href: hrefIndex >= 0 ? (asString(attributes[hrefIndex + 1]) ?? "") : "" }
  } catch {
    return { tag: "div", password: false, oneTimeCode: false, href: "" }
  }
}

const fingerprintForNode = async ({
  client,
  sessionId,
  backendNodeId,
  accessibility = false,
}: {
  client: CdpClient
  sessionId: string
  backendNodeId: number
  accessibility?: boolean
}): Promise<Fingerprint> => {
  if (accessibility) {
    const [partial, descriptor] = await Promise.all([
      cdpCall<unknown>(client, "Accessibility.getPartialAXTree", { backendNodeId, fetchRelatives: false }, sessionId),
      describe(client, sessionId, backendNodeId),
    ])
    const node = asArray(cdpResult(partial).nodes)
      .map(asRecord)
      .find((node) => node?.backendDOMNodeId === backendNodeId && node.ignored !== true)
    if (!node) throw new Error("Node is detached")
    const name = nodeNameText(node)
    return {
      role: nodeName(node),
      name,
      tag: descriptor.tag,
      textPrefix: name.slice(0, 40),
      href: descriptor.href,
      source: "ax",
    }
  }
  const resolved = cdpResult(await cdpCall<unknown>(client, "DOM.resolveNode", { backendNodeId }, sessionId))
  const objectId = asString(asRecord(resolved.object)?.objectId)
  if (!objectId) throw new Error("Node is detached")
  const result = cdpResult(
    await cdpCall<unknown>(
      client,
      "Runtime.callFunctionOn",
      {
        objectId,
        functionDeclaration: `function () {
      const element = this;
      if (!element.isConnected) return null;
      const role = element.getAttribute('role') || ({BUTTON:'button',A:'link',INPUT:(element.type === 'search' ? 'searchbox' : 'textbox'),SELECT:'combobox',TEXTAREA:'textbox',H1:'heading',H2:'heading',H3:'heading',H4:'heading',H5:'heading',H6:'heading'}[element.tagName] || 'generic');
      const name = element.getAttribute('aria-label') || element.getAttribute('name') || element.innerText || element.value || '';
      return { role, name: String(name).trim(), tag: element.tagName.toLowerCase(), textPrefix: String(element.innerText || element.textContent || '').trim().slice(0, 40), href: element.getAttribute('href') || '' };
    }`,
        returnByValue: true,
      },
      sessionId,
    ),
  )
  const value = asRecord(asRecord(result.result)?.value)
  if (!value) throw new Error("Node is detached")
  return {
    role: asString(value.role) ?? "generic",
    name: asString(value.name) ?? "",
    tag: asString(value.tag) ?? "div",
    textPrefix: asString(value.textPrefix) ?? "",
    href: asString(value.href) ?? "",
  }
}

const treeNodes = (value: unknown): Array<JsonObject> => {
  const result: Array<JsonObject> = []
  const visit = (item: unknown): void => {
    const node = asRecord(item)
    if (!node) return
    result.push(node)
    for (const child of asArray(node.children)) visit(child)
    visit(node.contentDocument)
    for (const shadowRoot of asArray(node.shadowRoots)) visit(shadowRoot)
  }
  visit(value)
  return result
}

const documentRoots = (document: JsonObject): Array<number> => {
  const roots: Array<number> = []
  for (const node of treeNodes(document.root)) {
    const nodeType = asNumber(node.nodeType)
    const nodeId = asNumber(node.nodeId)
    if (nodeId !== null && (nodeType === 9 || nodeType === 11)) roots.push(nodeId)
  }
  return [...new Set(roots)]
}

const tabSessions = (tab: TabState): Array<string> =>
  tab.sessionId === null
    ? []
    : [tab.sessionId, ...tab.frameSessions.values()].filter((value, index, values) => values.indexOf(value) === index)

const collectDomCandidates = async ({ client, tab }: { client: CdpClient; tab: TabState }): Promise<Array<NodeRef>> => {
  const candidates: Array<NodeRef> = []
  for (const sessionId of tabSessions(tab)) {
    try {
      const document = cdpResult(
        await cdpCall<unknown>(client, "DOM.getDocument", { depth: -1, pierce: true }, sessionId),
      )
      const roots = documentRoots(document)
      const nodeIds = new Set<number>()
      for (const root of roots) {
        const query = cdpResult(
          await cdpCall<unknown>(
            client,
            "DOM.querySelectorAll",
            { nodeId: root, selector: "button,a,input,select,textarea,[role],h1,h2,h3,h4,h5,h6" },
            sessionId,
          ),
        )
        for (const nodeId of asArray(query.nodeIds)
          .map(asNumber)
          .filter((item): item is number => item !== null))
          nodeIds.add(nodeId)
      }
      for (const nodeId of [...nodeIds].slice(0, 10000)) {
        try {
          const described = cdpResult(await cdpCall<unknown>(client, "DOM.describeNode", { nodeId }, sessionId))
          const backendNodeId = asNumber(asRecord(described.node)?.backendNodeId)
          if (!backendNodeId) continue
          const fingerprint = await fingerprintForNode({ client, sessionId, backendNodeId })
          if (!actionableRoles.has(fingerprint.role)) continue
          const bounds = await getBox(client, sessionId, backendNodeId)
          if (!bounds) continue
          candidates.push({
            ref: `${tab.generation}.${candidates.length}`,
            sessionId,
            backendNodeId,
            fingerprint,
            frame: sessionId,
            role: fingerprint.role,
            name: fingerprint.name,
            states: [],
            bounds,
          })
        } catch {}
      }
    } catch {}
  }
  return candidates
}

const addRing = <T>(ring: Array<T>, value: T, limit: number): void => {
  ring.push(value)
  if (ring.length > limit) ring.splice(0, ring.length - limit)
}

const recordDiagnostic = (tab: TabState, diagnostic: BrowserDiagnostic): void => {
  if (tab.secretMode) return
  addRing(tab.diagnostics, diagnostic, 100)
}

const recordAction = (tab: TabState, action: BrowserActionRecord): void => {
  addRing(tab.actions, action, 100)
}

const actionKey = ({ tool, target, args }: { tool: string; target: unknown; args: unknown }): string => {
  try {
    return JSON.stringify({ tool, target, args })
  } catch {
    return `${tool}:${String(target)}`
  }
}

const sessionLostPattern =
  /Session with given id not found|No session with given id|Target closed|No target with given id|Inspected target navigated or closed|Target page, context or browser has been closed/i

const isSessionLost = (error: unknown): boolean => sessionLostPattern.test(errorMessage(error))

const isDeadlineError = (message: string): boolean =>
  message.includes("deadline exceeded") || message.includes("Timed out") || message.includes("Operation aborted")

const causeHint = (message: string): string => {
  const clean = message
    .replace(/[^\p{L}\p{N} .,:;()'"/_-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100)
  return clean === "" ? "" : ` Causa técnica: ${clean}.`
}

const browserError = (error: unknown): BrowserFailure => {
  if (error instanceof LocalBrowserUnavailableError) return { errorCode: error.errorCode, error: error.message }
  const message = errorMessage(error)
  if (isDeadlineError(message)) {
    return {
      errorCode: "DEADLINE_EXCEEDED",
      error:
        "O navegador não concluiu a operação no prazo. A página pode estar travada ou lenta: execute browser_snapshot ou tente de novo com timeoutMs maior.",
    }
  }
  if (
    message.includes("Execution context was destroyed") ||
    message.includes("Cannot find context with specified id") ||
    message.includes("Node is detached")
  ) {
    return {
      errorCode: "TARGET_CHANGED",
      error: "A página mudou durante a operação. Execute browser_snapshot e tente de novo com o ref atual.",
    }
  }
  if (isSessionLost(error)) {
    return {
      errorCode: "ENGINE_UNAVAILABLE",
      error:
        "A aba perdeu a conexão com o navegador (foi fechada ou recarregada pelo Chrome). Abra a página de novo com browser_open.",
    }
  }
  return {
    errorCode: "ENGINE_UNAVAILABLE",
    error: `O navegador não conseguiu concluir a operação.${causeHint(message)}`,
  }
}

const isTransient = (error: unknown): boolean => {
  const message = errorMessage(error)
  return (
    message.includes("Execution context was destroyed") ||
    message.includes("Cannot find context with specified id") ||
    message.includes("Node is detached") ||
    isSessionLost(error)
  )
}

const queueTab = <T>(tab: TabState, operation: () => Promise<T>): Promise<T> => {
  const previous = tab.queue
  const current = previous.catch(() => undefined).then(operation)
  tab.queue = current.then(
    () => undefined,
    () => undefined,
  )
  return current
}

const withDeadline = async <T>({
  operation,
  timeoutMs,
  signal,
  onTimeout,
}: {
  operation: (signal: AbortSignal) => Promise<T>
  timeoutMs: number
  signal: AbortSignal
  onTimeout: () => Promise<void>
}): Promise<T> => {
  if (signal.aborted) throw new Error("A operação do navegador foi cancelada antes de começar.")
  const controller = new AbortController()
  const forwardAbort = (): void => controller.abort()
  signal.addEventListener("abort", forwardAbort, { once: true })
  let timedOut = false
  let cleanup: Promise<void> | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  const work = operationSignals.run(controller.signal, () => operation(controller.signal))
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true
      controller.abort()
      cleanup = Promise.race([onTimeout().catch(() => undefined), sleep(500).catch(() => undefined)])
      reject(new Error("Operation deadline exceeded"))
    }, timeoutMs)
  })
  try {
    return await Promise.race([work, deadline])
  } finally {
    if (timer) clearTimeout(timer)
    signal.removeEventListener("abort", forwardAbort)
    if (timedOut) await (cleanup ?? Promise.resolve())
  }
}

export { withDeadline }

const isNodeDisabled = async (client: CdpClient, node: NodeRef): Promise<boolean> => {
  const resolved = cdpResult(
    await cdpCall<unknown>(client, "DOM.resolveNode", { backendNodeId: node.backendNodeId }, node.sessionId),
  )
  const objectId = asString(asRecord(resolved.object)?.objectId)
  if (!objectId) return false
  const result = cdpResult(
    await cdpCall<unknown>(
      client,
      "Runtime.callFunctionOn",
      {
        objectId,
        functionDeclaration:
          "function () { return this.disabled === true || this.getAttribute('aria-disabled') === 'true'; }",
        returnByValue: true,
      },
      node.sessionId,
    ),
  )
  return asBoolean(asRecord(result.result)?.value) === true
}

const waitUntilEnabled = async ({
  client,
  node,
  signal,
}: {
  client: CdpClient
  node: NodeRef
  signal: AbortSignal
}): Promise<boolean> => {
  const endsAt = Date.now() + ENABLED_WAIT_MS
  while (Date.now() < endsAt) {
    const disabled = await isNodeDisabled(client, node).catch(() => false)
    if (!disabled) return true
    await sleep(50, signal)
  }
  return !(await isNodeDisabled(client, node).catch(() => false))
}

const focusNode = async (client: CdpClient, node: NodeRef): Promise<void> => {
  await cdpCall(client, "DOM.focus", { backendNodeId: node.backendNodeId }, node.sessionId)
}

const SELECT_FIELD_CONTENTS = `function(){const t=this;if(typeof t.select==="function"){try{t.select();return true}catch(e){}}if(t.isContentEditable){const r=document.createRange();r.selectNodeContents(t);const s=getSelection();s.removeAllRanges();s.addRange(r)}return true}`
const FIELD_IS_EMPTY = `function(){const t=this;if("value" in t)return String(t.value||"")==="";return (t.textContent||"")===""}`
const FORCE_CLEAR_FIELD = `function(){const t=this;if("value" in t){const proto=t instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;const setter=Object.getOwnPropertyDescriptor(proto,"value")?.set;if(setter)setter.call(t,"");else t.value=""}else{t.textContent=""}t.dispatchEvent(new InputEvent("input",{bubbles:true,inputType:"deleteContentBackward"}));t.dispatchEvent(new Event("change",{bubbles:true}));return true}`
const BACKSPACE_KEY_CODE = 8

const callOnNode = async (client: CdpClient, node: NodeRef, functionDeclaration: string): Promise<unknown> => {
  const resolved = cdpResult(
    await cdpCall<unknown>(client, "DOM.resolveNode", { backendNodeId: node.backendNodeId }, node.sessionId),
  )
  const objectId = asString(asRecord(resolved.object)?.objectId)
  if (!objectId) throw new Error("Node is detached")
  const result = cdpResult(
    await cdpCall<unknown>(
      client,
      "Runtime.callFunctionOn",
      { objectId, functionDeclaration, returnByValue: true },
      node.sessionId,
    ),
  )

  return asRecord(result.result)?.value
}

const elementFromPoint = async ({
  client,
  node,
  x,
  y,
}: {
  client: CdpClient
  node: NodeRef
  x: number
  y: number
}): Promise<{ qualifies: boolean; role: string; name: string }> => {
  const resolved = cdpResult(
    await cdpCall<unknown>(client, "DOM.resolveNode", { backendNodeId: node.backendNodeId }, node.sessionId),
  )
  const objectId = asString(asRecord(resolved.object)?.objectId)
  if (!objectId) throw new Error("Node is detached")
  const result = cdpResult(
    await cdpCall<unknown>(
      client,
      "Runtime.callFunctionOn",
      {
        objectId,
        functionDeclaration: `function (x, y) {
      const target = this;
      const hit = document.elementFromPoint(x, y);
      const label = hit && hit.closest ? hit.closest('label') : null;
      const qualifies = !!hit && (hit === target || target.contains(hit) || label === target || (label && label.htmlFor && label.htmlFor === target.id));
      const role = hit ? (hit.getAttribute('role') || hit.tagName.toLowerCase()) : 'unknown';
      const name = hit ? String(hit.getAttribute('aria-label') || hit.innerText || hit.value || '').trim().slice(0, 120) : '';
      return { qualifies, role, name };
    }`,
        arguments: [{ value: x }, { value: y }],
        returnByValue: true,
      },
      node.sessionId,
    ),
  )
  const value = asRecord(asRecord(result.result)?.value)
  return {
    qualifies: asBoolean(value?.qualifies) === true,
    role: asString(value?.role) ?? "unknown",
    name: asString(value?.name) ?? "",
  }
}

const cdpNodeContains = async ({
  client,
  sessionId,
  ancestorBackendNodeId,
  descendantBackendNodeId,
}: {
  client: CdpClient
  sessionId: string
  ancestorBackendNodeId: number
  descendantBackendNodeId: number
}): Promise<boolean> => {
  if (ancestorBackendNodeId === descendantBackendNodeId) return true
  const described = cdpResult(
    await cdpCall<unknown>(
      client,
      "DOM.describeNode",
      { backendNodeId: ancestorBackendNodeId, depth: -1, pierce: true },
      sessionId,
    ),
  )
  return treeNodes(described.node).some((node) => asNumber(node.backendNodeId) === descendantBackendNodeId)
}

const cdpLabelQualifies = async ({
  client,
  sessionId,
  targetBackendNodeId,
  hitBackendNodeId,
}: {
  client: CdpClient
  sessionId: string
  targetBackendNodeId: number
  hitBackendNodeId: number
}): Promise<boolean> => {
  try {
    const target = cdpResult(
      await cdpCall<unknown>(client, "DOM.resolveNode", { backendNodeId: targetBackendNodeId }, sessionId),
    )
    const hit = cdpResult(
      await cdpCall<unknown>(client, "DOM.resolveNode", { backendNodeId: hitBackendNodeId }, sessionId),
    )
    const targetObjectId = asString(asRecord(target.object)?.objectId)
    const hitObjectId = asString(asRecord(hit.object)?.objectId)
    if (!targetObjectId || !hitObjectId) return false
    const result = cdpResult(
      await cdpCall<unknown>(
        client,
        "Runtime.callFunctionOn",
        {
          objectId: targetObjectId,
          functionDeclaration: `function (hit) {
            const label = hit && hit.closest ? hit.closest('label') : null;
            return !!label && (label.control === this || (label.htmlFor && label.htmlFor === this.id));
          }`,
          arguments: [{ objectId: hitObjectId }],
          returnByValue: true,
        },
        sessionId,
      ),
    )
    return (
      asBoolean(asRecord(asRecord(result.result)?.value)) === true || asBoolean(asRecord(result.result)?.value) === true
    )
  } catch {
    return false
  }
}

const pageState = async (client: CdpClient, tab: TabState): Promise<PageState> => {
  if (!tab.sessionId) throw new Error("Tab is not attached")
  const state = await runtimeValue<PageState>(
    client,
    `(() => {
    const body = document.body;
    const text = body ? (body.innerText || '') : (document.documentElement?.innerText || '');
    const childFrameText = Array.from(document.querySelectorAll('iframe')).map((frame) => {
      try { return frame.contentDocument?.body?.innerText || ''; } catch { return ''; }
    }).filter((value) => value.length > 0).join('\\n');
    const active = document.activeElement;
    const name = active ? String(active.getAttribute('aria-label') || active.getAttribute('name') || active.innerText || active.value || '').trim() : '';
    const role = active ? (active.getAttribute('role') || ({BUTTON:'button',A:'link',INPUT:(active.type === 'search' ? 'searchbox' : 'textbox'),SELECT:'combobox',TEXTAREA:'textbox'}[active.tagName] || 'generic')) : '';
    return { url: location.href, title: document.title, loading: document.readyState !== 'complete', readyState: document.readyState,
      viewport: { width: innerWidth, height: innerHeight, scrollY: scrollY, scrollHeight: Math.max(document.body?.scrollHeight || 0, document.documentElement?.scrollHeight || 0) },
      text: childFrameText ? text + '\\n' + childFrameText : text, hasCanvas: !!document.querySelector('canvas'), hasVideo: !!document.querySelector('video'),
      crossOriginIframe: Array.from(document.querySelectorAll('iframe')).some((frame) => { try { return new URL(frame.src, location.href).origin !== location.origin; } catch { return false; } }),
      active: { role, name, backendNodeId: null }, mutationVersion: Number(window.__touriMutationVersion || 0) };
  })()`,
    tab.sessionId,
  )
  if (!state) throw new Error("Page state was unavailable")
  return state
}

const installMutationObserver = async (client: CdpClient, tab: TabState, sessionId?: string): Promise<void> => {
  const targetSessionId = sessionId ?? tab.sessionId
  if (!targetSessionId) return
  await runtimeValue<unknown>(
    client,
    `(() => {
    if (!window.__touriMutationObserver) {
      window.__touriMutationVersion = 0;
      window.__touriMutationObserver = new MutationObserver(() => { window.__touriMutationVersion += 1; });
      window.__touriMutationObserver.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    }
    return true;
  })()`,
    targetSessionId,
  )
}

const settle = async (client: CdpClient, tab: TabState, signal: AbortSignal): Promise<void> => {
  const settleFrames = async (): Promise<void> => {
    const frameSessions = tabSessions(tab).slice(1)
    if (frameSessions.length === 0) return
    const started = Date.now()
    while (Date.now() - started < 1500) {
      const states = await Promise.all(
        frameSessions.map(async (sessionId) => {
          try {
            return await runtimeValue<{ readyState: string; url: string; text: string }>(
              client,
              "({readyState: document.readyState, url: location.href, text: document.body?.innerText || ''})",
              sessionId,
            )
          } catch {
            return null
          }
        }),
      )
      if (states.every((state) => state !== null && state.readyState === "complete" && state.url !== "about:blank"))
        return
      await sleep(50, signal)
    }
  }
  await sleep(50, signal)
  if (tab.dialog) return
  const started = Date.now()
  let lastMutation = -1
  let quietAt = Date.now()
  while (Date.now() - started < 1500) {
    const state = await pageState(client, tab)
    if (tab.dialog) return
    if (state.readyState === "complete" && state.mutationVersion === lastMutation) {
      if (Date.now() - quietAt >= 250) {
        await settleFrames()
        return
      }
    } else {
      lastMutation = state.mutationVersion
      quietAt = Date.now()
    }
    await sleep(50, signal)
  }
  await settleFrames()
}

const axNodes = async (client: CdpClient, sessionId: string): Promise<Array<AxNode>> => {
  const result = cdpResult(await cdpCall<unknown>(client, "Accessibility.getFullAXTree", {}, sessionId))
  return asArray(result.nodes)
    .slice(0, 10000)
    .map((item) => asRecord(item))
    .filter((item): item is JsonObject => item !== null)
}

const nodeRefFromAx = async ({
  client,
  sessionId,
  generation,
  node,
  index,
}: {
  client: CdpClient
  sessionId: string
  generation: number
  node: AxNode
  index: number
}): Promise<NodeRef | null> => {
  const role = nodeName(node)
  const name = nodeNameText(node)
  const backendNodeId = asNumber(node.backendDOMNodeId)
  if (!backendNodeId || !actionableRoles.has(role) || asBoolean(node.ignored) === true) return null
  const bounds = await getBox(client, sessionId, backendNodeId)
  if (!bounds) return null
  const descriptor = await describe(client, sessionId, backendNodeId)
  const axValue = stringProperty(node.value)
  return {
    ref: `${generation}.${index}`,
    sessionId,
    backendNodeId,
    fingerprint: {
      role,
      name,
      tag: descriptor.tag,
      textPrefix: name.slice(0, 40),
      href: descriptor.href,
      source: "ax",
    },
    frame: sessionId,
    role,
    name,
    ...(descriptor.password || descriptor.oneTimeCode || axValue.length === 0 ? {} : { value: axValue }),
    states: nodeStates(node),
    bounds,
  }
}

const getAxNodeRefs = async ({
  client,
  sessionId,
  generation,
  nodes,
  index,
}: {
  client: CdpClient
  sessionId: string
  generation: number
  nodes: Array<AxNode>
  index: number
}): Promise<Array<NodeRef>> => {
  const batches = Array.from({ length: Math.ceil(nodes.length / AX_NODE_INSPECTION_BATCH_SIZE) }, (_, batchIndex) =>
    nodes.slice(batchIndex * AX_NODE_INSPECTION_BATCH_SIZE, (batchIndex + 1) * AX_NODE_INSPECTION_BATCH_SIZE),
  )
  // Keep the CDP fan-out bounded while processing each batch.
  let nodeRefs: Array<NodeRef> = []
  for (const batch of batches) {
    const batchRefs = await Promise.all(
      batch.map((node, nodeIndex) =>
        nodeRefFromAx({
          client,
          sessionId,
          generation,
          node,
          index: index + nodeRefs.length + nodeIndex,
        }),
      ),
    )
    nodeRefs = nodeRefs.concat(batchRefs.filter((node): node is NodeRef => node !== null))
  }

  return nodeRefs.map((node, nodeIndex) => ({ ...node, ref: `${generation}.${index + nodeIndex}` }))
}

const collectElements = async ({
  client,
  tab,
}: {
  client: CdpClient
  tab: TabState
}): Promise<{ nodes: Array<NodeRef>; page: PageState; dropped: boolean }> => {
  const before = tab.navigationVersion
  const page = await pageState(client, tab)
  // Stop inspecting after the cap and bypass the DOM fallback when AX overflows.
  let candidates: Array<NodeRef> = []
  let inspected = 0
  let dropped = false
  for (const sessionId of tabSessions(tab)) {
    let nodes: Array<AxNode> = []
    try {
      nodes = await axNodes(client, sessionId)
    } catch {
      continue
    }
    const actionable = nodes.filter((node) => actionableRoles.has(nodeName(node)))
    const remaining = MAX_SNAPSHOT_NODES - inspected
    const batch = actionable.slice(0, remaining)
    const nodeRefs = await getAxNodeRefs({
      client,
      sessionId,
      generation: tab.generation,
      nodes: batch,
      index: candidates.length,
    })
    candidates = candidates.concat(nodeRefs)
    inspected += batch.length
    if (actionable.length <= batch.length) continue

    dropped = true
    break
  }
  const domCandidates = dropped ? [] : await collectDomCandidates({ client, tab })
  for (const candidate of domCandidates) {
    if (
      candidates.some(
        (item) => item.sessionId === candidate.sessionId && item.backendNodeId === candidate.backendNodeId,
      )
    )
      continue
    candidates.push({ ...candidate, ref: `${tab.generation}.${candidates.length}` })
  }
  for (const sessionId of tabSessions(tab).slice(1)) {
    try {
      const frameText = await runtimeValue<string>(
        client,
        "document.body ? (document.body.innerText || '') : (document.documentElement?.innerText || '')",
        sessionId,
      )
      if (frameText) page.text = `${page.text}\n${frameText}`
    } catch {}
  }
  candidates.sort((left, right) => {
    const leftVisible =
      (left.bounds[2] ?? 0) > 0 &&
      (left.bounds[3] ?? 0) > 0 &&
      (left.bounds[0] ?? 0) < page.viewport.width &&
      (left.bounds[1] ?? 0) < page.viewport.height
    const rightVisible =
      (right.bounds[2] ?? 0) > 0 &&
      (right.bounds[3] ?? 0) > 0 &&
      (right.bounds[0] ?? 0) < page.viewport.width &&
      (right.bounds[1] ?? 0) < page.viewport.height
    return Number(rightVisible) - Number(leftVisible)
  })
  if (before !== tab.navigationVersion) throw new Error("Navigation started during snapshot")
  return {
    nodes: candidates.slice(0, MAX_SNAPSHOT_NODES),
    page,
    dropped: dropped || candidates.length > MAX_SNAPSHOT_NODES,
  }
}

const elementFromNode = (node: NodeRef, page: PageState): BrowserElement => {
  const inViewport =
    (node.bounds[2] ?? 0) > 0 &&
    (node.bounds[3] ?? 0) > 0 &&
    (node.bounds[0] ?? 0) < page.viewport.width &&
    (node.bounds[1] ?? 0) < page.viewport.height
  return {
    ref: node.ref,
    role: node.role,
    name: node.name,
    ...(node.value === undefined ? {} : { value: node.value }),
    states: node.states,
    frame: node.frame,
    inViewport,
  }
}

const FULL_PAGE_MAX_HEIGHT = 12000
const IMAGE_SCALES = [1, 0.6, 0.4, 0.25] as const

type ImageClip = { x: number; y: number; width: number; height: number; scale: number }

const layoutClip = async ({
  client,
  sessionId,
  fullPage,
  scale,
}: {
  client: CdpClient
  sessionId: string
  fullPage: boolean
  scale: number
}): Promise<ImageClip | null> => {
  const metrics = cdpResult(await cdpCall<unknown>(client, "Page.getLayoutMetrics", {}, sessionId))
  const area = asRecord(fullPage ? metrics.cssContentSize : metrics.cssVisualViewport)
  const width = asNumber(area?.width) ?? asNumber(area?.clientWidth)
  const height = asNumber(area?.height) ?? asNumber(area?.clientHeight)
  if (width === null || height === null || width <= 0 || height <= 0) return null
  const x = fullPage ? 0 : (asNumber(area?.pageX) ?? 0)
  const y = fullPage ? 0 : (asNumber(area?.pageY) ?? 0)
  return { x, y, width, height: fullPage ? Math.min(height, FULL_PAGE_MAX_HEIGHT) : height, scale }
}

const imageData = async ({
  client,
  tab,
  fullPage,
  quality = 80,
  scale = 1,
}: {
  client: CdpClient
  tab: TabState
  fullPage: boolean
  quality?: number
  scale?: number
}): Promise<string> => {
  if (!tab.sessionId) throw new Error("Tab is not attached")
  const clip = fullPage || scale < 1 ? await layoutClip({ client, sessionId: tab.sessionId, fullPage, scale }) : null
  const result = cdpResult(
    await cdpCall<unknown>(
      client,
      "Page.captureScreenshot",
      {
        format: "jpeg",
        quality,
        captureBeyondViewport: fullPage,
        fromSurface: true,
        ...(clip === null ? {} : { clip }),
      },
      tab.sessionId,
    ),
  )
  const data = asString(result.data)
  if (!data) throw new Error("Chrome returned an empty screenshot")
  return data
}

const SCREENSHOT_TOO_LARGE = "Screenshot too large"

const boundedImage = async ({
  client,
  tab,
  fullPage,
  maxBytes = 300 * 1024,
}: {
  client: CdpClient
  tab: TabState
  fullPage: boolean
  maxBytes?: number
}): Promise<string> => {
  for (const scale of IMAGE_SCALES) {
    let quality = 80
    let data = await imageData({ client, tab, fullPage, quality, scale })
    while (data.length > maxBytes && quality > 25) {
      quality -= 20
      data = await imageData({ client, tab, fullPage, quality, scale })
    }
    if (data.length <= maxBytes) return data
  }
  throw new Error(SCREENSHOT_TOO_LARGE)
}

const renderSnapshot = (snapshot: BrowserSnapshot): string => {
  const focus =
    snapshot.focus.ref === null
      ? "none"
      : `${snapshot.focus.ref} ${snapshot.focus.role ?? ""} "${snapshot.focus.name ?? ""}"`
  const elements = snapshot.elements
    .map((item) => `${item.ref} ${item.role} "${item.name}"${item.inViewport ? "" : " offscreen"}`)
    .join("\n  ")
  const actions = snapshot.recentActions
    .map((item) => `${new Date(item.at).toISOString()} ${item.tool} ${item.ok ? "ok" : (item.errorCode ?? "error")}`)
    .join("] [")
  const diagnostics = snapshot.diagnostics.map((item) => `${item.kind}/${item.level} ${item.text}`).join("] [")
  return `tab ${snapshot.tabId} gen ${snapshot.generation} · ${snapshot.url} · "${snapshot.title}" · loading=${snapshot.loading ? "yes" : "no"} · scroll ${Math.round(snapshot.viewport.scrollY)}/${Math.round(snapshot.viewport.scrollHeight)} · truncated=${snapshot.truncated ? "yes" : "no"}\nfocus: ${focus}\nelements:\n  ${elements}\ntext:\n  ${snapshot.text}\nrecent actions: [${actions}]\ndiagnostics: [${diagnostics}]\n${snapshot.notes.map((note) => `notes: ${note}`).join("\n")}`
}

const snapshotSize = (snapshot: BrowserSnapshot): number => new TextEncoder().encode(JSON.stringify(snapshot)).length

const trimText = (value: string, limit: number): string => value.slice(0, limit)

const redactSnapshot = (snapshot: BrowserSnapshot, redact: (value: string) => string): BrowserSnapshot => ({
  ...snapshot,
  url: redact(snapshot.url),
  title: redact(snapshot.title),
  focus: {
    ...snapshot.focus,
    role: snapshot.focus.role === null ? null : redact(snapshot.focus.role),
    name: snapshot.focus.name === null ? null : redact(snapshot.focus.name),
  },
  elements: snapshot.elements.map((element) => ({
    ...element,
    role: redact(element.role),
    name: redact(element.name),
    ...(element.value === undefined ? {} : { value: redact(element.value) }),
    frame: redact(element.frame),
  })),
  text: redact(snapshot.text),
  recentActions: snapshot.recentActions.map((action) => ({
    ...action,
    tool: redact(action.tool),
    target: redact(action.target),
    note: redact(action.note),
  })),
  diagnostics: snapshot.diagnostics.map((diagnostic) => ({ ...diagnostic, text: redact(diagnostic.text) })),
  notes: snapshot.notes.map(redact),
})

const boundSnapshot = (input: BrowserSnapshot): BrowserSnapshot => {
  let snapshot: BrowserSnapshot = {
    ...input,
    url: trimText(input.url, 4_000),
    title: trimText(input.title, 2_000),
    focus: {
      ref: input.focus.ref,
      role: input.focus.role === null ? null : trimText(input.focus.role, 200),
      name: input.focus.name === null ? null : trimText(input.focus.name, 500),
    },
    elements: input.elements.map((element) => ({
      ...element,
      role: trimText(element.role, 200),
      name: trimText(element.name, 500),
      ...(element.value === undefined ? {} : { value: trimText(element.value, 500) }),
      frame: trimText(element.frame, 200),
    })),
    text: trimText(input.text, 20_000),
    recentActions: input.recentActions.map((action) => ({
      ...action,
      target: trimText(action.target, 500),
      note: trimText(action.note, 500),
    })),
    diagnostics: input.diagnostics.map((diagnostic) => ({ ...diagnostic, text: trimText(diagnostic.text, 500) })),
    notes: input.notes.map((note) => trimText(note, 500)),
  }
  const cap = 128 * 1024
  if (snapshotSize(snapshot) <= cap) return snapshot
  snapshot = { ...snapshot, image: null, truncated: true }
  if (!snapshot.notes.some((note) => note.includes("snapshot size"))) snapshot.notes.push("Snapshot size was bounded")
  snapshot.text = trimText(snapshot.text, 10_000)
  while (snapshotSize(snapshot) > cap && snapshot.elements.length > 0) snapshot.elements.pop()
  while (snapshotSize(snapshot) > cap && snapshot.diagnostics.length > 0) snapshot.diagnostics.pop()
  while (snapshotSize(snapshot) > cap && snapshot.recentActions.length > 0) snapshot.recentActions.pop()
  while (snapshotSize(snapshot) > cap && snapshot.notes.length > 1) snapshot.notes.pop()
  while (snapshotSize(snapshot) > cap && snapshot.text.length > 0)
    snapshot.text = trimText(snapshot.text, Math.floor(snapshot.text.length * 0.75))
  while (snapshotSize(snapshot) > cap && snapshot.title.length > 0)
    snapshot.title = trimText(snapshot.title, Math.floor(snapshot.title.length * 0.75))
  while (snapshotSize(snapshot) > cap && snapshot.url.length > 0)
    snapshot.url = trimText(snapshot.url, Math.floor(snapshot.url.length * 0.75))
  if (snapshotSize(snapshot) > cap) {
    snapshot = {
      ...snapshot,
      url: trimText(snapshot.url, 512),
      title: trimText(snapshot.title, 512),
      elements: [],
      text: "",
      recentActions: [],
      diagnostics: [],
      image: null,
      notes: ["Snapshot size was bounded"],
    }
  }
  return snapshot
}

const safeEvaluateValue = (value: unknown, redact: (value: string) => string): unknown => {
  const visit = (item: unknown, depth: number): unknown => {
    if (item === null) return null
    if (typeof item === "string") return trimText(redact(item), 4_000)
    if (typeof item === "boolean" || typeof item === "number") return item
    if (depth >= 6) return "[OBJECT]"
    if (Array.isArray(item)) return item.slice(0, 100).map((child) => visit(child, depth + 1))
    if (typeof item === "object") {
      const result: Record<string, unknown> = {}
      for (const [key, child] of Object.entries(item).slice(0, 100))
        result[trimText(redact(key), 200)] = visit(child, depth + 1)
      return result
    }
    return `[${typeof item}]`
  }
  const safe = visit(value ?? null, 0)
  try {
    if (new TextEncoder().encode(JSON.stringify(safe)).length <= 20 * 1024) return safe
  } catch {}
  return { value: "[TRUNCATED]", truncated: true }
}

const SESSIONS_MIGRATED_KEY = "browser.sessions.migrated"
const SESSION_SAVE_INTERVAL_MS = 2 * 60 * 1000
const SESSION_SHUTDOWN_BUDGET_MS = 3000
const MAX_ORIGIN_STORAGE_CHARS = 256 * 1024

/** MCP image blocks carry raw base64; bots decode `data` straight into a file, so no data-URL prefix. */
const rawBase64 = (dataUrl: string): string => dataUrl.replace(/^data:[^;,]*;base64,/, "")

export const createBrowserEngine = ({
  kernel,
  mode,
  launcher: suppliedLauncher,
  profile,
  discoverBotId,
  localBrowser = false,
  runStage,
}: {
  kernel: Kernel
  mode?: "system-chrome" | "chrome-for-testing"
  launcher?: ChromeLauncher
  profile?: string
  discoverBotId?: string
  localBrowser?: boolean
  runStage?: PerformanceStageRunner
}): BrowserEngine => {
  const refHistory = new WeakMap<TabState, Map<string, { node: NodeRef; url: string }>>()
  const rememberRefs = (tab: TabState) => {
    const history = refHistory.get(tab) ?? new Map()
    for (const [ref, node] of tab.refs) history.set(ref, { node, url: tab.info.url })
    while (history.size > 1000) history.delete(history.keys().next().value as string)
    refHistory.set(tab, history)
  }
  const store = createBrowserStore({ kernel, retainTargets: localBrowser, ...(profile ? { profile } : {}) })
  const launcher: ChromeLauncher =
    suppliedLauncher ?? createChromeLauncher({ kernel, ...(mode === undefined ? {} : { mode }) })
  const tabs = store.load()
  let client: CdpClient | null = null
  let unsubscribe: (() => void) | null = null
  let retired = false
  const pendingPopups = new WeakMap<TabState, number>()
  const targetToTab = new Map<string, TabState>()
  const targetSessions = new Map<string, string>()
  const attaching = new Set<string>()
  const browserContexts = new Map<string, Promise<string | null>>()
  const contextOwners = new Map<string, string>()
  const savedSessions = new Map<string, SavedSession>()
  const pendingStorage = new Map<string, Record<string, Record<string, string>>>()
  let sessionTimer: ReturnType<typeof setInterval> | null = null
  let legacyMigration: Promise<void> | null = null
  const windowConfig = deriveChromeWindowConfig({ env: process.env })

  const safePublicTabInfo = (tab: TabState): ReturnType<typeof publicTabInfo> => {
    const info = publicTabInfo({ tab })
    return { ...info, url: kernel.redact(info.url), title: kernel.redact(info.title) }
  }

  const enforceTabUrl = (tab: TabState): void => {
    if (!client || isReadableTabUrl(tab.info.url)) return
    recordDiagnostic(tab, {
      at: Date.now(),
      kind: "popup",
      level: "warning",
      text: BROWSER_URL_NOT_ALLOWED_MESSAGE,
    })
    tab.info.url = "about:blank"
    if (tab.info.openerTabId && tab.targetId) {
      void client.call("Target.closeTarget", { targetId: tab.targetId }).catch(() => undefined)
      return
    }
    if (tab.sessionId) void client.call("Page.navigate", { url: "about:blank" }, tab.sessionId).catch(() => undefined)
  }

  const closeBlockedTarget = (info: CdpTargetInfo): boolean => {
    if (!client || info.type !== "page" || isReadableTabUrl(info.url)) return false
    void client.call("Target.closeTarget", { targetId: info.targetId }).catch(() => undefined)
    return true
  }

  const enableSession = async (tab: TabState, sessionId: string): Promise<void> => {
    if (!client) return
    await Promise.all([
      cdpCall(client, "Page.enable", {}, sessionId),
      cdpCall(client, "Runtime.enable", {}, sessionId),
      cdpCall(client, "DOM.enable", {}, sessionId),
      cdpCall(client, "Accessibility.enable", {}, sessionId),
      cdpCall(client, "Network.enable", {}, sessionId),
      cdpCall(client, "Log.enable", {}, sessionId),
      cdpCall(client, "Page.setLifecycleEventsEnabled", { enabled: true }, sessionId),
    ])
    await installMutationObserver(client, tab, sessionId)
  }

  const publishTab = (tab: TabState): void => {
    if (retired) return
    store.save(tab)
    kernel.publish({ type: "browser.tab", tab: safePublicTabInfo(tab) })
  }

  const markEngineUnavailable = (): void => {
    client = null
    unsubscribe?.()
    unsubscribe = null
    targetToTab.clear()
    targetSessions.clear()
    for (const tab of tabs) {
      if (tab.info.state !== "live") continue
      tab.info.state = "unloaded"
      if (!localBrowser) tab.targetId = null
      tab.sessionId = null
      tab.frameSessions.clear()
      store.save(tab)
      kernel.publish({ type: "browser.tab", tab: safePublicTabInfo(tab) })
    }
  }

  const unloadIdleTabs = (): void => {
    // Visible guest pages belong to the desktop; reading its tab list must not close them.
    if (discoverBotId) return
    const cutoff = Date.now() - 30 * 60 * 1000
    for (const tab of tabs) {
      if (tab.info.state !== "live" || tab.info.lastUsedAt >= cutoff) continue
      if (client && tab.targetId)
        void client.call("Target.closeTarget", { targetId: tab.targetId }).catch(() => undefined)
      if (tab.targetId) targetToTab.delete(tab.targetId)
      tab.targetId = null
      tab.sessionId = null
      tab.frameSessions.clear()
      tab.info.state = "unloaded"
      tab.generation += 1
      tab.refs.clear()
      store.save(tab)
      kernel.publish({ type: "browser.tab", tab: safePublicTabInfo(tab) })
    }
  }

  const syncPageNavigation = (tab: TabState, params: JsonObject): void => {
    const frame = asRecord(params.frame)
    if (!frame || frame.parentId !== undefined) return
    rememberRefs(tab)
    const url = asString(frame.url)
    if (url !== null) tab.info.url = url
    const navigationType = asString(params.type)
    if (navigationType === "SameDocument") return
    tab.navigationVersion += 1
    tab.generation += 1
    tab.refs.clear()
    tab.secretMode = false
    enforceTabUrl(tab)
    void restoreStorage(tab)
    publishTab(tab)
  }

  const onEvent = (event: CdpEvent): void => {
    if (retired) return
    const targetId = asString(asRecord(eventValue(event, "targetInfo"))?.targetId)
    const tab = event.sessionId
      ? (tabs.find(
          (item) =>
            item.sessionId === event.sessionId || [...item.frameSessions.values()].includes(event.sessionId as string),
        ) ?? null)
      : targetId
        ? (targetToTab.get(targetId) ?? null)
        : null
    if (event.method === "Target.attachedToTarget") {
      const info = targetInfo(event.params.targetInfo)
      const sessionId = asString(event.params.sessionId)
      // Browser-wide events can describe the user's tabs. Never attach to or act on them.
      if (localBrowser && !tab && !(info?.openerId && targetToTab.has(info.openerId))) return
      if (info && sessionId && info.openerId && !targetToTab.has(info.targetId) && closeBlockedTarget(info)) return
      if (info && sessionId) {
        targetSessions.set(info.targetId, sessionId)
        const attachedTab =
          targetToTab.get(info.targetId) ??
          (event.sessionId
            ? (tabs.find(
                (item) =>
                  item.sessionId === event.sessionId ||
                  [...item.frameSessions.values()].includes(event.sessionId as string),
              ) ?? null)
            : null)
        if (attachedTab && info.type === "iframe") {
          attachedTab.frameSessions.set(info.targetId, sessionId)
          targetToTab.set(info.targetId, attachedTab)
          void enableSession(attachedTab, sessionId).catch(() => {
            attachedTab.frameSessions.delete(info.targetId)
          })
        } else if (attachedTab && attachedTab.sessionId !== sessionId) {
          attachedTab.sessionId = sessionId
          attachedTab.frameSessions.clear()
        }
        if (info.type === "page" && info.openerId) {
          const opener = targetToTab.get(info.openerId)
          if (opener) void adoptPopup({ info, opener })
        }
      }
      return
    }
    if (event.method === "Target.detachedFromTarget") {
      const detachedSessionId = asString(event.params.sessionId)
      if (detachedSessionId) {
        for (const [id, sessionId] of targetSessions) if (sessionId === detachedSessionId) targetSessions.delete(id)
        for (const item of tabs) {
          for (const [frameId, frameSessionId] of item.frameSessions) {
            if (frameSessionId === detachedSessionId) item.frameSessions.delete(frameId)
          }
        }
      }
      return
    }
    if (event.method === "Target.targetCreated") {
      const info = targetInfo(eventValue(event, "targetInfo"))
      if (info?.type === "page" && info.openerId && targetToTab.has(info.openerId)) {
        if (closeBlockedTarget(info)) return
        const opener = targetToTab.get(info.openerId)
        if (opener) void adoptPopup({ info, opener })
      }
      return
    }
    if (event.method === "Target.targetDestroyed") {
      const destroyed = asString(event.params.targetId)
      if (destroyed) targetSessions.delete(destroyed)
      const destroyedTab = destroyed ? targetToTab.get(destroyed) : null
      if (destroyedTab && destroyed === destroyedTab.targetId) {
        targetToTab.delete(destroyed as string)
        destroyedTab.targetId = null
        destroyedTab.sessionId = null
        destroyedTab.frameSessions.clear()
        destroyedTab.info.state = "closed"
        recordDiagnostic(destroyedTab, { at: Date.now(), kind: "popup", level: "info", text: "Tab closed" })
        publishTab(destroyedTab)
      } else if (destroyedTab) {
        destroyedTab.frameSessions.delete(destroyed as string)
        targetToTab.delete(destroyed as string)
      }
      return
    }
    if (!tab) return
    if (event.method === "Target.targetInfoChanged" && localBrowser) {
      const info = targetInfo(event.params.targetInfo)
      if (info) {
        tab.info.url = info.url
        tab.info.title = info.title
        enforceTabUrl(tab)
        publishTab(tab)
      }
      return
    }
    if (event.method === "Page.frameNavigated") {
      if (event.sessionId !== tab.sessionId) return
      syncPageNavigation(tab, event.params)
      return
    }
    if (event.method === "Page.loadEventFired") {
      recordDiagnostic(tab, { at: Date.now(), kind: "load", level: "info", text: "Page loaded" })
      return
    }
    if (event.method === "Runtime.consoleAPICalled") {
      const type = asString(event.params.type) ?? "log"
      if (type !== "error" && type !== "warning" && type !== "warn") return
      const text = asArray(event.params.args).map(responseText).join(" ").slice(0, 500)
      recordDiagnostic(tab, {
        at: Date.now(),
        kind: "console",
        level: type === "error" ? "error" : "warning",
        text: kernel.redact(text),
      })
      return
    }
    if (event.method === "Log.entryAdded") {
      const entry = asRecord(event.params.entry)
      const text = asString(entry?.text)
      if (text)
        recordDiagnostic(tab, {
          at: Date.now(),
          kind: "console",
          level: asString(entry?.level) === "error" ? "error" : "warning",
          text: kernel.redact(text.slice(0, 500)),
        })
      return
    }
    if (event.method === "Network.responseReceived") {
      const response = asRecord(event.params.response)
      const status = asNumber(response?.status)
      const url = asString(response?.url) ?? ""
      if (
        status !== null &&
        event.sessionId === tab.sessionId &&
        asString(event.params.type) === "Document" &&
        asString(event.params.frameId) === tab.targetId
      )
        tab.mainDocument = { url, status, headers: blockedPageHeaders(response?.headers) }
      if (status !== null && status >= 400)
        recordDiagnostic(tab, {
          at: Date.now(),
          kind: "network",
          level: "error",
          text: `${status} ${kernel.redact(url)}`.slice(0, 500),
        })
      return
    }
    if (event.method === "Network.loadingFailed") {
      recordDiagnostic(tab, {
        at: Date.now(),
        kind: "network",
        level: "error",
        text: kernel.redact(`${asString(event.params.errorText) ?? "Network request failed"}`.slice(0, 500)),
      })
      return
    }
    if (event.method === "Page.javascriptDialogOpening") {
      const type = asString(event.params.type)
      const message = asString(event.params.message) ?? ""
      if (type === "alert") {
        recordDiagnostic(tab, { at: Date.now(), kind: "dialog", level: "info", text: "Alert auto-accepted" })
        if (client && tab.sessionId)
          void cdpCall(client, "Page.handleJavaScriptDialog", { accept: true }, tab.sessionId).catch(() => undefined)
      } else if (type === "confirm" || type === "prompt" || type === "beforeunload") {
        tab.dialog = { type, message: kernel.redact(message).slice(0, 500) }
        recordDiagnostic(tab, {
          at: Date.now(),
          kind: "dialog",
          level: "warning",
          text: `${type}: ${kernel.redact(message).slice(0, 500)}`,
        })
      }
    }
  }

  const applyWindowBounds = async (targetId: string): Promise<void> => {
    if (!client || windowConfig.headless) return
    const window = cdpResult(await client.call<unknown>("Browser.getWindowForTarget", { targetId }))
    const windowId = asNumber(window.windowId)
    if (windowId === null) return
    const bounds: JsonObject = {
      width: windowConfig.width,
      height: windowConfig.height,
      windowState: "normal",
      ...(windowConfig.left === null ? {} : { left: windowConfig.left }),
      ...(windowConfig.top === null ? {} : { top: windowConfig.top }),
    }
    await client.call("Browser.setWindowBounds", { windowId, bounds })
  }

  const attach = async (tab: TabState, targetId: string): Promise<boolean> => {
    if (!client) return false
    if (attaching.has(targetId)) {
      for (let attempt = 0; attempt < 100 && attaching.has(targetId); attempt += 1) await Bun.sleep(10)
      return tab.targetId === targetId && tab.sessionId !== null
    }
    attaching.add(targetId)
    try {
      const attached = targetSessions.get(targetId)
      const result =
        attached === undefined
          ? cdpResult(await client.call<unknown>("Target.attachToTarget", { targetId, flatten: true }))
          : {}
      const sessionId = attached ?? asString(result.sessionId)
      if (!sessionId) return false
      targetSessions.set(targetId, sessionId)
      tab.targetId = targetId
      tab.sessionId = sessionId
      tab.info.state = "live"
      targetToTab.set(targetId, tab)
      await applyWindowBounds(targetId)
      await cdpCall(
        client,
        "Target.setAutoAttach",
        { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
        sessionId,
      )
      await enableSession(tab, sessionId)
      publishTab(tab)
      return true
    } catch (error) {
      kernel.log({
        level: "warn",
        module: "browser",
        msg: "Could not attach Chrome tab",
        data: { error: errorMessage(error) },
      })
      return false
    } finally {
      attaching.delete(targetId)
    }
  }

  const adoptPopup = async ({ info, opener }: { info: CdpTargetInfo; opener: TabState }): Promise<void> => {
    if (!client || tabs.some((tab) => tab.targetId === info.targetId)) return
    pendingPopups.set(opener, (pendingPopups.get(opener) ?? 0) + 1)
    try {
      await adoptPopupTab({ info, opener })
    } finally {
      pendingPopups.set(opener, Math.max(0, (pendingPopups.get(opener) ?? 1) - 1))
    }
  }

  const adoptPopupTab = async ({ info, opener }: { info: CdpTargetInfo; opener: TabState }): Promise<void> => {
    unloadIdleTabs()
    if (store.list(opener.info.ownerBotId).length >= 25) {
      recordDiagnostic(opener, {
        at: Date.now(),
        kind: "popup",
        level: "warning",
        text: "Popup ignored: tab limit reached",
      })
      publishTab(opener)
      return
    }
    const popup = store.create({
      botId: opener.info.ownerBotId ?? "",
      threadId: opener.info.ownerThreadId ?? "",
      url: info.url,
      openerTabId: opener.info.tabId,
      targetId: info.targetId,
    })
    tabs.push(popup)
    await attach(popup, info.targetId)
    recordDiagnostic(opener, {
      at: Date.now(),
      kind: "popup",
      level: "info",
      text: `Popup opened: ${popup.info.tabId}`,
    })
    publishTab(opener)
  }

  const ensureClient = async (runningOnly = false): Promise<boolean> => {
    if (retired) return false
    if (client && !client.isClosed()) return true
    client = null
    let started = await launcher.start({ runningOnly })
    if (!started && !runningOnly && !retired) {
      await Bun.sleep(250)
      if (!retired) started = await launcher.start()
    }
    if (retired) return false
    if (!started) {
      // A running-only probe (tab listing, viewers) finds no browser until a page is opened; that is not a failure.
      if (!runningOnly) kernel.log({ level: "warn", module: "browser", msg: "Chrome launcher returned no client" })
      return false
    }
    client = started.client
    browserContexts.clear()
    contextOwners.clear()
    legacyMigration = null
    unsubscribe = client.subscribe(onEvent)
    try {
      await client.call("Target.setDiscoverTargets", { discover: true })
      if (!localBrowser)
        await client.call("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true })
      else client.onDisconnect?.(() => markEngineUnavailable())
      void started.process?.exited.then(() => markEngineUnavailable())
      return !retired
    } catch (error) {
      kernel.log({
        level: "warn",
        module: "browser",
        msg: "Chrome discovery setup failed",
        data: { error: errorMessage(error) },
      })
      if (!retired) {
        await launcher.stop()
        markEngineUnavailable()
      }
      if (localBrowser) throw new LocalBrowserUnavailableError()
      return false
    }
  }

  const focusManagedChrome = async (): Promise<void> => {
    if (windowConfig.headless || discoverBotId || localBrowser || hostPlatform !== macos) return
    const env = { ...(await kernel.shellEnv()), ...process.env }
    const cleanEnv: Record<string, string> = {}
    for (const [key, value] of Object.entries(env)) if (value !== undefined) cleanEnv[key] = value
    const front = kernel.spawnTree({
      ...macos.focusChrome,
      cwd: kernel.paths.appData,
      env: cleanEnv,
    })
    if (front.success) void front.exited
  }

  const COOKIE_FIELDS = [
    "name",
    "value",
    "domain",
    "path",
    "expires",
    "httpOnly",
    "secure",
    "sameSite",
    "priority",
    "sourceScheme",
    "sourcePort",
    "partitionKey",
  ] as const

  const cookieParam = (cookie: SavedCookie): SavedCookie =>
    Object.fromEntries(
      COOKIE_FIELDS.filter(
        (field) => cookie[field] !== undefined && !(field === "expires" && cookie.session === true),
      ).map((field) => [field, cookie[field]]),
    )

  const restoreCookies = async ({
    cookies,
    contextId,
  }: {
    cookies: Array<SavedCookie>
    contextId: string
  }): Promise<void> => {
    if (!client || cookies.length === 0) return
    const params = cookies.map(cookieParam)
    const batch = await client
      .call("Storage.setCookies", { cookies: params, browserContextId: contextId })
      .then(() => true)
      .catch(() => false)
    if (batch) return
    for (const cookie of params)
      await client
        ?.call("Storage.setCookies", { cookies: [cookie], browserContextId: contextId })
        .catch(() => undefined)
  }

  type SqlQuery = {
    get: (...args: Array<unknown>) => unknown
    all: (...args: Array<unknown>) => Array<unknown>
    run: (...args: Array<unknown>) => unknown
  }
  const sql = (text: string): SqlQuery => (kernel.db as { query: (text: string) => SqlQuery }).query(text)

  const botExists = (botId: string): boolean => sql("SELECT id FROM bots WHERE id = ?").get(botId) !== null

  const cookiesOf = (listing: unknown): Array<SavedCookie> =>
    asArray(asRecord(listing)?.cookies).filter((item): item is SavedCookie => asRecord(item) !== null)

  const hostOf = (url: string): string => {
    try {
      return new URL(url).hostname
    } catch {
      return ""
    }
  }

  const legacyCookies = async (): Promise<void> => {
    if (sql("SELECT key FROM settings WHERE key = ?").get(SESSIONS_MIGRATED_KEY)) return
    const listing = await client?.call<unknown>("Storage.getCookies", {}).catch(() => null)
    const rows = sql(
      "SELECT owner_bot_id, url FROM browser_tabs WHERE owner_bot_id IS NOT NULL AND profile = 'default'",
    ).all() as Array<{
      owner_bot_id: string
      url: string
    }>
    const hostsByBot = new Map<string, Array<string>>()
    for (const row of rows) {
      const host = hostOf(row.url)
      if (host !== "") hostsByBot.set(row.owner_bot_id, [...(hostsByBot.get(row.owner_bot_id) ?? []), host])
    }
    const ownedHosts = Object.fromEntries(hostsByBot)
    for (const [botId, assigned] of Object.entries(assignLegacyCookies({ cookies: cookiesOf(listing), ownedHosts }))) {
      if (!botExists(botId)) continue
      const existing = await loadBotSession(kernel, botId)
      if (existing.cookies.length > 0) continue
      await saveBotSession({ kernel, botId, session: { cookies: assigned, storage: {} } }).catch(() => false)
    }
    sql("INSERT INTO settings(key,value_json,updated_at) VALUES (?,?,?)").run(SESSIONS_MIGRATED_KEY, "true", Date.now())
  }

  const startSessionTimer = (): void => {
    if (sessionTimer || discoverBotId || localBrowser) return
    const task = createBackgroundTask(
      "browser_session_save",
      async () => {
        if (retired) return
        await saveSessions()
      },
      runStage,
    )
    sessionTimer = setInterval(() => void task.run().catch(() => undefined), SESSION_SAVE_INTERVAL_MS)
    sessionTimer.unref?.()
  }

  const createContext = async (botId: string): Promise<string | null> => {
    if (!client) return null
    legacyMigration ??= legacyCookies().catch(() => undefined)
    await legacyMigration
    // Do not create an empty context that could later replace a locked saved session.
    const saved = botId === "" ? emptySession() : await loadBotSession(kernel, botId)
    const created = asString(cdpResult(await client.call<unknown>("Target.createBrowserContext", {})).browserContextId)
    if (!created) return null
    savedSessions.set(botId, saved)
    pendingStorage.set(botId, { ...saved.storage })
    contextOwners.set(botId, created)
    await restoreCookies({ cookies: saved.cookies, contextId: created })
    startSessionTimer()
    return created
  }

  const browserContextFor = (botId: Id | null): Promise<string | null> => {
    if (discoverBotId || localBrowser) return Promise.resolve("")
    if (!client) return Promise.resolve(null)
    const key = botId ?? ""
    const existing = browserContexts.get(key)
    if (existing) return existing
    const created = createContext(key).catch((error) => {
      browserContexts.delete(key)
      throw error
    })
    browserContexts.set(key, created)
    return created
  }

  const collectStorage = async (botId: string): Promise<Record<string, Record<string, string>>> => {
    const live = tabs.filter(
      (tab) => tab.info.ownerBotId === botId && tab.info.state === "live" && tab.sessionId && !tab.secretMode,
    )
    const found = await Promise.all(
      live.map((tab) =>
        runtimeValue<{ origin: string; items: Record<string, string> }>(
          client as CdpClient,
          "({origin: location.origin, items: Object.fromEntries(Object.entries(localStorage))})",
          tab.sessionId as string,
        ).catch(() => null),
      ),
    )
    const usable = found.filter(
      (item): item is { origin: string; items: Record<string, string> } =>
        item !== null && /^https?:/.test(item.origin) && JSON.stringify(item.items).length <= MAX_ORIGIN_STORAGE_CHARS,
    )
    return Object.fromEntries(usable.map((item) => [item.origin, item.items]))
  }

  const saveOneSession = async ({ botId, contextId }: { botId: string; contextId: string }): Promise<void> => {
    if (!client || client.isClosed() || botId === "" || !botExists(botId)) return
    const listing = await client.call<unknown>("Storage.getCookies", { browserContextId: contextId }).catch(() => null)
    if (listing === null) return
    const previous: SavedSession = savedSessions.get(botId) ?? emptySession()
    const current = await collectStorage(botId)
    const storage = Object.fromEntries(
      Object.entries({ ...previous.storage, ...current }).filter(([, items]) => Object.keys(items).length > 0),
    )
    const session: SavedSession = { cookies: cookiesOf(listing), storage }
    savedSessions.set(botId, session)
    await saveBotSession({ kernel, botId, session, ...(runStage ? { runStage } : {}) }).catch(() => false)
  }

  const saveSessions = async (): Promise<void> => {
    const measure = getMeasuredStage("browser_session_save", runStage)
    const limit = contextOwners.size
    let saved = 0
    for (const [botId, contextId] of contextOwners) {
      if (saved >= limit) return

      saved += 1

      await yieldBackground()
      await measure(() => saveOneSession({ botId, contextId }))
    }
  }

  const disposeBotContext = async (botId: string): Promise<void> => {
    const contextId = contextOwners.get(botId)
    browserContexts.delete(botId)
    contextOwners.delete(botId)
    savedSessions.delete(botId)
    pendingStorage.delete(botId)
    if (client && contextId)
      await client.call("Target.disposeBrowserContext", { browserContextId: contextId }).catch(() => undefined)
    if (localBrowser) {
      for (const tab of tabs.filter((tab) => tab.info.ownerBotId === botId && tab.info.state !== "closed")) {
        if (client && tab.targetId)
          await client.call("Target.closeTarget", { targetId: tab.targetId }).catch(() => undefined)
        if (tab.targetId) targetToTab.delete(tab.targetId)
        tab.targetId = null
        tab.sessionId = null
        tab.info.state = "closed"
        publishTab(tab)
      }
    }
  }

  const restoreStorage = async (tab: TabState): Promise<void> => {
    const botId = tab.info.ownerBotId
    if (!client || !tab.sessionId || !botId) return
    let origin = ""
    try {
      origin = new URL(tab.info.url).origin
    } catch {}
    const pending = pendingStorage.get(botId)
    const items = pending?.[origin]
    if (!pending || !items) return
    pendingStorage.set(botId, Object.fromEntries(Object.entries(pending).filter(([key]) => key !== origin)))
    await runtimeValue(
      client,
      `(() => { const items = ${JSON.stringify(items)}; for (const [k, v] of Object.entries(items)) { try { if (localStorage.getItem(k) === null) localStorage.setItem(k, v) } catch {} } return true })()`,
      tab.sessionId,
    ).catch(() => null)
  }

  /** SITE_BLOCKED when the loaded page is a known anti-bot challenge instead of the requested content. */
  const blockedPageFailure = async (tab: TabState): Promise<OperationFailure | null> => {
    if (!client || !tab.sessionId) return null
    const page = await runtimeValue<{
      href: string
      title: string
      text: string
      frames: Array<string>
      challengeElements: Array<string>
    }>(
      client,
      `({ href: location.href, title: document.title, text: (document.body && document.body.innerText || '').slice(0, 2000), frames: Array.from(document.querySelectorAll('iframe')).slice(0, 20).map((frame) => frame.src || ''), challengeElements: ${JSON.stringify(CHALLENGE_ELEMENT_IDS)}.filter((id) => document.getElementById(id)) })`,
      tab.sessionId,
    ).catch(() => null)
    if (!page) return null
    const response =
      tab.mainDocument && stripHash(tab.mainDocument.url) === stripHash(page.href) ? tab.mainDocument : null
    const blocked = classifyBlockedPage({
      url: page.href,
      title: page.title,
      text: page.text,
      frames: page.frames,
      challengeElements: page.challengeElements,
      status: response?.status ?? null,
      headers: response?.headers ?? {},
    })
    if (!blocked) return null
    return failure("SITE_BLOCKED", describeBlockedPage({ blocked, url: page.href }))
  }

  type EnsureOptions = { signal?: AbortSignal; budgetMs?: number }

  const pageLocation = async (tab: TabState): Promise<{ href: string; readyState: string; text: string } | null> => {
    if (!client || !tab.sessionId) return null
    return runtimeValue<{ href: string; readyState: string; text: string }>(
      client,
      "({ href: location.href, readyState: document.readyState, text: (document.body && document.body.innerText || '').slice(0, 600) })",
      tab.sessionId,
    )
  }

  const waitForInitialNavigation = async ({
    tab,
    url,
    signal,
    budgetMs = DEFAULT_NAVIGATION_BUDGET_MS,
  }: { tab: TabState; url: string } & EnsureOptions): Promise<OperationResult<void>> => {
    if (!isLoadableUrl(url)) return success(undefined)
    const endsAt = Date.now() + budgetMs
    while (Date.now() < endsAt) {
      signal?.throwIfAborted()
      const state = await pageLocation(tab).catch((error: unknown) => {
        if (isSessionLost(error)) throw error
        return null
      })
      if (state && isChromeErrorPage(state.href))
        return failure(
          "NAVIGATION_FAILED",
          describeNavigationFailure({ code: networkErrorCode(state.text), url: kernel.redact(url) }),
        )
      if (state && state.href !== "about:blank" && state.readyState !== "loading") return success(undefined)
      await sleep(NAVIGATION_POLL_MS, signal)
    }
    return failure(
      "DEADLINE_EXCEEDED",
      `A página ${kernel.redact(url)} não abriu em ${Math.round(budgetMs / 1000)} s (o servidor não respondeu ou a rede está bloqueada).`,
    )
  }

  const pageUrlBlocked = async (tab: TabState): Promise<boolean> => {
    const state = await pageLocation(tab).catch(() => null)
    if (!state || isReadableTabUrl(state.href)) return false
    tab.info.url = state.href
    enforceTabUrl(tab)
    return true
  }

  const ensureTab = async (tab: TabState, options: EnsureOptions = {}): Promise<OperationResult<void>> => {
    unloadIdleTabs()
    if (tab.info.state === "closed") return failure("TAB_NOT_FOUND", "A aba está fechada. Abra outra com browser_open.")
    if (!(await ensureClient()) || !client)
      return failure("ENGINE_UNAVAILABLE", "O navegador não está disponível. Tente novamente em instantes.")
    if (localBrowser) options.signal?.throwIfAborted()
    if (tab.sessionId && tab.targetId) {
      if (!isReadableTabUrl(tab.info.url)) return failure("URL_NOT_ALLOWED", BROWSER_URL_NOT_ALLOWED_MESSAGE)
      return success(undefined)
    }
    if (localBrowser && tab.targetId) {
      // Reconnect only by the recorded target ID; a matching URL never proves ownership.
      const knownTarget = tab.targetId
      const alive = await client
        .call("Target.getTargetInfo", { targetId: knownTarget })
        .then(() => true)
        .catch(() => false)
      if (alive && (await attach(tab, knownTarget))) return success(undefined)
      targetToTab.delete(knownTarget)
      tab.targetId = null
    }
    const wanted = normalizeBrowserUrl(tab.info.url || "about:blank") ?? "about:blank"
    let contextId: string | null
    try {
      contextId = await browserContextFor(tab.info.ownerBotId)
    } catch (error) {
      return failure(
        "ENGINE_UNAVAILABLE",
        error instanceof SessionVaultError
          ? error.message
          : "O Chrome não conseguiu isolar a sessão do navegador deste bot.",
      )
    }
    if (contextId === null)
      return failure("ENGINE_UNAVAILABLE", "O Chrome não conseguiu isolar a sessão do navegador deste bot.")
    const result = cdpResult(
      await client.call<unknown>("Target.createTarget", {
        url: wanted,
        background: false,
        ...(localBrowser ? { newWindow: true } : {}),
        ...(contextId === "" ? {} : { browserContextId: contextId }),
      }),
    )
    const targetId = asString(result.targetId)
    if (localBrowser && targetId) {
      tab.targetId = targetId
      targetToTab.set(targetId, tab)
      store.save(tab)
    }
    if (!targetId || !(await attach(tab, targetId)))
      return failure("ENGINE_UNAVAILABLE", "O Chrome não conseguiu criar a aba. Tente novamente.")
    return waitForInitialNavigation({ tab, url: wanted, ...options })
  }

  const recoverTab = async (tab: TabState, signal?: AbortSignal): Promise<void> => {
    const staleTarget = tab.targetId
    if (staleTarget) targetSessions.delete(staleTarget)
    tab.sessionId = null
    tab.frameSessions.clear()
    if (client && staleTarget) {
      const alive = localBrowser
        ? await client
            .call("Target.getTargetInfo", { targetId: staleTarget })
            .then(() => true)
            .catch(() => false)
        : asArray(cdpResult(await client.call<unknown>("Target.getTargets", {})).targetInfos).some(
            (item) => targetInfo(item)?.targetId === staleTarget,
          )
      if (alive && (await attach(tab, staleTarget))) {
        tab.generation += 1
        tab.refs.clear()
        return
      }
      targetToTab.delete(staleTarget)
    }
    tab.targetId = null
    await ensureTab(tab, { ...(signal === undefined ? {} : { signal }) })
    tab.generation += 1
    tab.refs.clear()
  }

  const getTab = ({
    tabId,
    botId,
    allowHeld = false,
  }: {
    tabId: Id
    botId: Id
    allowHeld?: boolean
  }): OperationResult<TabState> => {
    unloadIdleTabs()
    const tab = store.find(tabId)
    if (!tab || tab.info.state === "closed") return failure("TAB_NOT_FOUND", "The browser tab was not found.")
    if (tab.info.ownerBotId !== botId) return failure("TAB_NOT_OWNED", "This tab belongs to another bot.")
    if (tab.info.heldByUser && !allowHeld) return failure("TAB_HELD_BY_USER", "The user currently holds this tab.")
    return success(tab)
  }

  const refForBackend = async (sessionId: string, backendNodeId: number, ref: string): Promise<NodeRef | null> => {
    if (!client) return null
    const fingerprint = await fingerprintForNode({ client, sessionId, backendNodeId })
    const bounds = await getBox(client, sessionId, backendNodeId)
    if (!bounds) return null
    return {
      ref,
      sessionId,
      backendNodeId,
      fingerprint,
      frame: sessionId,
      role: fingerprint.role,
      name: fingerprint.name,
      states: [],
      bounds,
    }
  }

  const resolveTarget = async (tab: TabState, target: BrowserTarget): Promise<ResolveResult> => {
    if (!client || !tab.sessionId) return failure("ENGINE_UNAVAILABLE", "The tab is not attached to Chrome.")
    if (target.kind === "point") return { success: true, node: null, point: { x: target.x, y: target.y } }
    if (target.kind === "ref") {
      const node = tab.refs.get(target.ref)
      const generation = Number(target.ref.split(".")[0])
      if (!node || generation !== tab.generation)
        return failure("STALE_REF", "Take a fresh snapshot (browser_snapshot) and use its refs.")
      try {
        const current = await fingerprintForNode({
          client,
          sessionId: node.sessionId,
          backendNodeId: node.backendNodeId,
          accessibility: node.fingerprint.source === "ax",
        })
        if (JSON.stringify(current) !== JSON.stringify(node.fingerprint))
          return failure("TARGET_CHANGED", "The target changed; take a fresh snapshot and use its new ref.")
      } catch (error) {
        if (isTransient(error)) throw error
        return failure("TARGET_CHANGED", "The target changed or was removed; take a fresh snapshot.")
      }
      return { success: true, node, point: null }
    }
    const collected = await collectElements({ client, tab })
    let candidates = collected.nodes
    if (target.kind === "role") {
      candidates = candidates
        .filter((node) => {
          if (node.role !== target.role) return false
          if (target.name === undefined) return true
          return target.exact === true
            ? node.name === target.name
            : node.name.toLocaleLowerCase().includes(target.name.toLocaleLowerCase())
        })
        .slice(0, 2)
    } else if (target.kind === "text") {
      candidates = candidates
        .filter((node) =>
          target.exact === true
            ? node.name === target.text
            : node.name.includes(target.text) || node.fingerprint.textPrefix.includes(target.text),
        )
        .slice(0, 2)
    } else if (target.kind === "css") {
      candidates = []
      for (const sessionId of tabSessions(tab)) {
        let document: JsonObject
        try {
          document = cdpResult(
            await cdpCall<unknown>(client, "DOM.getDocument", { depth: -1, pierce: true }, sessionId),
          )
        } catch {
          continue
        }
        for (const root of documentRoots(document)) {
          let query: JsonObject
          try {
            query = cdpResult(
              await cdpCall<unknown>(
                client,
                "DOM.querySelectorAll",
                { nodeId: root, selector: target.selector },
                sessionId,
              ),
            )
          } catch {
            continue
          }
          const nodeIds = asArray(query.nodeIds)
            .map(asNumber)
            .filter((item): item is number => item !== null)
            .slice(0, 2 - candidates.length)
          for (const nodeId of nodeIds) {
            try {
              const described = cdpResult(await cdpCall<unknown>(client, "DOM.describeNode", { nodeId }, sessionId))
              const backendNodeId = asNumber(asRecord(described.node)?.backendNodeId)
              if (backendNodeId === null) continue
              const node = await refForBackend(sessionId, backendNodeId, `${tab.generation}.${candidates.length}`)
              if (node) candidates.push(node)
            } catch {}
          }
          if (candidates.length >= 2) break
        }
        if (candidates.length >= 2) break
      }
    }
    if (candidates.length === 0) return failure("TARGET_NOT_FOUND", "The target was not found in the current page.")
    if (candidates.length > 1) {
      const listing = candidates
        .slice(0, 2)
        .map((node) => `${node.ref} ${node.role} "${node.name}"`)
        .join(", ")
      return failure("AMBIGUOUS_TARGET", `The target matched multiple elements: ${listing}`)
    }
    return { success: true, node: candidates[0] ?? null, point: null }
  }

  const hitPoint = async (
    tab: TabState,
    resolved: { node: NodeRef | null; point: { x: number; y: number } | null },
  ): Promise<OperationResult<{ x: number; y: number; note?: string; sessionId?: string }>> => {
    if (!client || !tab.sessionId) return failure("ENGINE_UNAVAILABLE", "The tab is not attached to Chrome.")
    if (resolved.point) {
      const hit = await runtimeValue<{ role: string; name: string }>(
        client,
        `(() => {
        const element = document.elementFromPoint(${resolved.point.x}, ${resolved.point.y});
        if (!element) return null;
        return { role: element.getAttribute('role') || element.tagName.toLowerCase(), name: String(element.getAttribute('aria-label') || element.innerText || element.value || '').trim().slice(0, 120) };
      })()`,
        tab.sessionId,
      )
      const note = hit ? `point hit ${hit.role} "${kernel.redact(hit.name)}"` : "point hit no element"
      return success({ ...resolved.point, note })
    }
    const node = resolved.node
    if (!node) return failure("TARGET_NOT_FOUND", "The target was not found.")
    try {
      await cdpCall(client, "DOM.scrollIntoViewIfNeeded", { backendNodeId: node.backendNodeId }, node.sessionId)
      const bounds = await getBox(client, node.sessionId, node.backendNodeId)
      const left = bounds?.[0] ?? 0
      const top = bounds?.[1] ?? 0
      const right = bounds?.[2] ?? 0
      const bottom = bounds?.[3] ?? 0
      if (!bounds || right <= left || bottom <= top)
        return failure("TARGET_NOT_INTERACTABLE", "The target has no visible size.")
      const width = right - left
      const height = bottom - top
      const points = [
        { x: left + width / 2, y: top + height / 2 },
        { x: left + width * 0.25, y: top + height * 0.25 },
        { x: left + width * 0.75, y: top + height * 0.25 },
        { x: left + width * 0.25, y: top + height * 0.75 },
        { x: left + width * 0.75, y: top + height * 0.75 },
      ]
      let covering: CoveringElement = { role: "unknown", name: "unknown", ref: null }
      for (const point of points) {
        const cdpHit = cdpResult(
          await cdpCall<unknown>(
            client,
            "DOM.getNodeForLocation",
            { x: Math.round(point.x), y: Math.round(point.y), includeUserAgentShadowDOM: true },
            node.sessionId,
          ),
        )
        const hitBackendNodeId = asNumber(cdpHit.backendNodeId)
        if (hitBackendNodeId === null) {
          return failure("TARGET_CHANGED", "Chrome did not return a CDP hit-test node for the target.")
        }
        const cdpQualifies =
          hitBackendNodeId === node.backendNodeId ||
          (await cdpNodeContains({
            client,
            sessionId: node.sessionId,
            ancestorBackendNodeId: node.backendNodeId,
            descendantBackendNodeId: hitBackendNodeId,
          })) ||
          (await cdpLabelQualifies({
            client,
            sessionId: node.sessionId,
            targetBackendNodeId: node.backendNodeId,
            hitBackendNodeId,
          }))
        if (cdpQualifies) return success({ ...point, sessionId: node.sessionId })
        const hit = await elementFromPoint({ client, node, x: point.x, y: point.y })
        // CDP may report a text/shadow node without usable ancestry after a
        // scroll. Verify containment against the resolved element at this point.
        if (hit.qualifies) return success({ ...point, sessionId: node.sessionId })
        covering = { role: hit.role, name: hit.name, ref: null }
        await cdpCall(
          client,
          "DOM.describeNode",
          { backendNodeId: hitBackendNodeId, depth: 0, pierce: true },
          node.sessionId,
        ).catch(() => undefined)
      }
      const matching = [...tab.refs.values()].find((item) => item.role === covering.role && item.name === covering.name)
      if (matching) covering.ref = matching.ref
      return failure(
        "TARGET_COVERED",
        `O alvo está coberto por ${covering.role} "${covering.name}". Feche o aviso ou modal com Escape ou o botão de fechar; depois execute browser_snapshot.`,
        covering,
      )
    } catch (error) {
      return failure(
        "TARGET_CHANGED",
        "O alvo mudou durante a verificação. Aguarde e execute browser_snapshot para obter o ref atual.",
        {
          role: "unknown",
          name: errorMessage(error),
          ref: null,
        },
      )
    }
  }

  const makeSnapshot = async (
    tab: TabState,
    image: ImageMode,
    signal: AbortSignal,
  ): Promise<OperationResult<{ snapshot: BrowserSnapshot; text: string }>> => {
    if (!client || !tab.sessionId) return failure("ENGINE_UNAVAILABLE", "The tab is not attached to Chrome.")
    if (tab.dialog && tab.lastSnapshot) {
      const previous = tab.lastSnapshot
      const previousRefs = [...tab.refs.values()]
      const nextGeneration = tab.generation + 1
      const refMap = new Map<string, string>()
      tab.generation = nextGeneration
      tab.refs.clear()
      const elements = previous.elements.map((element, index) => {
        const nextRef = `${nextGeneration}.${index}`
        const oldRef = previousRefs[index]
        if (oldRef) {
          const nextNode = { ...oldRef, ref: nextRef }
          tab.refs.set(nextRef, nextNode)
          refMap.set(element.ref, nextRef)
        }
        return { ...element, ref: nextRef }
      })
      const snapshot: BrowserSnapshot = {
        ...previous,
        generation: nextGeneration,
        focus: {
          ...previous.focus,
          ref: previous.focus.ref === null ? null : (refMap.get(previous.focus.ref) ?? null),
        },
        elements,
        recentActions: tab.actions
          .slice(-10)
          .map((item) => ({ ...item, note: kernel.redact(item.note).slice(0, 500) })),
        diagnostics: tab.diagnostics
          .slice(-20)
          .map((item) => ({ ...item, text: kernel.redact(item.text).slice(0, 500) })),
        notes: [
          ...previous.notes.filter((note) => !note.includes("dialog is open")),
          `A ${tab.dialog.type} dialog is open: "${tab.dialog.message}" — press Enter to accept or Escape to dismiss.`,
        ],
      }
      const safeSnapshot = boundSnapshot(redactSnapshot(snapshot, kernel.redact))
      tab.lastSnapshot = safeSnapshot
      store.save(tab)
      return success({ snapshot: safeSnapshot, text: renderSnapshot(safeSnapshot) })
    }
    let collected: { nodes: Array<NodeRef>; page: PageState; dropped: boolean } | null = null
    let lastError: unknown = null
    const navigationBefore = tab.navigationVersion
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        collected = await collectElements({ client, tab })
        if (tab.navigationVersion !== navigationBefore) throw new Error("Navigation started during snapshot")
        if (collected.nodes.length === 0 && collected.page.text.length > 0 && attempt === 0) {
          await sleep(100, signal)
          continue
        }
        break
      } catch (error) {
        lastError = error
        if (attempt === 0 && isSessionLost(error)) {
          await recoverTab(tab, signal).catch(() => undefined)
          continue
        }
        if (attempt === 0 && isTransient(error)) continue
        if (attempt === 0 && errorMessage(error).includes("Navigation started")) continue
      }
    }
    if (!collected || tab.navigationVersion !== navigationBefore) {
      const error = errorMessage(lastError)
      if (error.includes("Navigation"))
        return failure(
          "NAVIGATED_DURING_SNAPSHOT",
          "A página começou a navegar durante a leitura. Execute browser_snapshot de novo.",
        )
      const cause = browserError(lastError)
      return failure(cause.errorCode, `Não foi possível ler a página. ${cause.error}`)
    }
    if (!isReadableTabUrl(collected.page.url)) {
      tab.info.url = collected.page.url
      enforceTabUrl(tab)
      return failure("URL_NOT_ALLOWED", BROWSER_URL_NOT_ALLOWED_MESSAGE)
    }
    const nextGeneration = tab.generation + 1
    tab.generation = nextGeneration
    rememberRefs(tab)
    tab.refs.clear()
    const nodes = collected.nodes.map((node, index) => {
      const ref = `${nextGeneration}.${index}`
      const updated = { ...node, ref }
      tab.refs.set(ref, updated)
      return updated
    })
    const page = await pageState(client, tab)
    page.text = collected.page.text
    page.hasCanvas = page.hasCanvas || collected.page.hasCanvas
    page.hasVideo = page.hasVideo || collected.page.hasVideo
    page.crossOriginIframe = page.crossOriginIframe || collected.page.crossOriginIframe
    if (tab.navigationVersion !== navigationBefore)
      return failure(
        "NAVIGATED_DURING_SNAPSHOT",
        "A página começou a navegar durante a leitura. Execute browser_snapshot de novo.",
      )
    tab.info.url = page.url
    tab.info.title = page.title
    tab.info.state = "live"
    tab.info.lastUsedAt = Date.now()
    store.save(tab)
    const textWasTruncated = page.text.length > 20000
    const notes: Array<string> = []
    if (collected.dropped || textWasTruncated) notes.push("Scroll, or wait_for text, to read more")
    if (tab.dialog)
      notes.push(
        `A ${tab.dialog.type} dialog is open: "${tab.dialog.message}" — press Enter to accept or Escape to dismiss.`,
      )
    if (tab.handbackNote) {
      notes.push(tab.handbackNote)
      tab.handbackNote = null
    }
    const recommendImage =
      page.hasCanvas || page.hasVideo
        ? "canvas-or-video"
        : page.crossOriginIframe
          ? "iframe"
          : nodes.length < 3 && page.text.length > 200
            ? "low-semantic-coverage"
            : null
    let imageDataUrl: {
      dataUrl: string
      reason: "canvas-or-video" | "iframe" | "low-semantic-coverage" | "requested"
    } | null = null
    const effectiveImage = tab.secretMode ? "never" : image
    if (effectiveImage !== "never" && (effectiveImage === "always" || recommendImage !== null)) {
      try {
        const data = await boundedImage({ client, tab, fullPage: false, maxBytes: 80 * 1024 })
        imageDataUrl = {
          dataUrl: `data:image/jpeg;base64,${data}`,
          reason: effectiveImage === "always" ? "requested" : (recommendImage ?? "requested"),
        }
      } catch (error) {
        notes.push(`Screenshot unavailable: ${errorMessage(error).slice(0, 120)}`)
      }
    }
    const active = page.active
    const focusNode = nodes.find((node) => node.role === active.role && node.name === active.name)
    const elements = nodes.map((node) => elementFromNode(node, page))
    const snapshot: BrowserSnapshot = {
      tabId: tab.info.tabId,
      generation: nextGeneration,
      url: page.url,
      title: page.title,
      loading: page.loading,
      viewport: page.viewport,
      focus: { ref: focusNode?.ref ?? null, role: active.role || null, name: active.name || null },
      elements,
      text: page.text.slice(0, 20000),
      truncated: collected.dropped || textWasTruncated,
      recentActions: tab.actions.slice(-10).map((item) => ({ ...item, note: kernel.redact(item.note).slice(0, 500) })),
      diagnostics: tab.diagnostics
        .slice(-20)
        .map((item) => ({ ...item, text: kernel.redact(item.text).slice(0, 500) })),
      image: imageDataUrl,
      recommendImage,
      heldByUser: tab.info.heldByUser,
      notes,
    }
    const safeSnapshot = boundSnapshot(redactSnapshot(snapshot, kernel.redact))
    tab.lastSnapshot = safeSnapshot
    return success({ snapshot: safeSnapshot, text: renderSnapshot(safeSnapshot) })
  }

  const withTabQueue = async <T>({
    tab,
    timeoutMs,
    signal,
    operation,
  }: {
    tab: TabState
    timeoutMs: number
    signal: AbortSignal
    operation: (operationSignal: AbortSignal) => Promise<T>
  }): Promise<T> =>
    queueTab(tab, () =>
      withDeadline({
        operation,
        timeoutMs: timeoutMs + DEADLINE_SLACK_MS,
        signal,
        onTimeout: async () => {
          if (client && tab.sessionId)
            await cdpCall(client, "Page.stopLoading", {}, tab.sessionId).catch(() => undefined)
        },
      }),
    ).catch((error: unknown) => toToolError(browserError(error)) as T)

  const recordFailure = ({
    tab,
    tool,
    target,
    args,
    item,
  }: {
    tab: TabState
    tool: string
    target: unknown
    args: unknown
    item: BrowserFailure
  }): BrowserFailure => {
    const key = actionKey({ tool, target, args })
    if (tab.lastFailureKey === key) tab.failureCount += 1
    else {
      tab.lastFailureKey = key
      tab.failureCount = 1
    }
    if (tab.failureCount >= 3)
      return {
        errorCode: "REPEATED_FAILURE",
        error: "Change approach: take a snapshot, choose another target, or call browser_request_takeover.",
      }
    return item
  }

  const recordSuccess = (tab: TabState): void => {
    tab.lastFailureKey = null
    tab.failureCount = 0
  }

  const waitForPopups = async (tab: TabState, signal: AbortSignal): Promise<void> => {
    const endsAt = Date.now() + POPUP_WAIT_MS
    while ((pendingPopups.get(tab) ?? 0) > 0 && Date.now() < endsAt) await sleep(25, signal)
  }

  const withPopupNotes = ({
    tab,
    knownTabs,
    snapshot: value,
  }: {
    tab: TabState
    knownTabs: Set<string>
    snapshot: { snapshot: BrowserSnapshot; text: string }
  }): { snapshot: BrowserSnapshot; text: string } => {
    const opened = store
      .list(tab.info.ownerBotId)
      .filter(
        (item) =>
          !knownTabs.has(item.info.tabId) && item.info.openerTabId === tab.info.tabId && item.info.state !== "closed",
      )
    if (opened.length === 0) return value
    const notes = opened.map(
      (item) =>
        `Nova aba aberta por esta ação: ${item.info.tabId} (${kernel.redact(item.info.url)}). Esta aba continua em ${tab.info.tabId}; use browser_snapshot com o tabId da nova aba para trabalhar nela.`,
    )
    const next: BrowserSnapshot = { ...value.snapshot, notes: [...value.snapshot.notes, ...notes] }
    return { snapshot: next, text: renderSnapshot(next) }
  }

  const runAction = async ({
    tab,
    botId,
    tool,
    target,
    args,
    timeoutMs,
    signal,
    operation,
  }: {
    tab: TabState
    botId: Id
    tool: string
    target: unknown
    args: unknown
    timeoutMs: number
    signal: AbortSignal
    operation: (operationSignal: AbortSignal) => Promise<OperationResult<unknown>>
  }): Promise<ToolResult> => {
    void botId
    const result = await withTabQueue({
      tab,
      timeoutMs,
      signal,
      operation: async (operationSignal) => {
        const knownTabs = new Set(store.list(tab.info.ownerBotId).map((item) => item.info.tabId))
        const live = await ensureTab(tab, { signal: operationSignal, budgetMs: timeoutMs })
        if (!live.success) return toToolError(live.failure)
        let operationResult: OperationResult<unknown>
        try {
          operationResult = await withOneTransientRetry({
            operation: async () => {
              try {
                return await operation(operationSignal)
              } catch (error) {
                if (isSessionLost(error)) await recoverTab(tab, operationSignal).catch(() => undefined)
                throw error
              }
            },
            isTransient,
          })
        } catch (error) {
          operationResult = failure(
            errorMessage(error).includes("Navigation") ? "NAVIGATED_DURING_SNAPSHOT" : browserError(error).errorCode,
            browserError(error).error,
          )
        }
        if (!operationResult.success) {
          const guarded = recordFailure({ tab, tool, target, args, item: operationResult.failure })
          recordAction(tab, {
            at: Date.now(),
            tool,
            target: JSON.stringify(target).slice(0, 500),
            ok: false,
            errorCode: guarded.errorCode,
            note: guarded.error,
          })
          return toToolError(guarded)
        }
        recordSuccess(tab)
        await settle(client as CdpClient, tab, operationSignal)
        await waitForPopups(tab, operationSignal)
        const actionNote = typeof operationResult.value === "string" ? operationResult.value : "ok"
        recordAction(tab, {
          at: Date.now(),
          tool,
          target: JSON.stringify(target).slice(0, 500),
          ok: true,
          errorCode: null,
          note: actionNote.slice(0, 500),
        })
        const fresh = await makeSnapshot(tab, "auto", operationSignal)
        if (!fresh.success) return toToolError(fresh.failure)
        const announced = withPopupNotes({ tab, knownTabs, snapshot: fresh.value })
        const content: Array<ToolContent> = [{ type: "text", text: announced.text }]
        if (announced.snapshot.image)
          content.push({ type: "image", data: rawBase64(announced.snapshot.image.dataUrl), mimeType: "image/jpeg" })
        return { success: true, content, structured: announced.snapshot } satisfies ToolResult
      },
    })
    return result as ToolResult
  }

  const open = async ({
    url,
    ctx,
    timeoutMs,
  }: {
    url: string
    ctx: ToolContext
    timeoutMs: number
  }): Promise<ToolResult> => {
    unloadIdleTabs()
    const allowedUrl = normalizeBrowserUrl(url)
    if (allowedUrl === null)
      return toToolError({ errorCode: "URL_NOT_ALLOWED", error: BROWSER_URL_NOT_ALLOWED_MESSAGE })
    if (store.list(ctx.botId).length >= 25)
      return toToolError({ errorCode: "TAB_LIMIT", error: "This bot already has the maximum of 25 browser tabs." })
    const tab = store.create({
      botId: ctx.botId,
      threadId: ctx.threadId,
      url: allowedUrl,
      openerTabId: null,
      targetId: null,
    })
    tabs.push(tab)
    const result = await withTabQueue({
      tab,
      timeoutMs,
      signal: ctx.signal,
      operation: async (operationSignal) => {
        const live = await ensureTab(tab, { signal: operationSignal, budgetMs: timeoutMs })
        if (!live.success)
          return toToolError({
            ...live.failure,
            error: `${live.failure.error} A aba ${tab.info.tabId} continua aberta: use browser_navigate com esse tabId para tentar de novo ou browser_close_tab para descartá-la.`,
          })
        await settle(client as CdpClient, tab, operationSignal)
        const blocked = await blockedPageFailure(tab)
        recordAction(tab, {
          at: Date.now(),
          tool: "browser_open",
          target: url.slice(0, 500),
          ok: blocked === null,
          errorCode: blocked?.failure.errorCode ?? null,
          note: blocked?.failure.error ?? "ok",
        })
        if (blocked)
          return toToolError({
            ...blocked.failure,
            error: `${blocked.failure.error} A aba ${tab.info.tabId} continua aberta nessa página.`,
          })
        const fresh = await makeSnapshot(tab, "auto", operationSignal)
        if (!fresh.success) return toToolError(fresh.failure)
        const content: Array<ToolContent> = [{ type: "text", text: fresh.value.text }]
        if (fresh.value.snapshot.image)
          content.push({ type: "image", data: rawBase64(fresh.value.snapshot.image.dataUrl), mimeType: "image/jpeg" })
        return { success: true, content, structured: fresh.value.snapshot } satisfies ToolResult
      },
    })
    return result as ToolResult
  }

  const list = async ({
    botId,
  }: {
    botId: Id | null
    signal?: AbortSignal
    timeoutMs?: number
  }): Promise<ToolResult> => {
    if (discoverBotId && !(await ensureClient(true)))
      return toToolSuccess({
        content: [
          { type: "text", text: "[]\nNavegador ainda não aberto. Use browser_open para abrir uma página na VM." },
        ],
        structured: { tabs: [] },
      })
    if (discoverBotId && client) {
      const result = cdpResult(await client.call<unknown>("Target.getTargets"))
      const pages = asArray(result.targetInfos)
        .map(targetInfo)
        .filter((info) => info?.type === "page")
      for (const info of pages) {
        if (!info) continue
        let tab = tabs.find((candidate) => candidate.targetId === info.targetId)
        tab ??= tabs.find((candidate) => candidate.info.state === "unloaded" && candidate.info.url === info.url)
        if (!tab) {
          if (store.list(discoverBotId).length >= 25) continue
          tab = store.create({
            botId: discoverBotId,
            threadId: kernel.services.use("store.api")?.getBot({ botId: discoverBotId })?.mainThreadId ?? "",
            url: info.url,
            openerTabId: null,
            targetId: info.targetId,
          })
          tabs.push(tab)
        }
        tab.info.url = info.url
        tab.info.title = info.title
        if (!tab.sessionId) await attach(tab, info.targetId)
        publishTab(tab)
      }
      for (const tab of tabs) {
        if (tab.targetId && !pages.some((info) => info?.targetId === tab.targetId)) {
          targetToTab.delete(tab.targetId)
          tab.targetId = null
          tab.sessionId = null
          tab.info.state = "closed"
          publishTab(tab)
        }
      }
    }
    unloadIdleTabs()
    const publicTabs = store.list(botId).map((tab) => {
      const info = publicTabInfo({ tab })
      return { ...info, url: kernel.redact(info.url), title: kernel.redact(info.title) }
    })
    return toToolSuccess({
      content: [{ type: "text", text: JSON.stringify(publicTabs) }],
      structured: { tabs: publicTabs },
    })
  }

  const close = async ({
    tabId,
    botId,
    signal,
    timeoutMs = DEFAULT_TOOL_TIMEOUT_MS,
  }: {
    tabId: Id
    botId: Id
    signal: AbortSignal
    timeoutMs?: number
  }): Promise<ToolResult> => {
    const owned = getTab({ tabId, botId })
    if (!owned.success) return toToolError(owned.failure)
    const tab = owned.value
    return withTabQueue({
      tab,
      timeoutMs,
      signal,
      operation: async () => {
        if (client && tab.targetId)
          await client.call("Target.closeTarget", { targetId: tab.targetId }).catch(() => undefined)
        tab.info.state = "closed"
        tab.targetId = null
        tab.sessionId = null
        tab.frameSessions.clear()
        tab.info.lastUsedAt = Date.now()
        store.save(tab)
        kernel.publish({ type: "browser.tab", tab: safePublicTabInfo(tab) })
        return toToolSuccess({
          content: [{ type: "text", text: `Closed ${tabId}` }],
          structured: { tabId, state: "closed", closed: true, generation: tab.generation + 1 },
        })
      },
    }) as Promise<ToolResult>
  }

  const snapshot = async ({
    tabId,
    botId,
    image,
    signal,
    timeoutMs = DEFAULT_TOOL_TIMEOUT_MS,
  }: {
    tabId: Id
    botId: Id
    image: ImageMode
    signal: AbortSignal
    timeoutMs?: number
  }): Promise<ToolResult> => {
    const owned = getTab({ tabId, botId })
    if (!owned.success) return toToolError(owned.failure)
    const tab = owned.value
    return withTabQueue({
      tab,
      timeoutMs,
      signal,
      operation: async (operationSignal) => {
        const live = await ensureTab(tab, { signal: operationSignal, budgetMs: timeoutMs })
        if (!live.success) return toToolError(live.failure)
        const result = await makeSnapshot(tab, image, operationSignal)
        if (!result.success) return toToolError(result.failure)
        return snapshotToolResult(result.value)
      },
    }) as Promise<ToolResult>
  }

  const snapshotToolResult = ({ snapshot: value, text }: { snapshot: BrowserSnapshot; text: string }): ToolResult => {
    const content: Array<ToolContent> = [{ type: "text", text }]
    if (value.image) content.push({ type: "image", data: rawBase64(value.image.dataUrl), mimeType: "image/jpeg" })
    return toToolSuccess({ content, structured: value })
  }

  const screenshot = async ({
    tabId,
    botId,
    fullPage,
    signal,
    timeoutMs = DEFAULT_TOOL_TIMEOUT_MS,
  }: {
    tabId: Id
    botId: Id
    fullPage: boolean
    signal: AbortSignal
    timeoutMs?: number
  }): Promise<ToolResult> => {
    const owned = getTab({ tabId, botId })
    if (!owned.success) return toToolError(owned.failure)
    const tab = owned.value
    return withTabQueue({
      tab,
      timeoutMs,
      signal,
      operation: async (operationSignal) => {
        const live = await ensureTab(tab, { signal: operationSignal, budgetMs: timeoutMs })
        if (!live.success) return toToolError(live.failure)
        if (tab.secretMode)
          return toToolError({
            errorCode: "SECRET_ENTRY_ACTIVE",
            error: "Capturas de tela ficam bloqueadas enquanto a entrada de segredo está ativa.",
          })
        if (await pageUrlBlocked(tab))
          return toToolError({ errorCode: "URL_NOT_ALLOWED", error: BROWSER_URL_NOT_ALLOWED_MESSAGE })
        const data = await boundedImage({ client: client as CdpClient, tab, fullPage }).catch((error: unknown) => {
          if (errorMessage(error) === SCREENSHOT_TOO_LARGE) return null
          throw error
        })
        if (data === null)
          return toToolError({
            errorCode: "ENGINE_UNAVAILABLE",
            error:
              "A captura de tela ficou grande demais mesmo reduzida. Use browser_snapshot ou capture sem fullPage.",
          })
        return toToolSuccess({
          content: [{ type: "image", data, mimeType: "image/jpeg" }],
        })
      },
    }) as Promise<ToolResult>
  }

  const navigationCommand = async ({
    tab,
    url,
    action,
  }: {
    tab: TabState
    url: string | undefined
    action: string
  }): Promise<string | null> => {
    if (!client || !tab.sessionId) return null
    if (action === "back") await cdpCall(client, "Page.goBack", {}, tab.sessionId)
    else if (action === "forward") await cdpCall(client, "Page.goForward", {}, tab.sessionId)
    else if (action === "reload") await cdpCall(client, "Page.reload", { ignoreCache: false }, tab.sessionId)
    else return asString(cdpResult(await cdpCall<unknown>(client, "Page.navigate", { url }, tab.sessionId)).errorText)
    return null
  }

  const awaitPageReady = async ({
    tab,
    url,
    action,
    before,
    endsAt,
    signal,
  }: {
    tab: TabState
    url: string | undefined
    action: string
    before: { version: number; url: string }
    endsAt: number
    signal: AbortSignal
  }): Promise<OperationResult<string>> => {
    const hashOnly = url !== undefined && stripHash(url) === stripHash(before.url) && url.includes("#")
    let interactiveAt: number | null = null
    while (Date.now() < endsAt) {
      signal.throwIfAborted()
      const state = await pageLocation(tab).catch((error: unknown) => {
        if (isSessionLost(error)) throw error
        return null
      })
      if (state && isChromeErrorPage(state.href))
        return failure(
          "NAVIGATION_FAILED",
          describeNavigationFailure({ code: networkErrorCode(state.text), url: kernel.redact(url ?? state.href) }),
        )
      const committed =
        tab.navigationVersion !== before.version ||
        (hashOnly && state?.href === url) ||
        ((action === "back" || action === "forward") && state !== null && state.href !== before.url)
      if (state && committed && state.readyState === "complete") return success("ok")
      if (state && committed && state.readyState === "interactive") {
        interactiveAt ??= Date.now()
        if (Date.now() - interactiveAt >= LOAD_IDLE_CAP_MS)
          return success("A página já é utilizável; alguns recursos ainda carregavam.")
      }
      await sleep(NAVIGATION_POLL_MS, signal)
    }
    if (interactiveAt !== null) return success("A página já é utilizável; alguns recursos ainda carregavam.")
    return failure(
      "DEADLINE_EXCEEDED",
      `A página ${kernel.redact(url ?? tab.info.url)} não terminou de abrir no prazo. Execute browser_snapshot para ver o estado atual ou tente de novo com timeoutMs maior.`,
    )
  }

  const navigatePage = async (
    tab: TabState,
    requestedUrl: string | undefined,
    action: string,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<OperationResult<string>> => {
    if (!client || !tab.sessionId) return failure("ENGINE_UNAVAILABLE", "A aba não está conectada ao Chrome.")
    if (!["goto", "back", "forward", "reload"].includes(action))
      return failure("INVALID_ARGS", "browser_navigate recebeu uma ação não suportada.")
    if (action === "goto" && !requestedUrl)
      return failure("INVALID_ARGS", "browser_navigate com action=goto exige url.")
    const url = action === "goto" && requestedUrl ? normalizeBrowserUrl(requestedUrl) : requestedUrl
    if (url === null) return failure("URL_NOT_ALLOWED", BROWSER_URL_NOT_ALLOWED_MESSAGE)
    const endsAt = Date.now() + timeoutMs
    const before = { version: tab.navigationVersion, url: tab.info.url }
    const started = await raceBudget({ work: navigationCommand({ tab, url, action }), ms: timeoutMs, signal })
    if (started.timedOut) {
      if (client && tab.sessionId) void cdpCall(client, "Page.stopLoading", {}, tab.sessionId).catch(() => undefined)
      return failure(
        "DEADLINE_EXCEEDED",
        `A página ${kernel.redact(url ?? tab.info.url)} não respondeu em ${Math.round(timeoutMs / 1000)} s (servidor parado ou rede bloqueada).`,
      )
    }
    if (started.value !== null && started.value !== "net::ERR_ABORTED")
      return failure(
        "NAVIGATION_FAILED",
        describeNavigationFailure({ code: networkErrorCode(started.value), url: kernel.redact(url ?? tab.info.url) }),
      )
    const ready = await awaitPageReady({ tab, url, action, before, endsAt, signal })
    if (!ready.success) return ready
    return (await blockedPageFailure(tab)) ?? ready
  }

  const navigate = async ({
    tabId,
    botId,
    url,
    action,
    timeoutMs,
    signal,
  }: {
    tabId: Id
    botId: Id
    url?: string
    action: string
    timeoutMs: number
    signal: AbortSignal
  }): Promise<ToolResult> => {
    const owned = getTab({ tabId, botId })
    if (!owned.success) return toToolError(owned.failure)
    return runAction({
      tab: owned.value,
      botId,
      tool: "browser_navigate",
      target: url ?? action,
      args: { url, action },
      timeoutMs,
      signal,
      operation: (operationSignal) => navigatePage(owned.value, url, action, timeoutMs, operationSignal),
    })
  }

  const resolveWithRetry = async (tab: TabState, target: BrowserTarget): Promise<ResolveResult> => {
    try {
      return await withOneTransientRetry({ operation: () => resolveTarget(tab, target), isTransient })
    } catch {
      return failure("TARGET_CHANGED", "The target changed while it was being resolved; take a fresh snapshot.")
    }
  }

  const resolveClickTarget = async (tab: TabState, target: BrowserTarget): Promise<ResolveResult> => {
    const resolved = await resolveWithRetry(tab, target)
    if (resolved.success || target.kind !== "ref" || !client) return resolved
    const remembered = tab.refs.get(target.ref)
    const history = refHistory.get(tab)?.get(target.ref)
    const original = remembered ?? history?.node
    if (!original)
      return failure(
        "STALE_REF",
        "Esse ref não está disponível. Execute browser_snapshot e use target: {kind: 'ref', ref: 'geração.índice'}.",
      )
    // Across navigation only a link with the same href can keep its identity.
    if (history && history.url !== tab.info.url && !original.fingerprint.href)
      return failure(
        "TARGET_CHANGED",
        "A página navegou e esse elemento mudou. Execute browser_snapshot e escolha o alvo na página atual.",
      )
    const collected = await collectElements({ client, tab })
    const matches = collected.nodes.filter(
      (node) =>
        node.name === original.name &&
        node.role === original.role &&
        JSON.stringify(node.fingerprint) === JSON.stringify(original.fingerprint) &&
        (!history ||
          !original.fingerprint.href ||
          new URL(original.fingerprint.href, history.url).href ===
            new URL(node.fingerprint.href ?? "", tab.info.url).href) &&
        (node.frame === original.frame || node.sessionId === tab.sessionId),
    )
    if (matches.length > 1)
      return failure(
        "AMBIGUOUS_TARGET",
        "O ref antigo corresponde a vários elementos. Execute browser_snapshot e escolha um ref atual.",
      )
    if (matches.length === 0)
      return failure(
        "TARGET_CHANGED",
        "O elemento foi removido ou mudou de destino. Execute browser_snapshot e escolha o link ou botão atual.",
      )
    return { success: true, node: matches[0] ?? null, point: null }
  }

  const snapshotHitPoint = async (
    node: NodeRef,
  ): Promise<OperationResult<{ x: number; y: number; sessionId: string }>> => {
    if (!client) return failure("ENGINE_UNAVAILABLE", "Não foi possível conectar ao navegador. Tente novamente.")
    const resolved = cdpResult(
      await cdpCall<unknown>(client, "DOM.resolveNode", { backendNodeId: node.backendNodeId }, node.sessionId),
    )
    const objectId = asString(asRecord(resolved.object)?.objectId)
    if (!objectId) throw new Error("Node is detached")
    await cdpCall(
      client,
      "Runtime.callFunctionOn",
      {
        objectId,
        functionDeclaration:
          "function () { if (this.isConnected) this.scrollIntoView({block: 'center', inline: 'nearest', behavior: 'instant'}); }",
      },
      node.sessionId,
    )
    const bounds = (await getBox(client, node.sessionId, node.backendNodeId)) ?? node.bounds
    const [left = 0, top = 0, right = 0, bottom = 0] = bounds
    if (!bounds.every(Number.isFinite) || right <= left || bottom <= top)
      return failure(
        "TARGET_NOT_INTERACTABLE",
        "O elemento não tem uma área visível. Role a página e execute browser_snapshot.",
      )
    const point = { x: (left + right) / 2, y: (top + bottom) / 2 }
    // Coordinate fallback still checks the actual hit. Never click through an overlay.
    const hit = await elementFromPoint({ client, node, ...point })
    return hit.qualifies
      ? success({ ...point, sessionId: node.sessionId })
      : failure(
          "TARGET_COVERED",
          "Outro elemento cobre esse alvo. Feche o aviso ou modal e execute browser_snapshot antes de tentar novamente.",
        )
  }

  const dispatchClick = async ({
    tab,
    point,
    sessionId,
    button,
    clickCount,
  }: {
    tab: TabState
    point: { x: number; y: number }
    sessionId?: string
    button: "left" | "right" | "middle"
    clickCount: number
  }): Promise<void> => {
    if (!client || !tab.sessionId) throw new Error("Tab is not attached")
    const targetSessionId = sessionId ?? tab.sessionId
    const dialog = waitForEvent({
      client,
      method: "Page.javascriptDialogOpening",
      sessionId: targetSessionId,
      timeoutMs: 500,
    }).catch(() => null)
    const pressed = cdpCall(
      client,
      "Input.dispatchMouseEvent",
      { type: "mousePressed", x: point.x, y: point.y, button, clickCount },
      targetSessionId,
    ).then(() => "pressed" as const)
    const result = await Promise.race([
      pressed,
      dialog.then((event) => (event === null ? ("timeout" as const) : ("dialog" as const))),
    ])
    if (result === "dialog" || tab.dialog) return
    await sleep(25)
    if (tab.dialog) return
    const releaseDialog = waitForEvent({
      client,
      method: "Page.javascriptDialogOpening",
      sessionId: targetSessionId,
      timeoutMs: 500,
    }).catch(() => null)
    const released = cdpCall(
      client,
      "Input.dispatchMouseEvent",
      { type: "mouseReleased", x: point.x, y: point.y, button, clickCount },
      targetSessionId,
    ).then(() => "released" as const)
    const releaseResult = await Promise.race([
      released,
      releaseDialog.then((event) => (event === null ? ("timeout" as const) : ("dialog" as const))),
    ])
    if (releaseResult === "dialog" || tab.dialog) return
  }

  const click = async ({
    tabId,
    botId,
    target,
    button,
    clickCount,
    timeoutMs,
    signal,
  }: {
    tabId: Id
    botId: Id
    target: BrowserTarget
    button: "left" | "right" | "middle"
    clickCount: number
    timeoutMs: number
    signal: AbortSignal
  }): Promise<ToolResult> => {
    const owned = getTab({ tabId, botId })
    if (!owned.success) return toToolError(owned.failure)
    const tab = owned.value
    return runAction({
      tab,
      botId,
      tool: "browser_click",
      target,
      args: { button, clickCount },
      timeoutMs,
      signal,
      operation: async (operationSignal) => {
        await settle(client as CdpClient, tab, operationSignal)
        let hit: Awaited<ReturnType<typeof hitPoint>> = failure(
          "TARGET_CHANGED",
          "A página continua mudando. Aguarde, execute browser_snapshot e tente o ref atual.",
        )
        let clicked: NodeRef | null = null
        for (let attempt = 0; attempt < 3; attempt++) {
          operationSignal.throwIfAborted()
          const resolved = await resolveClickTarget(tab, target)
          if (!resolved.success) {
            if (!["TARGET_CHANGED", "TARGET_NOT_FOUND"].includes(resolved.failure.errorCode)) return resolved
            hit = resolved
          } else {
            clicked = resolved.node
            hit = await hitPoint(tab, resolved)
            if (!hit.success && hit.failure.errorCode === "TARGET_CHANGED" && resolved.node) {
              try {
                hit = await snapshotHitPoint(resolved.node)
              } catch {
                /* A detached node needs re-resolution. */
              }
            }
            if (hit.success) {
              await sleep(50, operationSignal)
              const stable = await resolveClickTarget(tab, target)
              if (stable.success && stable.node?.backendNodeId === resolved.node?.backendNodeId) {
                const next = await hitPoint(tab, stable)
                if (
                  next.success &&
                  Math.abs(next.value.x - hit.value.x) < 1 &&
                  Math.abs(next.value.y - hit.value.y) < 1
                ) {
                  hit = next
                  break
                }
                if (!next.success && next.failure.errorCode === "TARGET_CHANGED" && stable.node) {
                  const fallback = await snapshotHitPoint(stable.node)
                  if (
                    fallback.success &&
                    Math.abs(fallback.value.x - hit.value.x) < 1 &&
                    Math.abs(fallback.value.y - hit.value.y) < 1
                  ) {
                    hit = fallback
                    break
                  }
                }
              }
              hit = failure(
                "TARGET_CHANGED",
                "O elemento não estabilizou. Aguarde e execute browser_snapshot para obter o ref atual.",
              )
            } else if (hit.failure.errorCode !== "TARGET_CHANGED") return hit
          }
          await sleep(75, operationSignal)
        }
        if (!hit.success)
          return hit.failure.errorCode === "TARGET_NOT_FOUND"
            ? failure(
                "TARGET_NOT_FOUND",
                "O alvo não apareceu na página atual. Confira o endereço e execute browser_snapshot para escolher um ref atual.",
              )
            : hit
        operationSignal.throwIfAborted()
        if (
          clicked &&
          !(await waitUntilEnabled({ client: client as CdpClient, node: clicked, signal: operationSignal }))
        )
          return failure(
            "TARGET_NOT_INTERACTABLE",
            "O elemento está desativado (disabled). Preencha os campos obrigatórios ou aguarde e execute browser_snapshot antes de clicar de novo.",
          )
        try {
          await dispatchClick({
            tab,
            point: hit.value,
            ...(hit.value.sessionId === undefined ? {} : { sessionId: hit.value.sessionId }),
            button,
            clickCount,
          })
        } catch {
          // Once a mouse event was sent, never replay it: it may have navigated
          // or submitted successfully before the transport lost its response.
          return failure(
            "TARGET_CHANGED",
            "A página mudou durante o clique. Execute browser_snapshot e confira o resultado antes de clicar novamente.",
          )
        }
        return success(hit.value.note)
      },
    })
  }

  const dispatchKey = async ({
    tab,
    sessionId,
    key,
    code,
    modifiers = 0,
    text,
    keyCode,
  }: {
    tab: TabState
    sessionId?: string
    key: string
    code?: string
    modifiers?: number
    text?: string
    keyCode?: number
  }): Promise<void> => {
    const keyCodeParams = keyCode === undefined ? {} : { windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode }
    if (!client || !tab.sessionId) throw new Error("Tab is not attached")
    const targetSessionId = sessionId ?? tab.sessionId
    await cdpCall(
      client,
      "Input.dispatchKeyEvent",
      { type: "keyDown", key, code: code ?? key, modifiers, ...keyCodeParams, ...(text === undefined ? {} : { text }) },
      targetSessionId,
    )
    await cdpCall(
      client,
      "Input.dispatchKeyEvent",
      { type: "keyUp", key, code: code ?? key, modifiers, ...keyCodeParams },
      targetSessionId,
    )
  }

  const clearField = async ({ tab, node }: { tab: TabState; node: NodeRef }): Promise<void> => {
    const live = client as CdpClient
    await callOnNode(live, node, SELECT_FIELD_CONTENTS)
    await dispatchKey({
      tab,
      sessionId: node.sessionId,
      key: "Backspace",
      code: "Backspace",
      keyCode: BACKSPACE_KEY_CODE,
    })
    if ((await callOnNode(live, node, FIELD_IS_EMPTY)) === true) return
    await callOnNode(live, node, FORCE_CLEAR_FIELD)
  }

  const type = async ({
    tabId,
    botId,
    target,
    text,
    clear,
    submit,
    timeoutMs,
    signal,
  }: {
    tabId: Id
    botId: Id
    target: BrowserTarget
    text: string
    clear: boolean
    submit: boolean
    timeoutMs: number
    signal: AbortSignal
  }): Promise<ToolResult> => {
    const owned = getTab({ tabId, botId })
    if (!owned.success) return toToolError(owned.failure)
    const tab = owned.value
    return runAction({
      tab,
      botId,
      tool: "browser_type",
      target,
      args: { clear, submit },
      timeoutMs,
      signal,
      operation: async () => {
        const resolved = await resolveWithRetry(tab, target)
        if (!resolved.success) return resolved
        if (!resolved.node) return failure("TARGET_NOT_INTERACTABLE", "Typing needs an element target, not a point.")
        const descriptor = await describe(client as CdpClient, resolved.node.sessionId, resolved.node.backendNodeId)
        if (descriptor.password)
          return failure("INVALID_ARGS", "Never type passwords or codes directly; use browser_submit_secret.")
        await focusNode(client as CdpClient, resolved.node)
        if (clear) await clearField({ tab, node: resolved.node })
        await cdpCall(client as CdpClient, "Input.insertText", { text }, resolved.node.sessionId)
        if (submit) await dispatchKey({ tab, key: "Enter", code: "Enter", text: "\r" })
        return success(undefined)
      },
    })
  }

  const press = async ({
    tabId,
    botId,
    key,
    timeoutMs,
    signal,
  }: {
    tabId: Id
    botId: Id
    key: string
    timeoutMs: number
    signal: AbortSignal
  }): Promise<ToolResult> => {
    const owned = getTab({ tabId, botId })
    if (!owned.success) return toToolError(owned.failure)
    const tab = owned.value
    return runAction({
      tab,
      botId,
      tool: "browser_press",
      target: key,
      args: {},
      timeoutMs,
      signal,
      operation: async () => {
        if (!client || !tab.sessionId) return failure("ENGINE_UNAVAILABLE", "The tab is not attached to Chrome.")
        if (tab.dialog && (key === "Escape" || key === "Enter")) {
          await cdpCall(client, "Page.handleJavaScriptDialog", { accept: key === "Enter" }, tab.sessionId)
          tab.dialog = null
          return success(undefined)
        }
        const parts = key
          .split("+")
          .map((item) => item.trim())
          .filter((item) => item.length > 0)
        const rawKey = parts.pop() ?? key
        const modifiers =
          (parts.includes("Alt") || parts.includes("alt") ? 1 : 0) |
          (parts.includes("Ctrl") || parts.includes("ctrl") ? 2 : 0) |
          (parts.includes("Meta") || parts.includes("meta") || parts.includes("Cmd") || parts.includes("cmd") ? 4 : 0) |
          (parts.includes("Shift") || parts.includes("shift") ? 8 : 0)
        await dispatchKey({
          tab,
          key: rawKey,
          code: rawKey.length === 1 ? `Key${rawKey.toUpperCase()}` : rawKey,
          modifiers,
          ...(rawKey === "Enter" ? { text: "\r" } : {}),
        })
        return success(undefined)
      },
    })
  }

  const hover = async ({
    tabId,
    botId,
    target,
    timeoutMs,
    signal,
  }: {
    tabId: Id
    botId: Id
    target: BrowserTarget
    timeoutMs: number
    signal: AbortSignal
  }): Promise<ToolResult> => {
    const owned = getTab({ tabId, botId })
    if (!owned.success) return toToolError(owned.failure)
    return runAction({
      tab: owned.value,
      botId,
      tool: "browser_hover",
      target,
      args: {},
      timeoutMs,
      signal,
      operation: async () => {
        const resolved = await resolveWithRetry(owned.value, target)
        if (!resolved.success) return resolved
        const hit = await hitPoint(owned.value, resolved)
        if (!hit.success) return hit
        if (!client || !owned.value.sessionId)
          return failure("ENGINE_UNAVAILABLE", "The tab is not attached to Chrome.")
        await cdpCall(
          client,
          "Input.dispatchMouseEvent",
          { type: "mouseMoved", x: hit.value.x, y: hit.value.y },
          hit.value.sessionId ?? owned.value.sessionId,
        )
        return success(hit.value.note)
      },
    })
  }

  const scroll = async ({
    tabId,
    botId,
    target,
    direction,
    pages,
    signal,
    timeoutMs = DEFAULT_TOOL_TIMEOUT_MS,
  }: {
    tabId: Id
    botId: Id
    target: BrowserTarget | null
    direction: "down" | "up"
    pages: number
    signal: AbortSignal
    timeoutMs?: number
  }): Promise<ToolResult> => {
    const owned = getTab({ tabId, botId })
    if (!owned.success) return toToolError(owned.failure)
    const tab = owned.value
    return runAction({
      tab,
      botId,
      tool: "browser_scroll",
      target: target ?? direction,
      args: { direction, pages },
      timeoutMs,
      signal,
      operation: async () => {
        if (!client || !tab.sessionId) return failure("ENGINE_UNAVAILABLE", "The tab is not attached to Chrome.")
        if (target) {
          const resolved = await resolveWithRetry(tab, target)
          if (!resolved.success) return resolved
          if (!resolved.node) return failure("TARGET_NOT_INTERACTABLE", "Scroll target must resolve to an element.")
          await cdpCall(
            client,
            "DOM.scrollIntoViewIfNeeded",
            { backendNodeId: resolved.node.backendNodeId },
            resolved.node.sessionId,
          )
        } else {
          const page = await pageState(client, tab)
          await runtimeValue<unknown>(
            client,
            `window.scrollBy(0, ${direction === "down" ? 1 : -1} * ${clamp(pages, 0.1, 10)} * ${Math.max(page.viewport.height, 1)})`,
            tab.sessionId,
          )
        }
        return success(undefined)
      },
    })
  }

  const nodeObjectId = async (node: NodeRef): Promise<string> => {
    const result = cdpResult(
      await cdpCall<unknown>(
        client as CdpClient,
        "DOM.resolveNode",
        { backendNodeId: node.backendNodeId },
        node.sessionId,
      ),
    )
    const objectId = asString(asRecord(result.object)?.objectId)
    if (!objectId) throw new Error("Node is detached")
    return objectId
  }

  const selectOption = async ({
    tabId,
    botId,
    target,
    values,
    signal,
    timeoutMs = DEFAULT_TOOL_TIMEOUT_MS,
  }: {
    tabId: Id
    botId: Id
    target: BrowserTarget
    values: Array<string>
    signal: AbortSignal
    timeoutMs?: number
  }): Promise<ToolResult> => {
    const owned = getTab({ tabId, botId })
    if (!owned.success) return toToolError(owned.failure)
    const tab = owned.value
    return runAction({
      tab,
      botId,
      tool: "browser_select_option",
      target,
      args: { values },
      timeoutMs,
      signal,
      operation: async () => {
        const resolved = await resolveWithRetry(tab, target)
        if (!resolved.success) return resolved
        if (!resolved.node) return failure("TARGET_NOT_INTERACTABLE", "Option selection needs an element target.")
        const objectId = await nodeObjectId(resolved.node)
        const result = cdpResult(
          await cdpCall<unknown>(
            client as CdpClient,
            "Runtime.callFunctionOn",
            {
              objectId,
              functionDeclaration: `function (values) {
          const wanted = new Set(values);
          const options = Array.from(this.options || []);
          const matches = options.filter((option) => wanted.has(option.value) || wanted.has(option.textContent.trim()));
          if (matches.length === 0) return false;
          for (const option of options) option.selected = matches.includes(option);
          this.dispatchEvent(new Event('input', { bubbles: true }));
          this.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }`,
              arguments: [{ value: values }],
              returnByValue: true,
            },
            resolved.node.sessionId,
          ),
        )
        if (
          asBoolean(asRecord(asRecord(result.result)?.value)) === false ||
          asBoolean(asRecord(result.result)?.value) === false
        )
          return failure("TARGET_NOT_FOUND", "None of the requested options was found.")
        return success(undefined)
      },
    })
  }

  const setChecked = async ({
    tabId,
    botId,
    target,
    checked,
    signal,
    timeoutMs = DEFAULT_TOOL_TIMEOUT_MS,
  }: {
    tabId: Id
    botId: Id
    target: BrowserTarget
    checked: boolean
    signal: AbortSignal
    timeoutMs?: number
  }): Promise<ToolResult> => {
    const owned = getTab({ tabId, botId })
    if (!owned.success) return toToolError(owned.failure)
    const tab = owned.value
    return runAction({
      tab,
      botId,
      tool: "browser_set_checked",
      target,
      args: { checked },
      timeoutMs,
      signal,
      operation: async () => {
        const resolved = await resolveWithRetry(tab, target)
        if (!resolved.success) return resolved
        if (!resolved.node) return failure("TARGET_NOT_INTERACTABLE", "Setting checked needs an element target.")
        const objectId = await nodeObjectId(resolved.node)
        await cdpCall(
          client as CdpClient,
          "Runtime.callFunctionOn",
          {
            objectId,
            functionDeclaration: `function (checked) {
          if ('checked' in this) this.checked = checked;
          this.setAttribute('aria-checked', String(checked));
          this.dispatchEvent(new Event('input', { bubbles: true }));
          this.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }`,
            arguments: [{ value: checked }],
            returnByValue: true,
          },
          resolved.node.sessionId,
        )
        return success(undefined)
      },
    })
  }

  const waitFor = async ({
    tabId,
    botId,
    condition,
    timeoutMs,
    signal,
  }: {
    tabId: Id
    botId: Id
    condition: unknown
    timeoutMs: number
    signal: AbortSignal
  }): Promise<ToolResult> => {
    const owned = getTab({ tabId, botId })
    if (!owned.success) return toToolError(owned.failure)
    const tab = owned.value
    const conditionRecord = asRecord(condition)
    const deadlineResult = async (): Promise<ToolResult> => {
      const timedOut = toToolError({
        errorCode: "DEADLINE_EXCEEDED",
        error: "A condição de espera não foi atendida no prazo. Veja o estado atual da página abaixo.",
      })
      const fresh = await makeSnapshot(tab, "auto", new AbortController().signal)
      if (!fresh.success) return timedOut
      return {
        ...timedOut,
        content: [...(timedOut.content ?? []), { type: "text", text: fresh.value.text }],
      }
    }
    return withTabQueue({
      tab,
      timeoutMs,
      signal,
      operation: async (operationSignal) => {
        const live = await ensureTab(tab)
        if (!live.success) return toToolError(live.failure)
        const started = Date.now()
        let lastMutation = -1
        let quietAt = Date.now()
        while (Date.now() - started < timeoutMs) {
          if (operationSignal.aborted)
            return toToolError({ errorCode: "DEADLINE_EXCEEDED", error: "A espera passou do prazo." })
          const page = await pageState(client as CdpClient, tab)
          let matched = false
          const targetCondition = asRecord(conditionRecord?.target)
          const wantedUrl = asString(conditionRecord?.url)
          const wantedText = asString(conditionRecord?.text)
          const state = asString(conditionRecord?.state)
          if (wantedUrl !== null) matched = page.url.includes(wantedUrl)
          else if (wantedText !== null) matched = page.text.includes(wantedText)
          else if (state === "domcontentloaded") matched = page.readyState !== "loading"
          else if (state === "load") matched = page.readyState === "complete"
          else if (state === "dom-quiet") {
            if (page.mutationVersion !== lastMutation) {
              lastMutation = page.mutationVersion
              quietAt = Date.now()
            }
            matched = Date.now() - quietAt >= 250
          } else if (targetCondition) {
            const resolved = await resolveWithRetry(tab, targetCondition as unknown as BrowserTarget)
            matched = resolved.success
          }
          if (matched) {
            const fresh = await makeSnapshot(tab, "auto", operationSignal)
            if (!fresh.success) return toToolError(fresh.failure)
            return snapshotToolResult(fresh.value)
          }
          await sleep(50, operationSignal).catch(() => undefined)
        }
        return deadlineResult()
      },
    }) as Promise<ToolResult>
  }

  const evaluate = async ({
    tabId,
    botId,
    expression,
    signal,
    timeoutMs = DEFAULT_TOOL_TIMEOUT_MS,
  }: {
    tabId: Id
    botId: Id
    expression: string
    signal: AbortSignal
    timeoutMs?: number
  }): Promise<ToolResult> => {
    const owned = getTab({ tabId, botId })
    if (!owned.success) return toToolError(owned.failure)
    const tab = owned.value
    return withTabQueue({
      tab,
      timeoutMs,
      signal,
      operation: async (operationSignal) => {
        const live = await ensureTab(tab, { signal: operationSignal, budgetMs: timeoutMs })
        if (!live.success) return toToolError(live.failure)
        if (tab.secretMode)
          return toToolError({
            errorCode: "SECRET_ENTRY_ACTIVE",
            error: "A avaliação de scripts fica bloqueada enquanto a entrada de segredo está ativa.",
          })
        if (await pageUrlBlocked(tab))
          return toToolError({ errorCode: "URL_NOT_ALLOWED", error: BROWSER_URL_NOT_ALLOWED_MESSAGE })
        const result = cdpResult(
          await cdpCall<unknown>(
            client as CdpClient,
            "Runtime.evaluate",
            { expression, returnByValue: true, awaitPromise: false },
            tab.sessionId as string,
          ),
        )
        const exception = asRecord(result.exceptionDetails)
        if (exception) return toToolError({ errorCode: "INVALID_ARGS", error: "A expressão falhou na página." })
        const value = safeEvaluateValue(asRecord(result.result)?.value ?? null, kernel.redact)
        const text = JSON.stringify(value) ?? "null"
        return toToolSuccess({ content: [{ type: "text", text }], structured: value })
      },
    }) as Promise<ToolResult>
  }

  type SecretValues = Record<string, string>

  const tabOrigin = (tab: TabState): string => {
    try {
      return new URL(tab.info.url).origin
    } catch {
      return tab.info.url
    }
  }

  const freshSecretGuard = (
    tab: TabState,
    operationSignal: AbortSignal,
  ): { isCurrent: () => boolean; origin: string } => {
    const origin = tabOrigin(tab)
    const navigation = tab.navigationVersion
    return {
      origin,
      isCurrent: () =>
        !operationSignal.aborted &&
        tab.info.state === "live" &&
        tab.navigationVersion === navigation &&
        tabOrigin(tab) === origin,
    }
  }
  const secretReleaseGuards = new WeakMap<SecretValues, { isCurrent: () => boolean; origin: string }>()
  type PendingSecretRequest = {
    tabId: Id
    projectId: Id | null
    origin: string
    ctx: ToolContext
    resolve: (value: SecretValues | null) => void
  }
  const pendingSecretRequests = new Map<string, PendingSecretRequest>()

  const requestSecret = async ({
    tab,
    projectId,
    fieldKinds,
    ctx,
  }: {
    tab: TabState
    projectId: Id | null
    fieldKinds: Array<"username" | "password" | "otp">
    ctx: ToolContext
  }): Promise<SecretValues | null> => {
    const requestId = kernel.newId()
    const origin = (() => {
      try {
        return new URL(tab.info.url).origin
      } catch {
        return tab.info.url
      }
    })()
    kernel.publish({ type: "browser.secret_requested", requestId, tabId: tab.info.tabId, origin, fieldKinds })
    const routeResult = new Promise<SecretValues | null>((resolve) =>
      pendingSecretRequests.set(requestId, { tabId: tab.info.tabId, projectId, origin, ctx, resolve }),
    )
    const hostResult = kernel.callHost("secret.prompt", {
      requestId,
      title: "Inserir credencial no navegador",
      origin,
      fieldKinds,
    })
    try {
      const result = await Promise.race([
        routeResult,
        hostResult.then((value) => (value.success ? value.value.values : null)),
      ])
      return result
    } finally {
      pendingSecretRequests.delete(requestId)
    }
  }

  const savedBrowserSecret = async (
    tab: TabState,
    name: string,
    ctx: ToolContext,
    projectId: Id | null,
    extraCurrent = () => true,
  ) => {
    const origin = (() => {
      try {
        return new URL(tab.info.url).origin
      } catch {
        return "null"
      }
    })()
    const reference = store.secretReference({ name, projectId, origin })
    if (!reference || origin === "null") return null
    const bot = kernel.services.use("store.api")?.getBot({ botId: ctx.botId })
    const policy = JSON.stringify([bot?.machine, bot?.access, bot?.approvals, bot?.projectId])
    const navigation = tab.navigationVersion
    const current = () => {
      const latest = kernel.services.use("store.api")?.getBot({ botId: ctx.botId })
      return (
        !ctx.signal.aborted &&
        !!latest &&
        latest.access !== "read-only" &&
        latest.projectId === projectId &&
        JSON.stringify([latest.machine, latest.access, latest.approvals, latest.projectId]) === policy &&
        tab.info.ownerBotId === ctx.botId &&
        tab.info.state === "live" &&
        tab.navigationVersion === navigation &&
        (() => {
          try {
            return new URL(tab.info.url).origin === origin
          } catch {
            return false
          }
        })() &&
        JSON.stringify(store.secretReference({ name, projectId, origin })) === JSON.stringify(reference) &&
        extraCurrent()
      )
    }
    const allowed = await approveSecretRelease({
      kernel,
      ctx,
      secret: reference,
      destination: origin,
      toolName: "browser_submit_secret",
      isCurrent: current,
    })
    if (!allowed?.()) return null
    const result = await kernel.callHost("keychain.get", { account: reference.account })
    if (!allowed() || !result.success || result.value.value === null) return null
    kernel.addRedactionValue(result.value.value)
    return { value: result.value.value, isCurrent: allowed, origin }
  }

  const secretEntry = async ({
    tabId,
    secretName,
    cancel,
  }: {
    tabId: Id
    secretName?: string
    cancel: boolean
  }): Promise<boolean> => {
    const tab = store.find(tabId)
    if (!tab || tab.info.state === "closed") return false
    for (const [requestId, request] of pendingSecretRequests) {
      if (request.tabId !== tabId) continue
      if (cancel) {
        request.resolve(null)
        pendingSecretRequests.delete(requestId)
        return true
      }
      if (secretName) {
        let released = false
        const saved = await savedBrowserSecret(
          tab,
          secretName,
          request.ctx,
          request.projectId,
          () => released || pendingSecretRequests.get(requestId) === request,
        )
        if (!saved?.isCurrent()) return false
        const value = saved.value
        const values = { password: value, username: value, otp: value }
        secretReleaseGuards.set(values, saved)
        released = true
        request.resolve(values)
        pendingSecretRequests.delete(requestId)
        return true
      }
    }
    return false
  }

  const submitSecret = async ({
    tabId,
    botId,
    threadId,
    projectId,
    fields,
    secretName,
    submit,
    submitTarget,
    signal,
  }: {
    tabId: Id
    botId: Id
    threadId: Id
    projectId: Id | null
    fields: Array<{ kind: "username" | "password" | "otp"; target: BrowserTarget }>
    secretName?: string
    submit: "none" | "enter" | "click"
    submitTarget?: BrowserTarget
    signal: AbortSignal
  }): Promise<ToolResult> => {
    const owned = getTab({ tabId, botId })
    if (!owned.success) return toToolError(owned.failure)
    const tab = owned.value
    return runAction({
      tab,
      botId,
      tool: "browser_submit_secret",
      target: fields.map((field) => field.kind),
      args: { secretName: secretName === undefined ? null : "provided", submit },
      timeoutMs: 600000,
      signal,
      operation: async (operationSignal) => {
        if (!client || !tab.sessionId) return failure("ENGINE_UNAVAILABLE", "The tab is not attached to Chrome.")
        const ctx: ToolContext = {
          botId,
          threadId,
          projectId,
          runId: kernel.services.use("runtime.activeRun")?.({ threadId })?.id ?? null,
          cwd: "/workspace",
          signal: operationSignal,
        }
        let secret: string | null = null
        let release: Awaited<ReturnType<typeof savedBrowserSecret>> = null
        if (secretName) {
          release = await savedBrowserSecret(tab, secretName, ctx, projectId)
          if (!release) return failure("INVALID_ARGS", "A credencial não foi autorizada para este destino.")
          secret = release.value
        }
        let values: SecretValues | null = null
        const promptGuard = secret === null ? freshSecretGuard(tab, operationSignal) : null
        if (promptGuard && promptGuard.origin === "null")
          return failure("INVALID_ARGS", "A credencial só pode ser digitada em uma página com origem http ou https.")
        if (secret !== null) {
          values = {}
          for (const field of fields) values[field.kind] = secret
        }
        if (values === null)
          values = await requestSecret({ tab, projectId, fieldKinds: fields.map((field) => field.kind), ctx })
        if (values === null) return failure("INVALID_ARGS", "Secret entry was canceled or unavailable.")
        const guard = release ?? secretReleaseGuards.get(values) ?? promptGuard ?? undefined
        for (const value of Object.values(values)) kernel.addRedactionValue(value)
        tab.secretMode = true
        try {
          for (const [index, field] of fields.entries()) {
            const resolved = await resolveWithRetry(tab, field.target)
            if (!resolved.success) return resolved
            if (!resolved.node) return failure("TARGET_NOT_INTERACTABLE", "Secret fields must resolve to elements.")
            const fieldValue = values[field.kind] ?? values.password ?? Object.values(values)[0] ?? ""
            const fieldOrigin = await runtimeValue<string>(client, "location.origin", resolved.node.sessionId)
            if (operationSignal.aborted || (guard && (!guard.isCurrent() || fieldOrigin !== guard.origin)))
              return failure("INVALID_ARGS", "O destino ou a autorização da credencial mudou.")
            await focusNode(client, resolved.node)
            await dispatchKey({ tab, key: "a", code: "KeyA", modifiers: 4 })
            await dispatchKey({ tab, key: "Backspace", code: "Backspace" })
            const currentOrigin = guard
              ? await runtimeValue<string>(client, "location.origin", resolved.node.sessionId)
              : null
            if (operationSignal.aborted || (guard && (!guard.isCurrent() || currentOrigin !== guard.origin)))
              return failure("INVALID_ARGS", "A autorização da credencial mudou.")
            await cdpCall(client, "Input.insertText", { text: fieldValue }, resolved.node.sessionId)
            if (index < fields.length - 1) await sleep(10, signal)
          }
        } finally {
          for (const key of Object.keys(values)) values[key] = ""
          secret = ""
        }
        secret = ""
        if (operationSignal.aborted || (guard && !guard.isCurrent()))
          return failure("INVALID_ARGS", "A autorização da credencial mudou.")
        if (submit === "enter") await dispatchKey({ tab, key: "Enter", code: "Enter", text: "\r" })
        if (submit === "click") {
          if (!submitTarget) return failure("INVALID_ARGS", "submitTarget is required when submit=click.")
          const resolved = await resolveWithRetry(tab, submitTarget)
          if (!resolved.success) return resolved
          const hit = await hitPoint(tab, resolved)
          if (!hit.success) return hit
          if (operationSignal.aborted || (guard && !guard.isCurrent()))
            return failure("INVALID_ARGS", "A autorização da credencial mudou.")
          await dispatchClick({
            tab,
            point: hit.value,
            ...(hit.value.sessionId === undefined ? {} : { sessionId: hit.value.sessionId }),
            button: "left",
            clickCount: 1,
          })
        }
        return success(undefined)
      },
    })
  }

  const notifyBestEffort = async (input: { title: string; body: string; threadId: Id | null }): Promise<void> => {
    await raceBudget({ work: kernel.callHost("notify", input), ms: SIDE_EFFECT_BUDGET_MS }).catch(() => undefined)
  }

  const requestTakeover = async ({
    tabId,
    botId,
    reason,
    timeoutMs,
    signal,
  }: {
    tabId: Id
    botId: Id
    reason: string
    timeoutMs: number
    signal: AbortSignal
  }): Promise<ToolResult> => {
    const owned = getTab({ tabId, botId })
    if (!owned.success) return toToolError(owned.failure)
    const tab = owned.value
    return withTabQueue({
      tab,
      timeoutMs,
      signal,
      operation: async () => {
        tab.info.heldByUser = true
        tab.info.lastUsedAt = Date.now()
        store.save(tab)
        kernel.publish({ type: "browser.tab", tab: safePublicTabInfo(tab) })
        const emitNotice = kernel.services.use("notify.emit")
        if (emitNotice)
          emitNotice({
            kind: "takeover",
            botId,
            threadId: tab.info.ownerThreadId,
            title: "Browser takeover",
            body: `needs you in the browser: ${reason.slice(0, 300)}`,
          })
        else
          await notifyBestEffort({
            title: "Browser takeover",
            body: `${botId} needs you in the browser: ${kernel.redact(reason).slice(0, 300)}`,
            threadId: tab.info.ownerThreadId,
          })
        await raceBudget({ work: focusManagedChrome(), ms: SIDE_EFFECT_BUDGET_MS, signal }).catch(() => undefined)
        const released = await new Promise<"released" | "timeout" | "canceled">((resolve) => {
          const finish = (outcome: "released" | "timeout" | "canceled"): void => {
            clearTimeout(timer)
            signal.removeEventListener("abort", onAbort)
            resolve(outcome)
          }
          const onAbort = (): void => finish("canceled")
          const timer = setTimeout(() => finish("timeout"), timeoutMs)
          tab.takeover = { resolve: () => finish("released"), timer }
          if (signal.aborted) onAbort()
          else signal.addEventListener("abort", onAbort, { once: true })
        })
        tab.takeover = null
        if (released !== "released") {
          tab.info.heldByUser = false
          tab.generation += 1
          tab.refs.clear()
          tab.handbackNote =
            released === "timeout"
              ? "Take-over timed out; the current page may have changed."
              : "Take-over was canceled; the current page may have changed."
          store.save(tab)
          kernel.publish({ type: "browser.tab", tab: safePublicTabInfo(tab) })
        }
        const fresh = await makeSnapshot(tab, "auto", new AbortController().signal)
        if (!fresh.success) return toToolError(fresh.failure)
        return snapshotToolResult(fresh.value)
      },
    }) as Promise<ToolResult>
  }

  const releaseTakeover = async (tabId: Id): Promise<boolean> => {
    const tab = store.find(tabId)
    if (!tab) return false
    if (!tab.info.heldByUser) return true
    tab.info.heldByUser = false
    tab.generation += 1
    tab.refs.clear()
    tab.handbackNote = "User handed back the tab; the page may have changed."
    const resolver = tab.takeover?.resolve
    if (tab.takeover?.timer) clearTimeout(tab.takeover.timer)
    tab.takeover = null
    store.save(tab)
    kernel.publish({ type: "browser.tab", tab: safePublicTabInfo(tab) })
    resolver?.()
    return true
  }

  const holdTakeover = async ({ tabId, reason }: { tabId: Id; reason: string }): Promise<boolean> => {
    const tab = store.find(tabId)
    if (!tab || tab.info.state === "closed") return false
    tab.info.heldByUser = true
    tab.info.lastUsedAt = Date.now()
    store.save(tab)
    kernel.publish({ type: "browser.tab", tab: safePublicTabInfo(tab) })
    await notifyBestEffort({
      title: "Browser takeover",
      body: `The user took over the browser: ${kernel.redact(reason).slice(0, 300)}`,
      threadId: tab.info.ownerThreadId,
    })
    await raceBudget({ work: focusManagedChrome(), ms: SIDE_EFFECT_BUDGET_MS }).catch(() => undefined)
    return true
  }

  const getWindowBounds = async ({ tabId, botId }: { tabId: Id; botId: Id }): Promise<WindowBounds | null> => {
    if (windowConfig.headless) return null
    const owned = getTab({ tabId, botId, allowHeld: true })
    if (!owned.success) return null
    const live = await ensureTab(owned.value)
    if (!live.success || !client || !owned.value.targetId) return null
    let window: JsonObject
    try {
      window = cdpResult(await client.call<unknown>("Browser.getWindowForTarget", { targetId: owned.value.targetId }))
    } catch {
      return null
    }
    const bounds = asRecord(window.bounds)
    const left = asNumber(bounds?.left)
    const top = asNumber(bounds?.top)
    const width = asNumber(bounds?.width)
    const height = asNumber(bounds?.height)
    const windowState = asString(bounds?.windowState)
    if (left === null || top === null || width === null || height === null || windowState === null) return null
    return { left, top, width, height, windowState }
  }

  const tabsForBot: BrowserEngine["tabsForBot"] = (botId) => {
    unloadIdleTabs()
    return store.list(botId).map((tab) => publicTabInfo({ tab }))
  }

  const shutdown = async (): Promise<void> => {
    if (retired) return
    retired = true
    unhost()
    for (const tab of tabs) {
      if (tab.takeover?.timer) clearTimeout(tab.takeover.timer)
      tab.takeover?.resolve?.()
      tab.takeover = null
    }
    unsubscribeBotDeleted()
    if (sessionTimer) clearInterval(sessionTimer)
    sessionTimer = null
    if (contextOwners.size > 0)
      await raceBudget({ work: saveSessions(), ms: SESSION_SHUTDOWN_BUDGET_MS }).catch(() => undefined)
    if (localBrowser && client) {
      const current = client
      await raceBudget({
        work: Promise.all(
          tabs
            .filter((tab) => tab.info.ownerBotId && tab.targetId)
            .map(async (tab) => {
              await current.call("Target.closeTarget", { targetId: tab.targetId }).catch(() => undefined)
              tab.targetId = null
              tab.sessionId = null
              tab.info.state = "unloaded"
              store.save(tab)
            }),
        ),
        ms: SIDE_EFFECT_BUDGET_MS,
      }).catch(() => undefined)
    }
    markEngineUnavailable()
    await launcher.stop()
  }

  const unsubscribeBotDeleted = kernel.subscribe(({ event }) => {
    if (event.type === "bot.deleted") void disposeBotContext(event.botId)
    if (event.type === "bot.updated" && (localBrowser ? event.bot.browser !== "local" : event.bot.browser !== "touri"))
      void disposeBotContext(event.bot.id)
  })

  const unhost = kernel.onHostNotification((notification) => {
    if (notification.method === "app.willQuit") void shutdown()
  })

  return {
    preview: async ({ botId, tabId, signal }) => {
      // Use only an already attached tab. Never launch Chrome, reload a tab,
      // change focus, refresh refs or enqueue behind the bot's running action.
      if (!client || signal.aborted) return null
      const tab = tabs
        .filter((tab) => tab.info.ownerBotId === botId && (!tabId || tab.info.tabId === tabId))
        .sort((a, b) => b.info.lastUsedAt - a.info.lastUsedAt)[0]
      if (tab?.info.state !== "live" || !tab.sessionId || tab.secretMode) return null
      const data = await imageData({ client, tab, fullPage: false, quality: 30 })
      if (signal.aborted || tab.secretMode || tab.info.state !== "live" || data.length > 1_500_000) return null
      return {
        title: kernel.redact(tab.info.title),
        url: kernel.redact(tab.info.url),
        image: `data:image/jpeg;base64,${data}`,
      }
    },
    open,
    list,
    close,
    snapshot,
    screenshot,
    navigate,
    click,
    type,
    press,
    hover,
    scroll,
    selectOption,
    setChecked,
    waitFor,
    evaluate,
    requestTakeover,
    submitSecret,
    secretEntry,
    releaseTakeover,
    holdTakeover,
    getWindowBounds,
    tabsForBot,
    shutdown,
  }
}
