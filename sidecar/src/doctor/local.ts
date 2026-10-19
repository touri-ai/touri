import type { Database } from "bun:sqlite"
import { readFileSync, statfsSync } from "node:fs"
import { freemem, homedir, release, totalmem } from "node:os"
import { join } from "node:path"
import type { DoctorCheck, Kernel } from "@touri/contracts"
import { SCHEMA_VERSION } from "../kernel/db"
import { hostPlatform, ociEngine, platformFor } from "../platform"
import { containerKernelPresent } from "../platform/macos"
import { appleContainerChecks } from "../platform/macos/doctor-local"
import { probeOciService, WINDOWS_VM_FIX } from "../platform/oci-health"
import { providerLoginPty } from "../platform/provider-login"
import { touriVersion } from "../version"
import { BOT_IMAGE, imageContext } from "../vm/image"
import { NATIVE_VAULT_GUIDANCE } from "../vm/provider-login"
import { browserSessionChecks } from "./browserSessions"
import { check, shellQuote } from "./check"
import { codexSessionsCheck } from "./codex-sessions"
import type { DoctorCommand } from "./command"
import { mcpSocketPathCheck, mcpStartupChecks } from "./mcp"
import { withinDeadline } from "./network"
import { providerLoginChecks } from "./providerLogin"

export type LocalProbes = {
  platform: string
  arch: string
  osRelease: string
  headless: boolean
  which: (name: string, path: string) => string | null
  freeBytes: (path: string) => number
  kernelPresent: () => boolean
  memory: () => { total: number; free: number }
  prepareImage: (root: string) => string | Promise<string>
}

export const localProbes: LocalProbes = {
  platform: process.platform,
  arch: process.arch,
  osRelease: release(),
  headless: process.env.TOURI_HEADLESS === "1",
  which: (name, path) => Bun.which(name, { PATH: path }),
  freeBytes: (path) => {
    const fs = statfsSync(path)
    return fs.bavail * fs.bsize
  },
  kernelPresent: containerKernelPresent,
  memory: () => ({ total: totalmem(), free: freemem() }),
  prepareImage: imageContext,
}

export const sidecarChecks = (kernel: Kernel): Array<DoctorCheck> => {
  const version = touriVersion
  let schema: string | null = null
  try {
    schema =
      (
        (kernel.db as Database).query("SELECT value FROM schema_meta WHERE key = 'schema_version'").get() as {
          value: string
        } | null
      )?.value ?? null
  } catch {}
  return [
    ...mcpStartupChecks(kernel.db as Database),
    mcpSocketPathCheck(kernel.paths),
    check("sidecar-version", "Serviço local · versão", "pass", `touri ${version}; Bun ${Bun.version}.`),
    check(
      "sidecar-schema",
      "Banco local · esquema",
      Number(schema) === SCHEMA_VERSION ? "pass" : "fail",
      Number(schema) === SCHEMA_VERSION
        ? `Esquema ${schema}, compatível com o serviço local.`
        : `Esquema ${schema ?? "indisponível"}; o serviço espera ${SCHEMA_VERSION}. Atualize o aplicativo completo e reabra-o.`,
      hostPlatform.appOpenCommand,
    ),
  ]
}

