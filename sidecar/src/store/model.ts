import type { Result } from "@touri/contracts"

export const getSavedBotModel = (value: unknown): Result<{ model: string | null }, "unknown"> => {
  const model = getBotModel(value ?? null)
  if (model === undefined) return { success: false, errorCode: "unknown", error: INVALID_SAVED_MODEL_ERROR }

  return { success: true, model }
}

export const getBotModel = (value: unknown): string | null | undefined => {
  if (value === null) return null
  if (typeof value !== "string" || value.length > 256) return undefined
  if (HIDDEN_CHARACTERS.test(value)) return undefined

  const model = value.trim()
  if (model.startsWith("-")) return undefined

  return model || null
}

export const MODEL_VALIDATION_ERROR =
  "Use a model name of up to 256 characters, without hidden or control characters or a leading dash."

export const INVALID_SAVED_MODEL_ERROR = "The saved model name is invalid. Choose another model in the bot settings."

const HIDDEN_CHARACTERS = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u
