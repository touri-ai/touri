export const workerEntrypoint = (source: URL, compiled: URL): URL => (Bun.isStandaloneExecutable ? compiled : source)
