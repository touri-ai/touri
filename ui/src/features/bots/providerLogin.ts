import type { Bot } from "@touri/contracts"
import type { UiApi } from "../../api/client"
import { ApiError } from "../../errors"

export const retryProviderLogin = async <T>(
  request: () => Promise<T>,
  active: () => boolean = () => true,
): Promise<T> => {
  const delays = [250, 750]
  for (let attempt = 0; ; attempt++) {
    try {
      return await request()
    } catch (error) {
      const delay = delays[attempt]
      if (!(error instanceof ApiError) || !error.retryable || delay === undefined || !active()) throw error
      await new Promise((resolve) => setTimeout(resolve, delay))
      if (!active()) throw error
    }
  }
}

export const adoptProviderLogin = async (api: UiApi, bot: Bot, draftId: string): Promise<void> => {
  try {
    const flow = await retryProviderLogin(() =>
      api.request(
        "POST /bots/:id/provider-login/flow",
        { provider: bot.provider, action: "adopt", draftId },
        { id: bot.id },
      ),
    )
    if (flow.state === "ready" && flow.executable !== "missing") return
  } catch {
    // The login may have been saved even if its response was lost.
  }
  const flow = await retryProviderLogin(() =>
    api.request("GET /bots/:id/provider-login/flow", { provider: bot.provider }, { id: bot.id }),
  )
  if (flow.state === "ready" && flow.executable !== "missing") return
  if (flow.state === "host-available" && flow.executable !== "missing") {
    const connected = await retryProviderLogin(() =>
      api.request("POST /bots/:id/provider-login/flow", { provider: bot.provider, action: "use-host" }, { id: bot.id }),
    )
    if (connected.state === "ready" && connected.executable !== "missing") return
  }
  throw new Error("Login unavailable")
}
