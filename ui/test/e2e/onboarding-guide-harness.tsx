import { lazy, Suspense, useState } from "react"
import { createRoot } from "react-dom/client"
import { createApiClient, type TauriInvoke } from "../../src/api/client"
import { installMotionTokens } from "../../src/design/spring"
import { createOnboardingRequest } from "../../src/features/onboarding/client"
import { Onboarding } from "../../src/features/onboarding/Onboarding"
import { t } from "../../src/i18n"
import "../../src/styles.css"

const App = lazy(() => import("../../src/App"))

const endpoint = {
  baseUrl: location.origin,
  wsUrl: `${location.origin.replace("http", "ws")}/api/v1/events`,
  token: "synthetic-test-token",
}
const api = createApiClient({ endpoint })
const invoke = (async (command: string) => {
  if (command === "sidecar_endpoint") return endpoint
  if (command === "server_mode_status") return { mode: "local", url: null }
  return null
}) as TauriInvoke
const request = createOnboardingRequest(invoke)
installMotionTokens(document.documentElement)
const Harness = () => {
  const [complete, setComplete] = useState(false)
  if (complete)
    return (
      <Suspense fallback={<p role="status">{t("Loading")}</p>}>
        <App kernel={{ services: { api, invoke } }} />
      </Suspense>
    )
  return <Onboarding request={request} invoke={invoke} onComplete={() => setComplete(true)} />
}
createRoot(document.getElementById("root") as HTMLElement).render(<Harness />)
