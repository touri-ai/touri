import { createElement, lazy, type ReactElement, Suspense } from "react"

import App, { type UiKernel } from "./App"
import { isJoinPath } from "./features/people/join"
import { t } from "./i18n"

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

export const init = (kernel: UiKernel = {}, location: Location = window.location): ReactElement =>
  isJoinPath(location.pathname) ? getJoinPage(location) : createElement(App, { kernel })