const cliChecks = async (
  name: "claude" | "codex",
  path: string | null,
  run: DoctorCommand,
  signal: AbortSignal,
  platform = process.platform as string,
): Promise<Array<DoctorCheck>> => {
  const install =
    name === "claude"
      ? platform === "darwin"
        ? "brew install --cask claude-code"
        : "npm install -g @anthropic-ai/claude-code"
      : "npm install -g @openai/codex"
  const login = name === "claude" ? "claude auth login" : "codex login"
  if (!path)
    return [
      check(
        name,
        `${name} · versão`,
        "warn",
        "CLI ausente no PATH do shell de login. Instale-a para usar este provedor localmente.",
        install,
      ),
      check(
        `${name}-auth`,
        `${name} · autenticação`,
        "warn",
        "Instale a CLI e depois faça login pelo seu terminal.",
        `${install} && ${login}`,
      ),
    ]
  const codexPrivacy = [
    "-c",
    "analytics.enabled=false",
    "-c",
    'otel.exporter="none"',
    "-c",
    'otel.trace_exporter="none"',
    "-c",
    'otel.metrics_exporter="none"',
  ]
  const [version, auth] = await Promise.all([
    run(path, name === "codex" ? [...codexPrivacy, "--version"] : ["--version"], signal),
    run(path, name === "claude" ? ["auth", "status"] : [...codexPrivacy, "login", "status"], signal),
  ])
  const versionNumber = version.stdout.match(/\b\d+\.\d+(?:\.\d+)?(?:[-+][\w.-]+)?\b/)?.[0]
  const versionReady = version.code === 0 && !version.timedOut && Boolean(versionNumber)
  let loggedIn: boolean | null = null
  if (!auth.timedOut) {
    if (name === "claude") {
      try {
        const parsed: unknown = JSON.parse(auth.stdout)
        if (
          typeof parsed === "object" &&
          parsed !== null &&
          "loggedIn" in parsed &&
          typeof parsed.loggedIn === "boolean"
        )
          loggedIn = parsed.loggedIn ? (auth.code === 0 ? true : null) : false
        else if (typeof parsed === "object" && parsed !== null && "authMethod" in parsed) {
          if (parsed.authMethod === "none") loggedIn = false
          else if (
            ["claude.ai", "oauth_token", "api_key", "api_key_helper", "third_party"].includes(String(parsed.authMethod))
          )
            loggedIn = auth.code === 0 ? true : null
        }
      } catch {}
    } else if (auth.code === 0) loggedIn = true
    else if (/not logged in|login required|unauthenticated/i.test(`${auth.stdout}\n${auth.stderr}`)) loggedIn = false
  }
  return [
    check(
      name,
      `${name} · versão`,
      versionReady ? "pass" : "warn",
      versionReady
        ? `${name} ${versionNumber} disponível em ${path}.`
        : version.timedOut
          ? "A CLI não respondeu ao comando de versão em até 4s."
          : "Executável encontrado, mas não foi possível confirmar a versão.",
      install,
    ),
    check(
      `${name}-auth`,
      `${name} · autenticação`,
      loggedIn === true ? "pass" : loggedIn === false ? "fail" : "warn",
      loggedIn === true
        ? "A CLI confirmou credenciais locais; nenhum segredo foi lido pelo diagnóstico. A validade da sessão no provedor não foi testada."
        : loggedIn === false
          ? "A CLI está sem login. Autentique-se no seu terminal."
          : "Não foi possível confirmar o login. Verifique o status no terminal; versões antigas podem não oferecer este comando.",
      loggedIn === false ? login : `${name} ${name === "claude" ? "auth status" : "login status"}`,
    ),
  ]
}

const openCodeChecks = async (
  path: string | null,
  run: DoctorCommand,
  signal: AbortSignal,
  environment: Record<string, string>,
  kernel: Kernel,
): Promise<Array<DoctorCheck>> => {
  const install = "curl -fsSL https://opencode.ai/install | bash"
  if (!path)
    return [
      check(
        "opencode",
        "OpenCode · versão",
        "warn",
        "OpenCode ausente no PATH e em ~/.opencode/bin/opencode. Instale a CLI para usar este provedor.",
        install,
      ),
    ]
  let configured = Object.entries(environment).some(
    ([key, value]) => /^(OPENROUTER|DEEPSEEK|OPENAI|ANTHROPIC|GOOGLE|GROQ|MISTRAL|XAI)_API_KEY$/.test(key) && !!value,
  )
  try {
    const auth = JSON.parse(
      readFileSync(
        join(environment.XDG_DATA_HOME ?? join(environment.HOME ?? homedir(), ".local/share"), "opencode/auth.json"),
        "utf8",
      ),
    ) as Record<string, { type?: string }>
    configured ||= Object.values(auth).some((entry) => entry?.type === "api" || entry?.type === "oauth")
  } catch {}
  configured ||= !!(kernel.db as Database)
    .query(
      "SELECT 1 FROM secrets WHERE project_id IS NULL AND name IN ('OPENROUTER_API_KEY','DEEPSEEK_API_KEY') AND json_extract(usage_json,'$.env') = 1",
    )
    .get()
  const version = await run(path, ["--version"], signal)
  const number = version.stdout.match(/\b\d+\.\d+\.\d+\b/)?.[0]
  return [
    check(
      "opencode",
      "OpenCode · versão",
      version.code === 0 && number ? "pass" : "warn",
      version.code === 0 && number
        ? `OpenCode ${number} disponível em ${path}.`
        : "Não foi possível confirmar a versão do OpenCode.",
      install,
    ),
    check(
      "opencode-auth",
      "OpenCode · autenticação",
      configured ? "pass" : "warn",
      configured
        ? "Credenciais configuradas localmente; a validade da chave no provedor não foi testada."
        : "Configure OpenRouter ou outro provedor com opencode auth login, ou salve uma chave de API nos segredos do touri. O diagnóstico não testa a chave no provedor.",
      "opencode auth login",
    ),
  ]
}

