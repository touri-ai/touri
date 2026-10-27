import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { installMotionTokens } from "./design/spring"
import { initializeTheme } from "./design/theme"
import { setDocumentLanguage } from "./documentLanguage"
import { DEFAULT_LOCALE } from "./i18n"
import { init } from "./index"
import { installBrowserLazyAssetRecovery } from "./lazyAssetRecovery"
import "./styles.css"

installBrowserLazyAssetRecovery()

installMotionTokens(document.documentElement)
initializeTheme()
setDocumentLanguage(DEFAULT_LOCALE, document.documentElement)

createRoot(document.getElementById("root") as HTMLElement).render(<StrictMode>{init()}</StrictMode>)
