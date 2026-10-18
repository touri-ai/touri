import { afterAll, expect, test } from "bun:test"
import { startBrowserFixtureServer } from "./fixture-server"

const server = startBrowserFixtureServer()

afterAll(() => server.stop(true))

test("R5 overflow fixture contains 1000 buttons for the 200-element snapshot cap", async () => {
  const response = await fetch(new URL("/large", server.url))
  const html = await response.text()

  expect(response.status).toBe(200)
  expect(Array.from(html.matchAll(/<button>/g))).toHaveLength(1000)
})
