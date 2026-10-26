import { createElement, lazy, type ReactElement, Suspense } from "react"

import type { UiKernel } from "./App"
import { OnboardingBoundary } from "./features/onboarding/Onboarding"
import { isJoinPath } from "./features/people/join"
import { t } from "./i18n"

const App = lazy(() => import("./App"))
const JoinPage = lazy(() => import("./features/people/JoinPage").then((module) => ({ default: module.JoinPage })))

const getJoinPage = (location: Pick<Location, "hash" | "replace">): ReactElement =>
  createElement(
    Suspense,
    {
      fallback: createElement(
        "main",
        { className: "workspace-page", "aria-busy": true },
        createElement("p", { role: "status" }, t("Loading")),
      ),
    },
    createElement(JoinPage, { hash: location.hash, onJoined: () => location.replace("/") }),
  )

export const init = (kernel: UiKernel = {}, location: Location = window.location): ReactElement => {
  if (isJoinPath(location.pathname)) return getJoinPage(location)
  const content = createElement(
    Suspense,
    {
      fallback: createElement("main", { className: "setup-screen", "aria-busy": true }, t("Loading")),
    },
    createElement(App, { kernel }),
  )
  return createElement(OnboardingBoundary, { invoke: kernel.services?.invoke ?? undefined }, content)
}
