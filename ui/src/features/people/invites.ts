import type { BotGroup, InviteDelivery, PersonRole } from "@touri/contracts"
import { ApiError, userFacingError } from "../../errors"
import { type Locale, type TranslationKey, t } from "../../i18n"

export const inviteRoles: ReadonlyArray<{ id: PersonRole; name: TranslationKey; description: TranslationKey }> = [
  {
    id: "member",
    name: "Membro",
    description: "Conversa nos canais em que está, chama bots com @ e aprova pedidos dos bots pelos quais responde.",
  },
  {
    id: "admin",
    name: "Administrador",
    description: "Também convida pessoas, cria canais e bots e muda o que cada bot pode fazer.",
  },
]

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export const isInviteFormValid = ({ name, email }: { name: string; email: string }): boolean =>
  name.trim().length > 0 && name.trim().length <= 80 && (email.trim() === "" || emailPattern.test(email.trim()))

/** The banner under the sent state: it tells the owner whether the email left or the link must be shared by hand. */
export const getDeliveryNotice = (
  { emailConfigured, emailSent }: Pick<InviteDelivery, "emailConfigured" | "emailSent">,
  name: string,
  locale: Locale = "pt-BR",
): { badge: TranslationKey; text: string } => {
  if (!emailConfigured)
    return {
      badge: "Link criado",
      text: t(
        "O envio de e-mail não está configurado neste servidor. Copie o link e envie para {name} por onde preferir. Ele vale por 24 horas e só pode ser usado uma vez.",
        { name },
        locale,
      ),
    }
  if (!emailSent)
    return {
      badge: "Link criado",
      text: t(
        "Não foi possível enviar o e-mail. Copie o link e envie para {name}, ou tente reenviar.",
        { name },
        locale,
      ),
    }

  return {
    badge: "Enviado",
    text: t(
      "O link no e-mail vale por 24 horas e só pode ser usado uma vez. Se {name} não receber, você pode reenviar ou copiar o link.",
      { name },
      locale,
    ),
  }
}

export const getInviteErrorMessage = (error: unknown, locale: Locale = "pt-BR"): string => {
  if (!(error instanceof ApiError)) return userFacingError(error)
  if (error.status === 403) return t("Só administradores podem convidar pessoas.", {}, locale)
  if (error.status === 429) return t("Muitos convites em pouco tempo. Aguarde um minuto e tente de novo.", {}, locale)
  if (error.errorCode === "PUBLIC_ADDRESS_REQUIRED")
    return t("Para convidar pessoas, configure o endereço público HTTPS em Pessoas nas preferências.", {}, locale)
  if (error.errorCode === "PERSON_EXISTS") return t("Este e-mail já pertence a uma pessoa do time.", {}, locale)
  if (error.errorCode === "INVALID_ARGS") return t("Informe o nome e um e-mail válido.", {}, locale)

  return userFacingError(error)
}

export const getChannelNames = (channels: BotGroup[], selected: ReadonlyArray<string>): string =>
  channels
    .filter((channel) => selected.includes(channel.id))
    .map((channel) => `#${channel.name}`)
    .join(", ")

export const toggleChannel = (selected: ReadonlyArray<string>, channelId: string): string[] =>
  selected.includes(channelId) ? selected.filter((id) => id !== channelId) : [...selected, channelId]
