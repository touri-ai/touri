export type TouriErrorCode = `TOURI-E${number}`
export type ErrorDomain =
  | "kernel"
  | "storage"
  | "provider"
  | "browser"
  | "computer"
  | "project"
  | "import"
  | "machine"
  | "cloud"
export type ErrorDefinition = {
  domain: ErrorDomain
  origin: string
  retryable: boolean
  message: string
  status: number
}

const entry = (
  domain: ErrorDomain,
  origin: string,
  retryable: boolean,
  message: string,
  status: number,
): ErrorDefinition => ({ domain, origin, retryable, message, status })

/** Stable public codes. Internal module codes remain available for control flow. */
export const errorRegistry = {
  "TOURI-E9000": entry("cloud", "cloud-v1", true, "O serviço de nuvem está indisponível.", 503),
  "TOURI-E9001": entry("cloud", "cloud-v1", false, "Conecte sua conta de nuvem novamente.", 401),
  "TOURI-E9002": entry("cloud", "cloud-v1", false, "Esta ação na nuvem não está autorizada.", 403),
  "TOURI-E9003": entry("cloud", "cloud-v1", false, "O bot na nuvem não foi encontrado.", 404),
  "TOURI-E9004": entry("cloud", "cloud-v1", false, "Confira seu plano e a franquia de nuvem.", 402),
  "TOURI-E9005": entry("cloud", "cloud-v1", false, "O estado do computador mudou. Atualize e tente novamente.", 409),
  "TOURI-E9006": entry("cloud", "cloud-v1", true, "Limite de nuvem atingido. Aguarde e tente novamente.", 429),
  "TOURI-E9007": entry("cloud", "cloud-v1", false, "O servidor de nuvem usa um protocolo incompatível.", 400),
  "TOURI-E9008": entry("cloud", "cloud-v1", false, "O endereço de nuvem não é seguro ou não está autorizado.", 403),
  "TOURI-E9009": entry("cloud", "cloud-v1", false, "Execução na nuvem chega em breve", 501),
  "TOURI-E9010": entry("cloud", "cloud-v1", true, "Aguardando confirmação do código no navegador.", 428),
  "TOURI-E9011": entry("cloud", "cloud-v1", false, "O código expirou ou já foi usado. Gere outro.", 401),
  "TOURI-E9012": entry(
    "cloud",
    "cloud-v1",
    false,
    "O cofre de segredos está indisponível. Não foi possível conectar.",
    503,
  ),
  "TOURI-E9013": entry("cloud", "cloud-v1", false, "A nuvem está desativada nas preferências.", 403),
  "TOURI-E9014": entry(
    "cloud",
    "cloud-v1",
    false,
    "Esta fase aceita somente servidores sandbox e chaves API próprias.",
    403,
  ),

  "TOURI-E1000": entry("kernel", "sidecar", false, "Não foi possível concluir a solicitação.", 500),
  "TOURI-E1001": entry("kernel", "validation", false, "Confira os dados informados e tente novamente.", 400),
  "TOURI-E1002": entry("kernel", "routing", false, "O item solicitado não foi encontrado.", 404),
  "TOURI-E1012": entry(
    "kernel",
    "mcp",
    false,
    "O executável do servidor MCP não foi encontrado. Confira a instalação e o PATH na máquina deste bot.",
    400,
  ),
  "TOURI-E1013": entry(
    "kernel",
    "mcp",
    true,
    "Não foi possível conectar ao servidor MCP. Confira o comando, os argumentos ou a URL e se o servidor está disponível na máquina deste bot.",
    400,
  ),
  "TOURI-E1014": entry(
    "kernel",
    "bot-deletion",
    true,
    "A exclusão deste bot já está em andamento. Aguarde a conclusão.",
    409,
  ),
  "TOURI-E1015": entry(
    "kernel",
    "bot-stop",
    true,
    "Não foi possível encerrar as tarefas ou fechar a tela do bot. Pare as tarefas e tente excluir novamente.",
    409,
  ),
  "TOURI-E1016": entry(
    "kernel",
    "bot-credentials",
    true,
    "Não foi possível apagar os logins do bot. Desbloqueie o cofre do sistema e tente excluir novamente.",
    409,
  ),
  "TOURI-E1003": entry("kernel", "authentication", false, "Conecte este dispositivo ao touri novamente.", 401),
  "TOURI-E1004": entry("kernel", "authorization", false, "Esta ação não está autorizada.", 403),
  "TOURI-E1005": entry(
    "kernel",
    "state",
    false,
    "Esta ação conflita com o estado atual. Atualize e tente novamente.",
    409,
  ),
  "TOURI-E1006": entry("kernel", "rate-limit", true, "Muitas solicitações. Aguarde um pouco e tente novamente.", 429),
  "TOURI-E1007": entry("kernel", "cancellation", false, "A operação foi cancelada.", 499),
  "TOURI-E1008": entry("kernel", "deadline", true, "A operação demorou demais. Tente novamente.", 504),
  "TOURI-E1009": entry("kernel", "service", true, "O serviço está indisponível. Tente novamente em instantes.", 503),
  "TOURI-E1011": entry(
    "kernel",
    "authentication",
    false,
    "Código inválido, expirado ou já usado. No servidor, rode touri pair para gerar outro.",
    401,
  ),
  "TOURI-E1010": entry(
    "kernel",
    "transport",
    false,
    "Não foi possível confirmar a ação. Atualize a tela antes de tentar novamente.",
    502,
  ),
  "TOURI-E2000": entry("storage", "filesystem", false, "Não foi possível gravar neste caminho com segurança.", 403),
  "TOURI-E2001": entry("storage", "filesystem", true, "Não foi possível salvar o arquivo. Tente novamente.", 500),
  "TOURI-E2002": entry("storage", "filesystem", false, "Libere espaço no disco para salvar o arquivo.", 507),
  "TOURI-E2003": entry("storage", "attachment", false, "Escolha um arquivo de até 15 MB.", 413),
  "TOURI-E2010": entry(
    "storage",
    "folder-confinement",
    false,
    "Este computador não consegue proteger o acesso a pastas. Nenhuma permissão foi adicionada. Você pode continuar conversando ou enviar um arquivo.",
    400,
  ),
  "TOURI-E2011": entry(
    "storage",
    "folder-selection",
    false,
    "Neste computador, adicione as pastas uma por uma. O acesso a todas as pastas não está disponível. Remova essa permissão nas configurações do bot para continuar com tarefas.",
    400,
  ),
  "TOURI-E2012": entry("storage", "folder-protected", false, "Esta pasta é protegida. Escolha outra pasta.", 400),
  "TOURI-E2013": entry(
    "storage",
    "bot-files",
    true,
    "Não foi possível apagar os arquivos do bot. Confira as permissões da pasta de dados e tente excluir novamente.",
    409,
  ),
  "TOURI-E2014": entry(
    "storage",
    "bot-history",
    true,
    "Não foi possível remover o histórico e os vínculos do bot. Tente excluir novamente; se persistir, envie um relato do problema.",
    409,
  ),
  "TOURI-E2015": entry(
    "storage",
    "bot-cleanup",
    false,
    "O bot foi excluído, mas a limpeza dos anexos privados está pendente. O touri tentará concluir a limpeza automaticamente.",
    409,
  ),
  "TOURI-E3000": entry(
    "provider",
    "cli",
    false,
    "O programa do provedor não foi encontrado. Confira a instalação.",
    503,
  ),
  "TOURI-E3001": entry("provider", "authentication", false, "Entre na sua conta do provedor para continuar.", 401),
  "TOURI-E3002": entry("provider", "cli", true, "O provedor encerrou inesperadamente. Tente novamente.", 502),
  "TOURI-E3003": entry("provider", "protocol", false, "O provedor enviou uma resposta inesperada.", 502),
  "TOURI-E3004": entry("provider", "context", false, "A conversa ficou grande demais. Inicie uma nova conversa.", 422),
  "TOURI-E4000": entry("browser", "automation", true, "Não foi possível concluir a ação no navegador.", 502),
  "TOURI-E4001": entry("browser", "target", true, "A página mudou. Atualize a captura e tente novamente.", 409),
  "TOURI-E4002": entry("browser", "target", false, "Confira o elemento selecionado na página.", 422),
  "TOURI-E4003": entry("browser", "takeover", false, "Devolva o controle do navegador ao bot para continuar.", 409),
  "TOURI-E4004": entry("browser", "secret-entry", false, "Conclua a entrada do segredo para continuar.", 409),
  "TOURI-E4005": entry(
    "browser",
    "site-blocked",
    false,
    "O site bloqueou o acesso automatizado. Resolva o desafio no navegador para o bot continuar.",
    403,
  ),
  "TOURI-E4006": entry(
    "browser",
    "local-chrome",
    false,
    "Meu Chrome indisponível. No Google Chrome, abra chrome://inspect/#remote-debugging, permita a depuração remota e aceite o pedido de permissão do Chrome quando o bot conectar.",
    503,
  ),
  "TOURI-E4007": entry(
    "browser",
    "configuration",
    false,
    "Meu Chrome só funciona em bots no computador onde o touri está rodando. Uma máquina remota não pode acessar esse navegador. Escolha Chrome da máquina para um bot na máquina Linux.",
    400,
  ),
  "TOURI-E5000": entry("computer", "permission", false, "Autorize o acesso ao computador para continuar.", 403),
  "TOURI-E5001": entry("computer", "grant", false, "O acesso ao computador foi interrompido. Autorize novamente.", 403),
  "TOURI-E5002": entry("computer", "control", true, "O computador está ocupado. Aguarde e tente novamente.", 409),
  "TOURI-E6000": entry("project", "process", true, "Não foi possível iniciar o processo do projeto.", 502),
  "TOURI-E6001": entry("project", "filesystem", false, "Escolha um arquivo ignorado pelo Git dentro do projeto.", 422),
  "TOURI-E6002": entry("project", "git", false, "Confira o repositório e o acesso ao Git.", 422),
  "TOURI-E6003": entry("project", "secret", false, "Informe o segredo solicitado para continuar.", 422),
  "TOURI-E6004": entry(
    "project",
    "filesystem",
    false,
    "Escolha uma pasta existente e acessível usando o caminho absoluto.",
    400,
  ),
  "TOURI-E6005": entry(
    "project",
    "git",
    false,
    "Origem não suportada. Use HTTPS, SSH, file:// ou o caminho absoluto de um repositório Git local.",
    400,
  ),
  "TOURI-E6006": entry(
    "project",
    "git",
    false,
    "A pasta de destino já existe. Escolha outro nome ou conecte a pasta existente em Pasta local.",
    409,
  ),
  "TOURI-E6007": entry(
    "project",
    "git",
    true,
    "O Git não respondeu no prazo. Confira o acesso ao repositório e tente novamente.",
    504,
  ),
  "TOURI-E6008": entry(
    "project",
    "connection",
    true,
    "Não foi possível conectar o projeto. Confira a pasta e o acesso ao Git; depois tente novamente.",
    500,
  ),
  "TOURI-E6009": entry(
    "project",
    "machine",
    false,
    "Esta máquina já contém outro projeto. Nas permissões do bot, recrie a máquina do zero antes de trocar o projeto. Os arquivos atuais foram preservados.",
    409,
  ),
  "TOURI-E7000": entry("import", "importer", false, "Não foi possível importar os dados. Confira a origem.", 400),
  "TOURI-E8000": entry(
    "machine",
    "host",
    false,
    "A virtualização não está disponível neste computador. Use um bot local.",
    400,
  ),
  "TOURI-E8001": entry("machine", "container-service", true, "O serviço de máquinas do macOS não está ativo.", 503),
  "TOURI-E8002": entry(
    "machine",
    "container-service",
    true,
    "Não foi possível iniciar o serviço de máquinas do macOS. Tente novamente.",
    503,
  ),
  "TOURI-E8003": entry(
    "machine",
    "bot-deletion",
    true,
    "Não foi possível remover o computador ou os volumes do bot. Confira o serviço de máquinas e tente excluir novamente.",
    409,
  ),
  "TOURI-E8004": entry(
    "machine",
    "bot-usage",
    true,
    "O computador do bot ainda está em uso. Pare as tarefas e tente excluir novamente.",
    409,
  ),
} as const satisfies Record<TouriErrorCode, ErrorDefinition>

