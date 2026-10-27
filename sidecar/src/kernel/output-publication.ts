import type { Database } from "bun:sqlite"

type Publication = { publishers: Set<symbol>; collection: Promise<void> }
const publications = new WeakMap<Database, Publication>()

/** Keep prepared files alive until their references commit, including canceled snapshots. */
export const withOutputPublication = async <Value>(
  database: Database,
  publish: () => Promise<Value>,
): Promise<Value> => {
  const publication = ensurePublication(database)
  const publisher = Symbol()
  publication.publishers.add(publisher)
  try {
    await publication.collection
    return await publish()
  } finally {
    publication.publishers.delete(publisher)
  }
}

/** Collection never waits for a live turn; a later maintenance pass can retry. */
export const tryCollectOutput = async (database: Database, collect: () => Promise<void>): Promise<boolean> => {
  const publication = ensurePublication(database)
  if (publication.publishers.size) return false

  const previous = publication.collection
  const collection = previous.then(collect)
  // A failed removal must still release publishers waiting to recreate that file.
  publication.collection = collection.catch(() => {})
  await collection
  return true
}

const ensurePublication = (database: Database): Publication => {
  const existing = publications.get(database)
  if (existing) return existing

  // Mutable ownership belongs to this connection's asynchronous publication lifecycle.
  const publication = { publishers: new Set<symbol>(), collection: Promise.resolve() }
  publications.set(database, publication)
  return publication
}
