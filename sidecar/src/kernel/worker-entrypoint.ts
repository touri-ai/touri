export const workerEntrypoint = (source: URL, compiledPath: string): URL | string =>
  Bun.isStandaloneExecutable ? compiledPath : source
