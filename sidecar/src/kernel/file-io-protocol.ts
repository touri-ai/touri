import type { FileWrite } from "./files"

export type FileIoTask =
  | { operation: "flush" }
  | { operation: "write"; args: FileWrite }
  | { operation: "append"; args: FileWrite & { maxBytes?: number } }
  | { operation: "ensure-directory"; args: { root: string; path?: string; mode?: number } }
  | { operation: "remove"; args: { root: string; path: string } }
  | { operation: "move"; args: { root: string; from: string; to: string } }
  | { operation: "exists"; args: { root: string; path: string } }
  | { operation: "read-private"; args: { root: string; path: string; maxBytes: number } }
  | { operation: "prepare-database"; args: { root: string; path: string } }
  | {
      operation: "append-log"
      args: { root: string; path: string; content: Uint8Array; maxBytes: number; retainedGenerations: number }
    }
  | {
      operation: "create-workspace-directory"
      args: { root: string; path: string; identity: { dev: number; ino: number } }
    }
  | { operation: "rotate-directory"; args: { root: string; directory: string; retainedFiles: number } }
  | { operation: "remove-if-matches"; args: { root: string; path: string; content: string } }
  | { operation: "replace-symlink"; args: { root: string; path: string; target: string } }
  | { operation: "remove-bot-home"; args: { root: string; path: string; botId: string } }

export type FileIoMessage =
  | { type: "ready" }
  | { type?: undefined; requestId: number; result?: unknown; error?: FileIoError }
export type FileIoError = { name: string; message: string; code?: string }
export type FileIoRequest = { type: "start" } | ({ requestId: number } & FileIoTask)
