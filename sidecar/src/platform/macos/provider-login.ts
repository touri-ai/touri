/** expect must read argv from the environment: -c does not forward argv like a shell. */
export const macosProviderLoginPty = (command: string, args: string[]) => ({
  supported: true as const,
  command: "/usr/bin/expect",
  args: [
    "-c",
    'set timeout -1; log_user 1; set stty_init "columns 240 rows 40"; spawn -noecho {*}[split $env(TOURI_LOGIN_ARGV) "\\x1f"]; interact',
  ],
  env: { TOURI_LOGIN_ARGV: [command, ...args].join("\x1f") },
})
