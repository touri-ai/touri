import type { AuthStore } from "./auth/store"
import { createEmailService, type EmailDependencies, getMagicSignInEmail, parseEmailConfiguration } from "./email"
import type { SecretStore } from "./host/secretStore"
import { parsePublicAddress } from "./public-address"

export const createEmailSignInSender = ({
  authStore,
  secrets,
  dependencies,
}: {
  authStore: AuthStore
  secrets: SecretStore
  dependencies?: EmailDependencies
}) => {
  const email = createEmailService({ secrets, ...(dependencies ? { dependencies } : {}) })

  return async ({ emailAddress, signal }: { emailAddress: string; signal: AbortSignal }): Promise<void> => {
    const config = parseEmailConfiguration(authStore.getEmailConfig())
    const publicAddress = parsePublicAddress(authStore.getPublicAddress())
    const inviter = authStore.getPerson("owner")
    if (!config || !publicAddress || !inviter || !(await email.hasCredentials(config))) return

    const signIn = await authStore.createEmailSignIn({ email: emailAddress })
    if (!signIn.success) return
    const link = new URL("/login", publicAddress)
    link.hash = `signin=${encodeURIComponent(signIn.token)}`
    const content = getMagicSignInEmail({
      inviter,
      config,
      link: link.toString(),
      expiresAt: signIn.expiresAt,
    })
    await email.send({ config, content: { ...content, to: emailAddress }, signal })
  }
}
