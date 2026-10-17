/** POSIX ABI details stay here; Windows needs native handle-based replacements. */
const apple = process.platform === "darwin"
export const libcLibrary = apple ? "/usr/lib/libSystem.B.dylib" : "libc.so.6"
export const sqliteLibrary = apple ? "/usr/lib/libsqlite3.dylib" : "libsqlite3.so.0"
export const errnoSymbol = apple ? "__error" : "__errno_location"
export const closeOnExec = apple ? 0x1000000 : 0x80000
export const wouldBlock = apple ? 35 : 11
export const quotaExceeded = apple ? 69 : 122
export const direntNameOffset = apple ? 21 : 19
export const removeDirectoryFlag = apple ? 0x80 : 0x200
export const defaultShell = apple ? "/bin/zsh" : "/bin/bash"
export const extraToolDirectories = apple ? ["/opt/homebrew/bin", "/opt/homebrew/sbin"] : []
export const canonicalSystemPath = (path: string) =>
  apple && ["/var/", "/tmp/", "/etc/"].some((alias) => path.startsWith(alias)) ? `/private${path}` : path
