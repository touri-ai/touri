export type WriteCommand =
  | { type: "create-pairing"; codeHash: string; at: number; expiresAt: number }
  | {
      type: "claim-pairing"
      codeHash: string
      at: number
      device: { id: string; name: string; tokenHash: string }
    }
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
