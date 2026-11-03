/** The name the account already uses (sidebar, Work messages); the owner profile falls back to it. */
export const getAccountName = (person: { handle?: string | null; name?: string | null } | undefined) =>
  person?.handle?.trim() || person?.name?.trim() || undefined
