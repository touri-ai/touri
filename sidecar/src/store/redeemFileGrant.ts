import { basename } from "node:path"
import type { Kernel } from "@touri/contracts"
import { deviceSession } from "../kernel/device-session"
import { MAX_ATTACHMENT_BYTES } from "../kernel/files"
import { readGrantedFileAsync } from "../kernel/readGrantedFile"

export type RedeemFileGrantArgs = { kernel: Pick<Kernel, "callHost">; grantId: unknown; signal: AbortSignal }
export type RedeemFileGrantSuccess = { success: true; name: string; content: Buffer }
export type RedeemFileGrantError = { success: false; status: number; errorCode: string; error: string }
export type RedeemFileGrantResult = RedeemFileGrantSuccess | RedeemFileGrantError

const GRANT_ID = /^[a-f0-9]{64}$/
const refused = (status: number, errorCode: string, error: string): RedeemFileGrantError => ({
  success: false,
  status,
  errorCode,
  error,
})

/** Exchanges a shell-issued single-use drop grant for file bytes. Never trusts a path from the caller. */
export const redeemFileGrant = async ({
  kernel,
  grantId,
  signal,
}: RedeemFileGrantArgs): Promise<RedeemFileGrantResult> => {
  if (deviceSession(signal))
    return refused(403, "FILE_GRANT_REQUIRED", "Arquivos soltos só funcionam no aplicativo desktop")
  if (typeof grantId !== "string" || !GRANT_ID.test(grantId))
    return refused(403, "FILE_GRANT_REQUIRED", "Solte o arquivo novamente para anexar")
  const redeemed = await kernel.callHost("file.grant.redeem", { grantId })
  if (!redeemed.success) return refused(403, "FILE_GRANT_REQUIRED", "Solte o arquivo novamente para anexar")
  try {
    const { path, dev, ino } = redeemed.value
    const content = await readGrantedFileAsync({ path, dev, ino, maxBytes: MAX_ATTACHMENT_BYTES }, signal)
    return { success: true, name: basename(path), content }
  } catch (error) {
    return refused(400, "ATTACHMENT_ERROR", error instanceof Error ? error.message : "Não foi possível ler o arquivo")
  }
}
