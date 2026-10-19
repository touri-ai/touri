import type { Locale } from "./i18n"

export const setDocumentLanguage = (locale: Locale, documentElement: HTMLElement): void => {
  documentElement.lang = locale
}