const containerChecks = async (
  kernel: Kernel,
  path: string | null,
  run: DoctorCommand,
  signal: AbortSignal,
  probes: LocalProbes,
  shellPath: string,
): Promise<Array<DoctorCheck>> => {
  if (probes.headless && probes.platform !== "darwin")
    return [
      check("container", "Máquinas · serviço", "warn", "Bots locais disponíveis no modo servidor"),
      check("vm-system", "Máquinas · serviço", "warn", "Bots locais disponíveis no modo servidor"),
      check("vm-image", "Máquinas · imagem", "warn", "Imagem não verificada"),
    ]
  if (probes.platform !== "darwin") {
    const engine = ociEngine(probes.platform as NodeJS.Platform, (name) => probes.which(name, shellPath))
    if (!engine)
      return [
        check(
          "vm-system",
          "Máquinas · serviço",
          "warn",
          probes.platform === "win32" ? WINDOWS_VM_FIX : "Podman/Docker unavailable. Local bots remain available.",
          probes.platform === "win32" ? WINDOWS_VM_FIX : "Install rootless Podman or Docker Desktop",
        ),
      ]
    const executable = probes.which(engine, shellPath) ?? engine
    const service = await probeOciService({
      engine,
      platform: probes.platform,
      run: async (args) => {
        const output = await run(executable, args, signal)
        return { ...output, code: output.code ?? 127 }
      },
    })
    const image = service.code === 0 ? await run(executable, ["image", "inspect", BOT_IMAGE], signal) : null
    return [
      check(
        "vm-system",
        `${engine} · serviço`,
        service.code === 0 ? "pass" : "warn",
        service.code === 0
          ? `${engine} ready`
          : probes.platform === "win32"
            ? WINDOWS_VM_FIX
            : "Container engine unavailable; check rootless user namespaces / daemon. Local bots remain available.",
        probes.platform === "win32" ? WINDOWS_VM_FIX : `${engine} info`,
      ),
      check(
        "vm-image",
        "Máquinas · imagem",
        image?.code === 0 ? "pass" : "warn",
        image?.code === 0 ? `${BOT_IMAGE} cached` : "The bot image will be built on first use",
      ),
    ]
  }
  return appleContainerChecks(kernel, path, run, signal, probes)
}

export const diskCheck = (path: string, probes: LocalProbes, imagePresent: boolean): DoctorCheck => {
  try {
    const gb = probes.freeBytes(path) / 1024 ** 3
    if (!Number.isFinite(gb) || gb < 0) throw new Error("invalid disk size")
    const recommended = imagePresent ? 5 : 12
    return check(
      "disk",
      "Armazenamento · espaço livre",
      gb < 5 ? "fail" : gb < recommended ? "warn" : "pass",
      `${gb.toFixed(1)} GiB livres. ${recommended} GiB recomendados${imagePresent ? " para as máquinas" : " para construir a imagem"}. ${gb < recommended ? "Revise os arquivos e libere espaço antes de criar uma máquina." : ""}`.trim(),
      hostPlatform.systemSettingsCommand,
    )
  } catch {
    return check(
      "disk",
      "Armazenamento · espaço livre",
      "fail",
      "Não foi possível consultar o espaço no volume de dados do touri.",
      `df -h ${shellQuote(path)}`,
    )
  }
}

