import type {
  AbsolutePath,
  Bot,
  Kernel,
  ListeningPort,
  PreviewTarget,
  ProcessRunState,
  ProcessSpec,
  Project,
  ProjectInfo,
  SecretMeta,
  ToolContext,
} from "@touri/contracts"

export type ProjectErrorCode =
  | import("@touri/contracts").VaultErrorCode
  | "INVALID_ARGS"
  | "NOT_FOUND"
  | "PROJECT_EXISTS"
  | "PROJECT_NOT_GIT"
  | "GIT_FAILED"
  | "PATH_OUTSIDE_PROJECT"
  | "PROCESS_EXISTS"
  | "PROCESS_NOT_FOUND"
  | "PROCESS_CYCLE"
  | "PROCESS_DEPENDENCY"
  | "PROCESS_START_FAILED"
  | "PROCESS_NOT_READY"
  | "SECRET_NOT_FOUND"
  | "SECRET_NOT_PROVIDED"
  | "DENIED"
  | "HOST_UNAVAILABLE"
  | "HOST_ERROR"
  | "NOT_GITIGNORED"
  | "PREVIEW_NOT_FOUND"

export type ProjectResult<T> = ({ success: true } & T) | { success: false; errorCode: ProjectErrorCode; error: string }

export type CommandOutput = {
  code: number | null
  signal: string | null
  stdout: string
  stderr: string
}

export type ProjectStore = {
  listProjects: () => Array<Project>
  getProject: (projectId: string) => Project | null
  getProjectByPath: (path: AbsolutePath) => Project | null
  createProject: (args: {
    id: string
    name: string
    path: AbsolutePath
    gitRemote: string | null
    defaultBranch: string | null
    dataDir: AbsolutePath
    now: number
  }) => Promise<ProjectResult<{ project: Project }>>
  listSecrets: (args: { projectId: string | null }) => Array<SecretMeta>
  getSecret: (args: { projectId: string | null; name: string }) => SecretMeta | null
  upsertSecret: (args: {
    projectId: string | null
    name: string
    usage: { env: boolean; browser: boolean }
    browserOrigin: string | null
    now: number
  }) => ProjectResult<{ secret: SecretMeta }>
  deleteSecret: (args: { projectId: string | null; name: string }) => Promise<ProjectResult<Record<never, never>>>
  listProcessSpecs: (args: { projectId: string }) => Array<ProcessSpec>
  getProcessSpec: (args: { processId: string }) => ProcessSpec | null
  getProcessSpecByName: (args: { projectId: string; name: string; vmBotId?: string | null }) => ProcessSpec | null
  upsertProcess: (args: {
    vmBotId?: string | null
    projectId: string
    name: string
    command: string
    cwd: AbsolutePath
    env: ProcessSpec["env"]
    autostart: boolean
    restart: ProcessSpec["restart"]
    dependsOn: Array<string>
    ready: ProcessSpec["ready"]
    previewPort: number | null
    createdBy: ProcessSpec["createdBy"]
    now: number
  }) => ProjectResult<{ spec: ProcessSpec }>
  insertProcessRun: (args: {
    id: string
    processId: string
    pid: number | null
    pgid: number | null
    pidStart: string | null
    status: ProcessRunState["status"]
    logPath: AbsolutePath
    startedAt: number
  }) => ProcessRunState
  updateProcessRun: (args: {
    runId: string
    status?: ProcessRunState["status"]
    exitCode?: number | null
    signal?: string | null
    ports?: Array<ListeningPort>
    endedAt?: number | null
  }) => ProcessRunState | null
  getProcessRun: (args: { runId: string }) => ProcessRunState | null
  getCurrentProcessRun: (args: { processId: string }) => ProcessRunState | null
  getLatestProcessRun: (args: { processId: string }) => ProcessRunState | null
  getLiveProcessRuns: () => Array<{ run: ProcessRunState; pidStart: string | null }>
  getProcessLogs: (args: { runId: string; tail: number }) => Array<string>
  processRunLogPath: (args: { runId: string }) => AbsolutePath | null
}

/** Work-recovery context for a managed process start. `automatic` starts are blocked by uncertain effects. */
export type WorkScope = { turnId: string | null; threadId: string | null; automatic: boolean }

export type ManagedProcess = {
  spec: ProcessSpec
  run: ProcessRunState
  failures: Array<number>
  stopped: boolean
  ports: Array<ListeningPort>
  logLines: Array<string>
  logPath: AbsolutePath
  child: Extract<ReturnType<Kernel["spawnTree"]>, { success: true }>
  hostPorts?: Map<number, number>
  previewBases?: Map<number, string>
  guestPgid?: number
  previewPorts: Set<number>
  ready: boolean
  effect?: { id: string; turnId: string | null }
  confine?: Bot["access"]
}

export type Supervisor = {
  define: (args: {
    botId?: string
    vmBotId?: string | null
    project: Project
    name: string
    command: string
    cwd: AbsolutePath
    env: ProcessSpec["env"]
    autostart: boolean
    restart: ProcessSpec["restart"]
    dependsOn: Array<string>
    ready: ProcessSpec["ready"]
    previewPort: number | null
    createdBy: ProcessSpec["createdBy"]
    threadId?: string
  }) => ProjectResult<{ spec: ProcessSpec }>
  start: (args: {
    confine?: Bot["access"]
    ctx?: ToolContext
    project: Project
    spec: ProcessSpec
    waitMs: number
    signal?: AbortSignal
    scope?: WorkScope
  }) => Promise<ProjectResult<{ run: ProcessRunState }>>
  stop: (args: { processId: string }) => Promise<ProjectResult<{ run: ProcessRunState }>>
  restart: (args: {
    confine?: Bot["access"]
    ctx?: ToolContext
    signal?: AbortSignal
    project: Project
    spec: ProcessSpec
    waitMs: number
    scope?: WorkScope
  }) => Promise<ProjectResult<{ run: ProcessRunState }>>
  list: (args: { projectId: string }) => Array<{ spec: ProcessSpec; run: ProcessRunState | null }>
  logs: (args: { processId: string; tail: number; grep?: string }) => ProjectResult<{ lines: Array<string> }>
  previews: (args?: { projectId?: string }) => Array<PreviewTarget>
  openPreview: (args: {
    botId?: string
    project: Project
    port?: number
    processName?: string
    path: string
    vmBotId?: string | null
  }) => ProjectResult<{ preview: PreviewTarget }>
  stopAll: () => Promise<void>
  cleanupOrphans: () => Promise<void>
  autostart: () => Promise<void>
}

export type ProjectsModule = {
  projectInfo: (args: { projectId: string }) => Promise<ProjectInfo | null>
  supervisor: Supervisor
}
