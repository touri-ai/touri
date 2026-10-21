import { constants } from "node:fs"
import { access } from "node:fs/promises"
import type { DoctorCheck } from "@touri/contracts"
import { systemChrome } from "../platform/macos/chrome"
import { check } from "./check"

export const getBrowserExecutableCheck = async ({
  platform,
  path,
  executable,
  which,
  signal,
  canExecute = async (file) =>
    access(file, constants.X_OK).then(
      () => true,
      () => false,
    ),
}: {
  platform: string
  path: string
  executable?: string | undefined
  which: (name: string, path: string) => string | null
  signal: AbortSignal
  canExecute?: (file: string) => Promise<boolean>
}): Promise<DoctorCheck> => {
  signal.throwIfAborted()
  const candidate =
    executable ??
    (platform === "darwin"
      ? systemChrome
      : ["chromium", "chromium-browser", "google-chrome", "chrome"].map((name) => which(name, path)).find(Boolean))
  const available = Boolean(candidate && (await canExecute(candidate)))
  signal.throwIfAborted()

  return check(
    "browser-executable",
    "Navegador do bot",
    available ? "pass" : "warn",
    available
      ? "Navegador instalado. A conexão e a página serão verificadas ao abrir o navegador."
      : "Nenhum navegador executável foi encontrado. Instale um navegador compatível no computador do bot e verifique novamente.",
  )
}
