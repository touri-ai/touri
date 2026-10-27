export const BROWSER_PROFILE = "/var/lib/touri-browser/profile"
export const BROWSER_LOG = "/var/lib/touri-browser/chromium.log"
export const BROWSER_START_BUDGET_MS = 25_000
export const BROWSER_LIVENESS_EVERY = 4

export const BROWSER_FLAGS = [
  "--disable-dev-shm-usage",
  "--disable-gpu",
  "--renderer-process-limit=2",
  "--disable-features=BackForwardCache",
  "--js-flags=--max-old-space-size=512",
  "--remote-debugging-port=9222",
  `--user-data-dir=${BROWSER_PROFILE}`,
  "--no-first-run",
  "about:blank",
] as const

/**
 * Root-only guest script. A profile that a previous boot or an older image left locked
 * ("in use by another computer") makes Chromium wait behind a modal window and never open
 * its debugging port. The lock is cleared only when no browser-uid Chromium is running, and
 * only by unlinking the three well-known names through a no-follow directory descriptor.
 */
export const CLEAR_STALE_PROFILE_LOCKS_COMMAND = `import os,subprocess,sys
# Image 10 serializes cleanup and startup inside its browser-identity helper.
if os.path.isfile('/usr/local/lib/touri/browser-flags.json'):
 print('managed');sys.exit(0)
alive=subprocess.run(['pgrep','-u','1001','-x','chromium'],stdout=subprocess.DEVNULL).returncode==0
if alive:
 print('running');sys.exit(0)
try: fd=os.open('${BROWSER_PROFILE}',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
except FileNotFoundError:
 print('fresh');sys.exit(0)
cleared=0
for name in ('SingletonLock','SingletonSocket','SingletonCookie'):
 try:
  os.unlink(name,dir_fd=fd);cleared+=1
 except FileNotFoundError: pass
os.close(fd)
print('cleared' if cleared else 'clean')`

export const BROWSER_RUNNING_COMMAND = "pgrep -u 1001 -x chromium >/dev/null"
export const BROWSER_STOP_COMMAND = "pkill -u 1001 -x chromium; pkill -u 1001 -f chrome_crashpad; true"
export const BROWSER_LAUNCH_SHELL = `if test -f /usr/local/lib/touri/browser-flags.json; then exec python3 /usr/local/lib/touri/desktop-launcher.py --start-browser >> ${BROWSER_LOG} 2>&1; fi
: > ${BROWSER_LOG}; exec chromium "$@" >> ${BROWSER_LOG} 2>&1`
export const BROWSER_LOG_TAIL_COMMAND = `tail -c 400 ${BROWSER_LOG} 2>/dev/null || true`

export type BrowserStartFailure = "exited" | "unresponsive"

export class BrowserStartError extends Error {
  readonly errorCode = "BROWSER_START_FAILED"

  constructor(
    readonly reason: BrowserStartFailure,
    message: string,
  ) {
    super(message)
  }
}

/** pt-BR cause shown to the bot and the user when the guest browser does not come up. */
export const browserStartMessage = ({ reason, detail }: { reason: BrowserStartFailure; detail: string }): string => {
  const suffix = detail.trim() ? ` Detalhe: ${detail.trim().replace(/\s+/g, " ").slice(0, 300)}` : ""
  if (reason === "exited") return `O navegador da VM encerrou ao iniciar.${suffix}`
  return `O navegador da VM abriu, mas não liberou a porta de controle em ${BROWSER_START_BUDGET_MS / 1000} s e foi reiniciado.${suffix}`
}