export type RegisteredErrorCode = keyof typeof errorRegistry

const aliases: Record<string, RegisteredErrorCode> = {
  ATTACHMENT_TOO_LARGE: "TOURI-E2003",
  MCP_EXECUTABLE_NOT_FOUND: "TOURI-E1012",
  MCP_CONNECTION_FAILED: "TOURI-E1013",
  INVALID_ARGS: "TOURI-E1001",
  INVALID_JSON: "TOURI-E1001",
  INVALID_CODE: "TOURI-E1011",
  NOT_FOUND: "TOURI-E1002",
  TOOL_NOT_FOUND: "TOURI-E1002",
  THREAD_NOT_FOUND: "TOURI-E1002",
  BOT_NOT_FOUND: "TOURI-E1002",
  group_context_missing: "TOURI-E1002",
  UNAUTHORIZED: "TOURI-E1003",
  FORBIDDEN: "TOURI-E1004",
  MISDIRECTED_REQUEST: "TOURI-E1004",
  RATE_LIMITED: "TOURI-E1006",
  rate_limit: "TOURI-E1006",
  CANCELED: "TOURI-E1007",
  ABORT_ERR: "TOURI-E1007",
  canceled: "TOURI-E1007",
  CLIENT_DISCONNECTED: "TOURI-E1007",
  DEADLINE_EXCEEDED: "TOURI-E1008",
  TIMEOUT: "TOURI-E1008",
  ETIMEDOUT: "TOURI-E1008",
  timeout: "TOURI-E1008",
  HOST_UNAVAILABLE: "TOURI-E1009",
  STORE_UNAVAILABLE: "TOURI-E1009",
  ECONNREFUSED: "TOURI-E1009",
  app_restart: "TOURI-E1009",
  ENOSPC: "TOURI-E2002",
  EDQUOT: "TOURI-E2002",
  EIO: "TOURI-E2001",
  EACCES: "TOURI-E2000",
  ELOOP: "TOURI-E2000",
  cli_missing: "TOURI-E3000",
  cli_auth: "TOURI-E3001",
  cli_crash: "TOURI-E3002",
  cli_protocol: "TOURI-E3003",
  context_overflow: "TOURI-E3004",
  STALE_REF: "TOURI-E4001",
  TARGET_CHANGED: "TOURI-E4001",
  NAVIGATED_DURING_SNAPSHOT: "TOURI-E4001",
  AMBIGUOUS_TARGET: "TOURI-E4002",
  TARGET_NOT_FOUND: "TOURI-E4002",
  TARGET_COVERED: "TOURI-E4002",
  TARGET_NOT_INTERACTABLE: "TOURI-E4002",
  REPEATED_FAILURE: "TOURI-E4002",
  ENGINE_UNAVAILABLE: "TOURI-E4000",
  NAVIGATION_FAILED: "TOURI-E4000",
  URL_NOT_ALLOWED: "TOURI-E4000",
  SITE_BLOCKED: "TOURI-E4005",
  LOCAL_BROWSER_UNAVAILABLE: "TOURI-E4006",
  LOCAL_BROWSER_REQUIRES_HOST: "TOURI-E4007",
  TAB_HELD_BY_USER: "TOURI-E4003",
  SECRET_ENTRY_ACTIVE: "TOURI-E4004",
  TAB_NOT_FOUND: "TOURI-E1002",
  TAB_NOT_OWNED: "TOURI-E1004",
  TAB_LIMIT: "TOURI-E1005",
  COMPUTER_DISABLED: "TOURI-E5000",
  COMPUTER_NOT_GRANTED: "TOURI-E5000",
  PERMISSION_MISSING: "TOURI-E5000",
  COMPUTER_KILLED: "TOURI-E5001",
  COMPUTER_BUSY: "TOURI-E5002",
  COMPUTER_UNAVAILABLE: "TOURI-E1009",
  PROCESS_START_FAILED: "TOURI-E6000",
  PROCESS_NOT_READY: "TOURI-E6000",
  PROCESS_DEPENDENCY: "TOURI-E6000",
  PATH_OUTSIDE_PROJECT: "TOURI-E6001",
  NOT_GITIGNORED: "TOURI-E6001",
  PROJECT_NOT_GIT: "TOURI-E6002",
  GIT_FAILED: "TOURI-E6002",
  SECRET_NOT_PROVIDED: "TOURI-E6003",
  PROCESS_NOT_FOUND: "TOURI-E1002",
  SECRET_NOT_FOUND: "TOURI-E1002",
  PREVIEW_NOT_FOUND: "TOURI-E1002",
  PROJECT_EXISTS: "TOURI-E1005",
  PROJECT_PATH_INVALID: "TOURI-E6004",
  GIT_SOURCE_UNSUPPORTED: "TOURI-E6005",
  CLONE_DESTINATION_EXISTS: "TOURI-E6006",
  GIT_TIMEOUT: "TOURI-E6007",
  PROJECT_CONNECT_FAILED: "TOURI-E6008",
  MACHINE_PROJECT_CHANGE: "TOURI-E6009",
  FOLDER_ACCESS_UNAVAILABLE: "TOURI-E2010",
  FOLDER_SELECTION_REQUIRED: "TOURI-E2011",
  FOLDER_PROTECTED: "TOURI-E2012",
  PROCESS_EXISTS: "TOURI-E1005",
  PROCESS_CYCLE: "TOURI-E1005",
  IMPORT_FAILED: "TOURI-E7000",
  MACHINE_UNAVAILABLE: "TOURI-E8000",
  MACHINE_SERVICE_UNAVAILABLE: "TOURI-E8001",
  machine_service_unavailable: "TOURI-E8001",
  MACHINE_SERVICE_START_FAILED: "TOURI-E8002",
  machine_service_start_failed: "TOURI-E8002",
}

export const isErrorCode = (value: unknown): value is RegisteredErrorCode =>
  typeof value === "string" && Object.hasOwn(errorRegistry, value)

export const resolveErrorCode = (value: unknown, status = 500): RegisteredErrorCode => {
  if (isErrorCode(value)) return value
  if (typeof value === "string" && Object.hasOwn(aliases, value)) return aliases[value] ?? "TOURI-E1000"
  if (status === 401) return "TOURI-E1003"
  if (status === 403 || status === 421) return "TOURI-E1004"
  if (status === 404) return "TOURI-E1002"
  if (status === 409) return "TOURI-E1005"
  if (status === 429) return "TOURI-E1006"
  if (status === 408 || status === 504) return "TOURI-E1008"
  if (status === 503) return "TOURI-E1009"
  if (status >= 400 && status < 500) return "TOURI-E1001"
  return "TOURI-E1000"
}

export const publicError = (value: unknown, status = 500) => {
  const code = resolveErrorCode(value, status)
  const definition = errorRegistry[code]
  return {
    code,
    error: definition.message,
    domain: definition.domain,
    origin: definition.origin,
    retryable: definition.retryable,
  }
}
