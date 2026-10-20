import { expect, it } from "vitest"
import { errorRecovery } from "../src/errorRecovery"

it.each([
  ["pt-BR", "O nome do modelo salvo é inválido. Escolha outro modelo nas configurações do bot."],
  ["en", "The saved model name is invalid. Choose another model in the bot settings."],
] as const)("explains rejected stored models in %s", (locale, message) => {
  const error = "The saved model name is invalid. Choose another model in the bot settings."

  const recovery = errorRecovery(error, { errorClass: "unknown", locale })

  expect(recovery.message).toBe(message)
  expect(recovery.classified).toBe(true)
  expect(recovery.actions).toEqual([])
})
