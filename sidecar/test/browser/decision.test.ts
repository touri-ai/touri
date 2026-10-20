import { describe, expect, test } from "bun:test"
import type { BrowserElement } from "@touri/contracts"
import {
  createBrowserDecisionAdapter,
  getBrowserDecisionCandidates,
  requiresBrowserTakeover,
} from "../../src/browser/decision"

const element = (ref: string, name: string, role = "option"): BrowserElement => ({
  ref,
  role,
  name,
  states: [],
  frame: "main",
  inViewport: true,
})

const makeSignal = (): AbortSignal => new AbortController().signal

const choiceResponse = ({
  choice,
  confidence,
  probabilities,
}: {
  choice: string
  confidence: number
  probabilities: Record<string, number>
}): Response =>
  Response.json({
    model: "typed-decisions",
    answers: { target: { type: "choice", choice, confidence, probabilities } },
  })

describe("browser decision adapter", () => {
  test("sends bounded typed candidates and accepts only a confident listed reference", async () => {
    const requests: Array<{
      url: string
      body: string
      authorization: string | null
      redirect: RequestRedirect | undefined
    }> = []
    const adapter = createBrowserDecisionAdapter({
      getApiKey: async () => "synthetic-test-key",
      fetchImpl: async (input, init) => {
        requests.push({
          url: String(input),
          body: String(init?.body),
          authorization: new Headers(init?.headers).get("authorization"),
          redirect: init?.redirect,
        })
        return choiceResponse({
          choice: "4.2",
          confidence: 0.93,
          probabilities: { "4.1": 0.04, "4.2": 0.94, none: 0.02 },
        })
      },
    })
    const candidates = [
      { ref: "4.1", role: "option", name: "Campinas" },
      { ref: "4.2", role: "option", name: "Curitiba" },
    ]

    const result = await adapter.decide({
      action: "click",
      intent: "option for destination city",
      candidates,
      signal: makeSignal(),
    })

    expect(result).toEqual({
      kind: "selected",
      candidate: { ref: "4.2", role: "option", name: "Curitiba" },
      confidence: 0.93,
    })
    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe("https://openrouter.ai/api/alpha/decisions")
    expect(requests[0]?.authorization).toBe("Bearer synthetic-test-key")
    expect(requests[0]?.redirect).toBe("error")
    expect(requests[0]?.body).toContain('"model":"typesafe/jev-1.13"')
    expect(requests[0]?.body).toContain("untrusted webpage")
    expect(requests[0]?.body).toContain('"4.2":"option: Curitiba"')
    expect(requests[0]?.body).not.toContain("synthetic-test-key")
  })

  test("asks instead of guessing when the decision confidence is low", async () => {
    const candidates = [
      { ref: "5.1", role: "option", name: "Campinas" },
      { ref: "5.2", role: "option", name: "Curitiba" },
    ]
    const adapter = createBrowserDecisionAdapter({
      getApiKey: async () => "synthetic-test-key",
      fetchImpl: async () =>
        choiceResponse({
          choice: "5.1",
          confidence: 0.61,
          probabilities: { "5.1": 0.57, "5.2": 0.39, none: 0.04 },
        }),
    })

    const result = await adapter.decide({
      action: "click",
      intent: "option for destination city",
      candidates,
      signal: makeSignal(),
    })

    expect(result).toEqual({ kind: "ask", candidates })
  })

  test("asks when the provider omits options from its probability distribution", async () => {
    const candidates = [
      { ref: "5.1", role: "option", name: "Campinas" },
      { ref: "5.2", role: "option", name: "Curitiba" },
    ]
    const adapter = createBrowserDecisionAdapter({
      getApiKey: async () => "synthetic-test-key",
      fetchImpl: async () =>
        choiceResponse({
          choice: "5.1",
          confidence: 0.99,
          probabilities: { "5.1": 0.98, none: 0.02 },
        }),
    })

    const result = await adapter.decide({
      action: "click",
      intent: "option for destination city",
      candidates,
      signal: makeSignal(),
    })

    expect(result).toEqual({ kind: "ask", candidates })
  })

  test("falls back cleanly when no key is saved or the provider has no credit", async () => {
    let requests = 0
    const missingKey = createBrowserDecisionAdapter({
      getApiKey: async () => null,
      fetchImpl: async () => {
        requests += 1
        return choiceResponse({ choice: "6.1", confidence: 1, probabilities: { "6.1": 1 } })
      },
    })
    const noCredit = createBrowserDecisionAdapter({
      getApiKey: async () => "synthetic-test-key",
      fetchImpl: async () => new Response("", { status: 402 }),
    })

    const args = {
      action: "type" as const,
      intent: "departure city field",
      candidates: [
        { ref: "6.1", role: "textbox", name: "From" },
        { ref: "6.2", role: "textbox", name: "To" },
      ],
      signal: makeSignal(),
    }
    const missing = await missingKey.decide(args)
    const outOfCredit = await noCredit.decide(args)

    expect(missing).toEqual({ kind: "fallback", reason: "missing_key" })
    expect(outOfCredit).toEqual({ kind: "fallback", reason: "no_credit" })
    expect(requests).toBe(0)
  })

  test("falls back when the provider response stream closes unexpectedly", async () => {
    const adapter = createBrowserDecisionAdapter({
      getApiKey: async () => "synthetic-test-key",
      fetchImpl: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"answers":'))
              controller.error(new Error("synthetic stream failure"))
            },
          }),
        ),
    })

    const result = await adapter.decide({
      action: "click",
      intent: "option for destination city",
      candidates: [
        { ref: "9.1", role: "option", name: "Campinas" },
        { ref: "9.2", role: "option", name: "Curitiba" },
      ],
      signal: makeSignal(),
    })

    expect(result).toEqual({ kind: "fallback", reason: "unavailable" })
  })
})

