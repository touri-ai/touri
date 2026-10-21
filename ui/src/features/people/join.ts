import { type Locale, type TranslationKey, t } from "../../i18n"

export const joinPath = "/join"

export const isJoinPath = (pathname: string): boolean => pathname === joinPath || pathname === `${joinPath}/`

/** The token travels in the URL fragment, so it never reaches server logs or referrers. */
export const getInviteToken = (hash: string): string => new URLSearchParams(hash.replace(/^#/, "")).get("invite") ?? ""

export type RedeemResult = { ok: true } | { ok: false; message: TranslationKey }

export const redeemInvite = async ({
  token,
  email,
  deviceName,
  name,
  fetchImpl = fetch,
}: {
  token: string
  email: string
  deviceName: string
  name?: string
  fetchImpl?: typeof fetch
}): Promise<RedeemResult> => {
  try {
    const response = await fetchImpl("/api/v1/invites/redeem", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token,
        ...(name ? { name } : {}),
        email: email.trim(),
        deviceName: deviceName.trim() || "Navegador",
      }),
      signal: AbortSignal.timeout(15_000),
    })
    if (response.ok) return { ok: true }
    if (response.status === 429) return { ok: false, message: "Muitas tentativas. Aguarde um pouco e tente de novo." }

    return {
      ok: false,
      message: "Convite inválido, expirado, já usado ou com outro e-mail. Peça um novo link a quem convidou.",
    }
  } catch {
    return {
      ok: false,
      message: "Não foi possível falar com o servidor. Confira a conexão e tente de novo.",
    }
  }
}

export const getJoinMessage = (message: TranslationKey, locale: Locale = "pt-BR"): string => t(message, {}, locale)
