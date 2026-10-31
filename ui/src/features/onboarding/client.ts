import type { ApiRoutes } from "@touri/contracts"
import { resolveSidecarEndpoint, type TauriInvoke } from "../../api/client"

type OnboardingRoute = Extract<keyof ApiRoutes, `${string} /onboarding${string}` | "GET /bots">
export type OnboardingRequest = <K extends OnboardingRoute>(
  route: K,
  input: ApiRoutes[K]["req"],
  signal?: AbortSignal,
) => Promise<ApiRoutes[K]["res"]>

export class OnboardingUnsupportedError extends Error {}

type FetchRequest = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export const createOnboardingRequest =
  (invoke: TauriInvoke, fetchRequest: FetchRequest = fetch): OnboardingRequest =>
  async (route, input, signal) => {
    const endpoint = await resolveSidecarEndpoint(invoke)
    const [method, path] = route.split(" ")
    const response = await fetchRequest(`${endpoint.baseUrl}/api/v1${path}`, {
      method: method ?? "GET",
      headers: { Authorization: `Bearer ${endpoint.token}`, "Content-Type": "application/json" },
      ...(method === "POST" ? { body: JSON.stringify(input) } : {}),
      signal: AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(20_000)]),
      redirect: "error",
    })
    if (response.status === 404 && route === "GET /onboarding") throw new OnboardingUnsupportedError()
    if (!response.ok) throw new Error("ONBOARDING_REQUEST_FAILED")
    return response.json()
  }

const COMPLETED_KEY = "touri.onboarding.completed.v1"

export const hasCompletedOnboarding = (storage?: Storage): boolean => {
  try {
    const destination = storage ?? window.localStorage
    return destination.getItem(COMPLETED_KEY) === "true" || destination.getItem("touri.workspace.v1") !== null
  } catch {
    return false
  }
}

export const completeOnboarding = (storage?: Storage) => {
  try {
    const destination = storage ?? window.localStorage
    destination.setItem(COMPLETED_KEY, "true")
  } catch {
    // The server also persists completion when browser storage is disabled.
  }
}

const RESUME_KEY = "touri.onboarding.resume.v1"

export const getResumingLocalSetup = (): boolean => {
  try {
    return localStorage.getItem(RESUME_KEY) === "here"
  } catch {
    return false
  }
}

export const scheduleLocalSetup = () => localStorage.setItem(RESUME_KEY, "here")
export const clearLocalSetup = () => {
  try {
    localStorage.removeItem(RESUME_KEY)
  } catch {
    /* Completion is also persisted in the local data directory. */
  }
}
