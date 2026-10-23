import { getGroupValidationError } from "@touri/contracts"
import { expect, test } from "vitest"
import { ApiError } from "../src/errors"
import { t } from "../src/i18n"

test("group API validation retains the field and has matching Portuguese and English copy", () => {
  for (const field of ["body", "name", "color", "avatarShape", "memberIds", "coordinatorBotId", "title"]) {
    const validation = getGroupValidationError(field)
    if (!validation) throw new Error("Missing validation message")

    const error = new ApiError(400, "private-value", "INVALID_ARGS", "TOURI-E1001", undefined, field)

    expect(error.message).toContain(validation.error)
    expect(error.message).not.toContain("private-value")
    expect(t(validation.error)).toBe(validation.errorMessages["pt-BR"])
    expect(t(validation.error, {}, "en")).toBe(validation.errorMessages.en)
  }
})

test("unrecognized fields cannot replace registered public errors", () => {
  const error = new ApiError(400, "private-value", "INVALID_ARGS", "TOURI-E1001", undefined, "private-value")

  expect(error.message).toBe("Confira os dados informados e tente novamente. [TOURI-E1001]")
})
