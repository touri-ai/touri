import { createRoot } from "react-dom/client"
import type { TauriInvoke } from "../../src/api/client"
import { createOnboardingRequest } from "../../src/features/onboarding/client"
import { Onboarding } from "../../src/features/onboarding/Onboarding"
import "../../src/styles.css"

const endpoint = {
  baseUrl: location.origin,
  wsUrl: `${location.origin.replace("http", "ws")}/api/v1/events`,
  token: "synthetic-test-token",
}
const invoke = (async () => endpoint) as TauriInvoke
createRoot(document.getElementById("root") as HTMLElement).render(
  <Onboarding request={createOnboardingRequest(invoke)} invoke={invoke} onComplete={() => undefined} />,
)
