import { expect, test } from "bun:test"
import { getServerCandidates, probeServer } from "../../src/onboarding/discovery"

const signal = () => new AbortController().signal

test("enumerates only valid online private-network names and caps the candidate list", async () => {
  const result = await getServerCandidates({
    localUrl: "http://127.0.0.1:18842",
    signal: signal(),
    run: async () => ({
      code: 0,
      stderr: "",
      stdout: JSON.stringify({
        BackendState: "Running",
        Self: { DNSName: "local.example.ts.net." },
        Peer: {
          offline: { DNSName: "offline.example.ts.net", Online: false },
          invalid: { DNSName: "metadata.internal" },
          injection: { DNSName: "--help.example.ts.net/path" },
          ...Object.fromEntries(
            Array.from({ length: 80 }, (_, index) => [
              index,
              { DNSName: `peer-${index}.example.ts.net.`, Online: true },
            ]),
          ),
        },
      }),
    }),
  })

  expect(result.tailscale).toBe("ready")
  expect(result.servers).toHaveLength(33)
  expect(result.servers[0]?.url).toBe("http://127.0.0.1:18842")
  expect(
    result.servers
      .filter((server) => server.source === "tailnet")
      .every((server) => server.url.endsWith(".ts.net:8445")),
  ).toBe(true)
  expect(result.servers.some((server) => server.name.includes("offline"))).toBe(false)
})

test.each([
  [127, "", "missing"],
  [1, "", "unavailable"],
  [0, '{"BackendState":"NeedsLogin"}', "signed-out"],
  [0, "broken", "unavailable"],
] as const)("keeps local discovery when the private network is %s", async (code, stdout, state) => {
  const result = await getServerCandidates({
    localUrl: "http://127.0.0.1:18842",
    signal: signal(),
    run: async () => ({ code, stdout, stderr: "" }),
  })

  expect(result.tailscale).toBe(state)
  expect(result.servers).toHaveLength(1)
})

test("recognizes existing pairing pages without credentials or redirect following", async () => {
  const calls: Array<{ url: string; input: RequestInit | undefined }> = []
  const request: typeof fetch = Object.assign(
    async (input: string | URL | Request, options?: RequestInit) => {
      calls.push({ url: String(input), input: options })
      return new Response('<title>Entrar no touri</title><form id="pair-form"></form>', {
        headers: { "Content-Type": "text/html" },
      })
    },
    { preconnect: fetch.preconnect },
  )

  const found = await probeServer("https://studio.example.ts.net:8445", signal(), request)

  expect(found).toBe(true)
  expect(calls[0]?.url).toBe("https://studio.example.ts.net:8445/pair")
  expect(calls[0]?.input).toMatchObject({ redirect: "error", credentials: "omit" })
  expect(calls[0]?.input?.signal).toBeInstanceOf(AbortSignal)
})

test("ignores another service returning a generic successful JSON health response", async () => {
  const request: typeof fetch = Object.assign(async () => Response.json({ ok: true }), { preconnect: fetch.preconnect })

  expect(await probeServer("https://studio.example.ts.net:8445", signal(), request)).toBe(false)
})

test("cancels oversized pairing pages before accepting a peer", async () => {
  const request: typeof fetch = Object.assign(
    async () => new Response("x".repeat(16_385), { headers: { "Content-Type": "text/html" } }),
    { preconnect: fetch.preconnect },
  )

  expect(await probeServer("https://studio.example.ts.net:8445", signal(), request)).toBe(false)
})
