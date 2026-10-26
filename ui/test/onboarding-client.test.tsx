import { cleanup, render, waitFor } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import type { TauriInvoke } from "../src/api/client"
import {
  createOnboardingRequest,
  type OnboardingRequest,
  OnboardingUnsupportedError,
} from "../src/features/onboarding/client"
import { Onboarding } from "../src/features/onboarding/Onboarding"

afterEach(cleanup)

const getInvoke = (): TauriInvoke =>
  vi.fn(async () => ({
    baseUrl: "http://localhost:18841",
    wsUrl: "ws://localhost:18841",
    token: "synthetic-token",
  })) as TauriInvoke

const getRequest = (status: number): OnboardingRequest =>
  createOnboardingRequest(getInvoke(), async () => new Response("{}", { status }))

it("opens the existing workspace when the runtime has no onboarding route without completing first run", async () => {
  const complete = vi.fn()
  const unsupported = vi.fn()
  render(
    <Onboarding request={getRequest(404)} invoke={getInvoke()} onComplete={complete} onUnsupported={unsupported} />,
  )

  await waitFor(() => expect(unsupported).toHaveBeenCalledOnce())

  expect(complete).not.toHaveBeenCalled()
})

it("keeps explicitly reopened server setup available when optional routes are missing", async () => {
  const fetchRequest = vi.fn(async () => new Response("{}", { status: 404 }))
  const request = createOnboardingRequest(getInvoke(), fetchRequest)
  const unsupported = vi.fn()
  render(
    <Onboarding
      request={request}
      invoke={getInvoke()}
      onComplete={vi.fn()}
      onUnsupported={unsupported}
      initialStep="choose"
      revisiting
    />,
  )

  await waitFor(() => expect(fetchRequest).toHaveBeenCalledOnce())

  expect(unsupported).not.toHaveBeenCalled()
})

it.each([401, 403, 500, 503])("does not treat a %i response as missing onboarding support", async (status) => {
  const request = getRequest(status)

  const result = request("GET /onboarding", {})

  await expect(result).rejects.toThrow("ONBOARDING_REQUEST_FAILED")
  await expect(result).rejects.not.toBeInstanceOf(OnboardingUnsupportedError)
})

it("does not dismiss first run when an onboarding action returns 404", async () => {
  const request = getRequest(404)

  const result = request("POST /onboarding", { remote: false })

  await expect(result).rejects.toThrow("ONBOARDING_REQUEST_FAILED")
  await expect(result).rejects.not.toBeInstanceOf(OnboardingUnsupportedError)
})
