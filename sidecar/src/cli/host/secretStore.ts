import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto"
import { join } from "node:path"
import { readPrivateFileAsync, writePrivateFileAsync } from "../../kernel/async-files"
import { atomicWriteFile, readPrivateFile } from "../../kernel/files"

export type SecretStore = {
  get: (account: string) => string | null
  getAsync: (account: string) => Promise<string | null>
  set: (args: { account: string; value: string }) => Promise<void>
  delete: (account: string) => Promise<void>
  keyOrigin: "env" | "file"
}

type Envelope = { v: 1; iv: string; tag: string; data: string }

const loadKey = ({ dir, env }: { dir: string; env: Record<string, string | undefined> }): Buffer => {
  const fromEnv = env.TOURI_SECRETS_KEY
  if (fromEnv) return createHash("sha256").update(fromEnv).digest()
  const keyPath = join(dir, "secrets.key")
  const saved = readPrivateFile({ root: dir, path: keyPath })
  if (saved) {
    atomicWriteFile({ root: dir, path: keyPath, content: saved })
    return Buffer.from(saved.toString("utf8").trim(), "hex")
  }
  const key = randomBytes(32)
  atomicWriteFile({ root: dir, path: keyPath, content: `${key.toString("hex")}\n` })
  return key
}

const encrypt = ({ key, plain }: { key: Buffer; plain: string }): Envelope => {
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", key, iv)
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()])
  return { v: 1, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") }
}

const decrypt = ({ key, envelope }: { key: Buffer; envelope: Envelope }): string => {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"))
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"))
  return Buffer.concat([decipher.update(Buffer.from(envelope.data, "base64")), decipher.final()]).toString("utf8")
}

const getEntries = ({ saved, key }: { saved: Buffer | null; key: Buffer }): Record<string, string> => {
  if (!saved) return {}
  const parsed: unknown = JSON.parse(saved.toString("utf8"))
  if (!isEnvelope(parsed)) throw new Error("secrets.enc is not a valid envelope")
  return JSON.parse(decrypt({ key, envelope: parsed })) as Record<string, string>
}

const isEnvelope = (value: unknown): value is Envelope => {
  if (typeof value !== "object" || value === null) return false
  const row = value as Record<string, unknown>
  return row.v === 1 && typeof row.iv === "string" && typeof row.tag === "string" && typeof row.data === "string"
}

/**
 * Secrets for headless servers: one AES-256-GCM file (0600) under the data dir.
 * The key comes from TOURI_SECRETS_KEY or a separate 0600 key file in the same directory.
 */
export const createSecretStore = ({
  dir,
  env = process.env,
}: {
  dir: string
  env?: Record<string, string | undefined>
}): SecretStore => {
  const file = join(dir, "secrets.enc")
  const key = loadKey({ dir, env })
  const read = (): Record<string, string> => {
    const saved = readPrivateFile({ root: dir, path: file })
    return getEntries({ saved, key })
  }
  const readAsync = async (): Promise<Record<string, string>> =>
    getEntries({ saved: await readPrivateFileAsync({ root: dir, path: file, maxBytes: 1_048_576 }), key })
  const write = (entries: Record<string, string>): Promise<void> =>
    writePrivateFileAsync({
      root: dir,
      path: file,
      content: JSON.stringify(encrypt({ key, plain: JSON.stringify(entries) })),
    })
  let writeQueue = Promise.resolve()
  const update = (transform: (entries: Record<string, string>) => Record<string, string>): Promise<void> => {
    const next = writeQueue.then(async () => write(transform(await readAsync())))
    writeQueue = next.catch(() => undefined)
    return next
  }
  return {
    keyOrigin: env.TOURI_SECRETS_KEY ? "env" : "file",
    get: (account) => read()[account] ?? null,
    getAsync: async (account) => (await readAsync())[account] ?? null,
    set: ({ account, value }) => update((entries) => ({ ...entries, [account]: value })),
    delete: (account) =>
      update((entries) => {
        const { [account]: _removed, ...rest } = entries
        return rest
      }),
  }
}