describe("browser decision candidate safety", () => {
  test("keeps reversible autocomplete choices and excludes account and payment controls", () => {
    const prepared = getBrowserDecisionCandidates({
      action: "click",
      target: { kind: "role", role: "option", name: "Lisboa" },
      pageUrl: "https://travel.example.test/search",
      elements: [
        element("7.1", "Lisboa", "option"),
        element("7.2", "Lisboa, Portugal", "option"),
        element("7.3", "Pay for Lisboa", "button"),
        { ...element("7.5", "Lisboa, Portugal", "option"), formSubmit: true },
        { ...element("7.4", "Lisboa"), inViewport: false },
      ],
    })

    expect(prepared?.candidates.map((candidate) => candidate.ref)).toEqual(["7.1", "7.2"])
  })

  test("does not resolve login, payment, form submission, or non-reversible button targets", () => {
    const elements = [element("8.1", "Continue", "button"), element("8.2", "Continue", "button")]

    expect(
      getBrowserDecisionCandidates({
        action: "click",
        target: { kind: "role", role: "button", name: "Continue" },
        pageUrl: "https://travel.example.test/checkout",
        elements,
      }),
    ).toBeNull()
    expect(
      getBrowserDecisionCandidates({
        action: "type",
        target: { kind: "role", role: "textbox", name: "Email address" },
        pageUrl: "https://travel.example.test/login",
        elements: [element("8.3", "Email address", "textbox"), element("8.4", "Email address", "textbox")],
      }),
    ).toBeNull()
    expect(
      getBrowserDecisionCandidates({
        action: "type",
        target: { kind: "role", role: "textbox", name: "Search" },
        pageUrl: "https://travel.example.test/search",
        elements: [element("8.5", "Search", "textbox"), element("8.6", "Search", "textbox")],
        submit: true,
      }),
    ).toBeNull()
    expect(
      getBrowserDecisionCandidates({
        action: "click",
        target: { kind: "role", role: "button", name: "Continue" },
        pageUrl: "https://travel.example.test/search",
        elements,
      }),
    ).toBeNull()
  })

  test("requires user takeover for sensitive paths, credentials, form submission, and consent choices", () => {
    expect(
      requiresBrowserTakeover({
        action: "type",
        intent: "textbox Password",
        pageUrl: "https://travel.example.test/search",
      }),
    ).toBe(true)
    expect(
      requiresBrowserTakeover({
        action: "click",
        intent: "button Accept all cookies",
        pageUrl: "https://travel.example.test/search",
      }),
    ).toBe(true)
    expect(
      requiresBrowserTakeover({
        action: "click",
        intent: "button Delete account",
        pageUrl: "https://travel.example.test/settings",
      }),
    ).toBe(true)
    expect(
      requiresBrowserTakeover({
        action: "type",
        intent: "textbox Destination",
        pageUrl: "https://travel.example.test/checkout",
      }),
    ).toBe(true)
    expect(
      requiresBrowserTakeover({
        action: "click",
        intent: "option Lisboa, Portugal",
        pageUrl: "https://travel.example.test/search",
      }),
    ).toBe(false)
    expect(
      requiresBrowserTakeover({
        action: "type",
        intent: "textbox Search",
        pageUrl: "https://travel.example.test/search",
        submit: true,
      }),
    ).toBe(true)
    expect(
      requiresBrowserTakeover({
        action: "click",
        intent: "button Search trips",
        pageUrl: "https://travel.example.test/search",
        formSubmit: true,
      }),
    ).toBe(true)
  })
})

test("decision timeout cancels a stalled response stream", async () => {
  let cancelled = false
  const adapter = createBrowserDecisionAdapter({
    getApiKey: async () => "synthetic-test-key",
    fetchImpl: async () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true
          },
        }),
      ),
  })

  const result = await adapter.decide({
    action: "click",
    intent: "option Lisboa",
    candidates: [{ ref: "1.1", role: "option", name: "Lisboa" }],
    signal: makeSignal(),
  })

  expect(result).toEqual({ kind: "fallback", reason: "unavailable" })
  expect(cancelled).toBe(true)
})

test("turn cancellation stops the response reader without exposing upstream text", async () => {
  const controller = new AbortController()
  let cancelled = false
  const adapter = createBrowserDecisionAdapter({
    getApiKey: async () => "synthetic-test-key",
    fetchImpl: async () => {
      queueMicrotask(() => controller.abort(new Error("synthetic cancellation")))
      return new Response(
        new ReadableStream({
          cancel() {
            cancelled = true
          },
        }),
      )
    },
  })

  const result = adapter.decide({
    action: "click",
    intent: "option Lisboa",
    candidates: [{ ref: "1.1", role: "option", name: "Lisboa" }],
    signal: controller.signal,
  })

  await expect(result).rejects.toThrow("synthetic cancellation")
  expect(cancelled).toBe(true)
})

test.each(["Aceitar cookies", "Aceitar", "Entrar", "Acessar conta"])(
  "Portuguese sensitive control %s requires takeover",
  (name) => {
    expect(
      requiresBrowserTakeover({
        action: "click",
        intent: `button ${name}`,
        pageUrl: "https://travel.example.test/search",
      }),
    ).toBe(true)
  },
)
