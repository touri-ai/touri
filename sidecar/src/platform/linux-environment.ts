// These values can execute code in the host launcher before confinement starts.
const executableEnvironment =
  /^(?:LD_|DYLD_|BASH_FUNC_|GCONV_PATH$|GLIBC_TUNABLES$|LOCPATH$|NODE_|BUN_|PYTHON|PERL|RUBY|BASH_ENV$|ENV$|ZDOTDIR$|SHELLOPTS$|PS4$)/i

export const linuxRuntimeEnvironment = (
  env: Record<string, string>,
  selected: string[] = [],
): Record<string, string> => ({
  ...Object.fromEntries(
    ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TERM", "COLORTERM", ...selected]
      .filter((key) => !executableEnvironment.test(key) && env[key] !== undefined)
      .map((key) => [key, env[key]]),
  ),
  HOME: "/touri/home",
  XDG_CONFIG_HOME: "/touri/config",
  XDG_CACHE_HOME: "/touri/cache",
  XDG_STATE_HOME: "/touri/state",
  SHELL: "/bin/sh",
})
