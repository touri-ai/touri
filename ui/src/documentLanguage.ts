import type { Locale } from "./i18n"

export const getDocumentLocale = (documentElement: Pick<HTMLElement, "lang">): Locale =>
  documentElement.lang === "en" ? "en" : "pt-BR"

export const setDocumentLanguage = (locale: Locale, documentElement: HTMLElement): void => {
  documentElement.lang = locale
}
