import { type Locale, t } from "./i18n"

const attachmentErrors = [
  "Não foi possível ler o anexo. Anexe o arquivo de novo.",
  "Este anexo não pode ser lido. Use texto UTF-8 (TXT, Markdown, JSON, CSV, TSV ou LOG), até 256 KiB no total e no máximo 10 documentos.",
] as const

export const getAttachmentError = (text: string, locale?: Locale): string | undefined => {
  const message = attachmentErrors.find((message) => text.includes(message))
  return message ? t(message, {}, locale) : undefined
}
