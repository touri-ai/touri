export const workerEntrypoint = (source: URL, compiledPath: string): URL | string =>
  /(?:^|[\\/])bun(?:\.exe)?$/i.test(process.execPath) ? source : compiledPath
