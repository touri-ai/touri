import rootPackage from "../../package.json"

/** Version reported by the sidecar: an explicit `TOURI_VERSION`, else the root package version. */
export const resolveTouriVersion = (env: Record<string, string | undefined>): string => {
  const explicit = env.TOURI_VERSION?.trim()
  return explicit ? explicit : rootPackage.version
}

export const touriVersion = resolveTouriVersion(process.env)
