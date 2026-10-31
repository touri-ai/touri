import { test as base } from "@playwright/test"
import { createGuideStaticServer } from "./onboarding-guide-static"

/** Reuse the production entries compiled once by global setup, with an isolated loopback listener. */
export const test = base.extend<object, { productionBaseURL: string }>({
  productionBaseURL: [
    // biome-ignore lint/correctness/noEmptyPattern: fixture dependencies are declared by destructuring.
    async ({}, use) => {
      const server = await createGuideStaticServer()

      await use(server.url)

      await server.dispose()
    },
    { scope: "worker" },
  ],
  baseURL: async ({ productionBaseURL }, use) => use(productionBaseURL),
})
