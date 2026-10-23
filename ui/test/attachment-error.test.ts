import { expect, test } from "vitest"
import { getAttachmentError } from "../src/attachmentError"
import { errorRecovery } from "../src/errorRecovery"

const unavailable = "Não foi possível ler o anexo. Anexe o arquivo de novo."
const unsupported =
  "Este anexo não pode ser lido. Use texto UTF-8 (TXT, Markdown, JSON, CSV, TSV ou LOG), até 256 KiB no total e no máximo 10 documentos."

test.each([unavailable, unsupported])(
  "attachment guidance stays actionable in Portuguese and English: %s",
  (message) => {
    const portuguese = errorRecovery(message, { errorClass: "tool_error", locale: "pt-BR" })
    const english = errorRecovery(message, { errorClass: "tool_error", locale: "en" })

    expect(portuguese.message).toBe(message)
    expect(english.message).toBe(getAttachmentError(message, "en"))
    expect(english.message).not.toBe(message)
    expect(english.actions).toEqual([])
    expect(english.classified).toBe(true)
  },
)