export const keychainCheck = async (kernel: Kernel, signal: AbortSignal, probes: LocalProbes): Promise<DoctorCheck> => {
  const hostPlatform = platformFor(probes.platform)
  if (probes.headless)
    return check(
      "keychain",
      hostPlatform.secretStoreLabel,
      "warn",
      probes.platform === "darwin"
        ? "O cofre nativo está disponível apenas no aplicativo desktop do macOS. O modo servidor usa seu próprio cofre local."
        : "O cofre nativo está disponível no aplicativo desktop. O modo servidor usa seu próprio cofre local.",
    )
  try {
    // An intentionally unused touri account tests native access without reading user credentials.
    const result = await withinDeadline(
      () => kernel.callHost("keychain.get", { account: "doctor/access-check" }),
      signal,
      4000,
    )
    return check(
      "keychain",
      hostPlatform.secretStoreLabel,
      result.success ? "pass" : "fail",
      result.success
        ? "Consulta ao cofre nativo concluída pelo aplicativo. Nenhuma credencial foi exibida ou registrada."
        : probes.platform === "darwin"
          ? "O aplicativo não conseguiu acessar o cofre nativo. Abra Acesso às Chaves e verifique o desbloqueio e as permissões do touri."
          : NATIVE_VAULT_GUIDANCE,
      probes.platform === "darwin" ? hostPlatform.secretStoreFix : null,
    )
  } catch {
    signal.throwIfAborted()
    return check(
      "keychain",
      hostPlatform.secretStoreLabel,
      "fail",
      "O cofre nativo não respondeu em até 4s. Verifique o desbloqueio e reabra o touri.",
      probes.platform === "darwin" ? hostPlatform.secretStoreFix : null,
    )
  }
}

export const collectLocalChecks = async (
  kernel: Kernel,
  environment: Record<string, string>,
  run: DoctorCommand,
  signal: AbortSignal,
  probes: LocalProbes = localProbes,
): Promise<Array<DoctorCheck>> => {
  signal.throwIfAborted()
  // A broken executable must not hide other providers, storage or Keychain results.
  const safeRun: DoctorCommand = async (binary, args, abort) => {
    try {
      return await run(binary, args, abort)
    } catch {
      abort.throwIfAborted()
      return { code: null, stdout: "", stderr: "", timedOut: false }
    }
  }
  const path = environment.PATH ?? ""
  const checks = [
    check(
      "shell-env",
      "Shell · ambiente",
      path ? "pass" : "fail",
      path ? "PATH do shell de login carregado." : "PATH vazio. Revise o perfil do seu shell e reabra o touri.",
      'exec "$SHELL" -l',
    ),
  ]
  const [claude, codex, opencode, containers, keychain, logins, codexSessions, browserSessions] = await Promise.all([
    cliChecks("claude", probes.which("claude", path), safeRun, signal, probes.platform),
    cliChecks("codex", probes.which("codex", path), safeRun, signal, probes.platform),
    openCodeChecks(
      probes.which("opencode", path) ??
        probes.which(join(environment.HOME ?? homedir(), ".opencode/bin/opencode"), path),
      safeRun,
      signal,
      environment,
      kernel,
    ),
    containerChecks(kernel, probes.which("container", path), safeRun, signal, probes, path),
    keychainCheck(kernel, signal, probes),
    providerLoginChecks(kernel, environment.HOME ?? homedir(), signal, probes),
    codexSessionsCheck(environment.HOME ?? homedir(), signal),
    browserSessionChecks(kernel, signal, probes),
  ])
  checks.push(...claude, ...codex, ...opencode, ...logins, codexSessions, ...browserSessions)
  if (probes.platform !== "darwin") {
    const pty = providerLoginPty(probes.platform, "provider", [], environment.TOURI_DESKTOP_HELPER)
    const available = pty.supported && !!probes.which(pty.command, path)
    checks.push(
      check(
        "provider-login-pty",
        "Login · terminal",
        available ? "pass" : "warn",
        !pty.supported
          ? pty.message
          : available
            ? `${probes.platform === "win32" ? "ConPTY" : "PTY script"} disponível; o login atual usa importação de credenciais.`
            : probes.platform === "win32"
              ? "Reinstale o aplicativo para disponibilizar o helper ConPTY. A importação continua disponível."
              : "Instale util-linux para disponibilizar script. O login por importação continua disponível.",
      ),
    )
  }
  for (const [name, command] of [...platformFor(probes.platform).installTools]) {
    if (!name || !command) continue
    const resolved = probes.which(name, path)
    checks.push(
      check(
        name,
        name,
        resolved ? "pass" : "warn",
        resolved
          ? `Disponível em ${resolved}.`
          : "Ferramenta opcional ausente. Instale-a se o seu projeto precisar dela.",
        command,
      ),
    )
  }
  return [
    ...checks,
    ...containers,
    diskCheck(
      kernel.paths.appData,
      probes,
      containers.some((item) => item.id === "vm-image" && item.ok),
    ),
    keychain,
  ]
}
