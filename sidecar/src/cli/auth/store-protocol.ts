export type WriteCommand =
  | { type: "create-pairing"; codeHash: string; at: number; expiresAt: number }
  | {
      type: "claim-pairing"
      codeHash: string
      at: number
      device: { id: string; name: string; tokenHash: string; personId: string }
    }
  | {
      type: "create-invite"
      invite: {
        id: string
        tokenHash: string
        name: string
        email: string
        role: "member" | "admin"
        channelIdsJson: string
        createdByPersonId: string
      }
      at: number
      expiresAt: number
    }
  | {
      type: "resend-invite"
      id: string
      actorPersonId: string
      tokenHash: string
      at: number
      expiresAt: number
    }
  | { type: "revoke-invite"; id: string; actorPersonId: string; at: number }
  | {
      type: "claim-invite"
      tokenHash: string
      email: string
      at: number
      person: { id: string; avatarSeed: string }
      device: { id: string; name: string; tokenHash: string }
    }
  | { type: "remove-person"; id: string; actorPersonId: string; at: number }
  | { type: "save-email-config"; actorPersonId: string; configJson: string; at: number }
  | { type: "last-seen"; id: string; at: number }
  | { type: "rotate-token"; id: string; previousHash: string; tokenHash: string }
  | { type: "revoke-device"; id: string; at: number }

export type WriterMessage =
  | { type: "ready" }
  | { type: "stopped" }
  | { type: "startup-error"; error: WorkerError }
  | { type?: undefined; requestId: number; result?: unknown; error?: WorkerError }

export type WorkerError = { name: string; message: string; code?: string }

export type WriterRequest =
  | { type: "start"; filename: string }
  | { type: "stop" }
  | (WriteCommand & { requestId: number })
