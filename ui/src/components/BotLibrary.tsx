import type { Bot, WorkspaceFile, WorkspaceFileContent } from "@touri/contracts"
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import type { UiApi } from "../api/client"
import { getDocumentLocale } from "../documentLanguage"
import { userFacingError } from "../errors"
import { DEFAULT_LOCALE, type Locale, t } from "../i18n"
import { useSaveNotice } from "../useSaveNotice"
import { EvidenceContext, type EvidenceContextValue, EvidenceGallery } from "./EvidenceGallery"
import { loadImage } from "./imageLoads"
import { MarkdownContent } from "./MarkdownContent"
import { PanelIcon } from "./PanelIcon"

const fileText = (file: WorkspaceFileContent) =>
  new TextDecoder().decode(Uint8Array.from(atob(file.base64), (c) => c.charCodeAt(0)))
const textFile = (file: WorkspaceFileContent) =>
  file.mime.startsWith("text/") || /\.(md|json|ts|tsx|js|jsx|py|rs|toml|yaml|yml|log|sh|css|csv)$/i.test(file.name)
const imageName = /\.(png|jpe?g|gif|webp)$/i
export const getFileSize = (bytes: number, locale: Locale = DEFAULT_LOCALE) => {
  if (bytes === 0) return "0 B"

  if (bytes >= 1024 ** 2) {
    const count = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(bytes / 1024 ** 2)

    return t("{count} MB", { count }, locale)
  }

  const count = new Intl.NumberFormat(locale).format(Math.ceil(bytes / 1024))

  return t("{count} KB", { count }, locale)
}

export const BotLibrary = ({
  api,
  bot,
  request,
  onComputer,
}: {
  api: UiApi
  bot: Bot
  request?: { path: string; request: number } | undefined
  onComputer?: (() => void) | undefined
}) => {
  const [path, setPath] = useState("")
  const [folderRoot, setFolderRoot] = useState<string | null>(null)
  const [files, setFiles] = useState<WorkspaceFile[]>([])
  const [loading, setLoading] = useState(true)
  const [revision, setRevision] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [file, setFile] = useState<(WorkspaceFileContent & { imagePath?: string }) | null>(null)
  const [pendingImage, setPendingImage] = useState<{ name: string; path: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [readError, setReadError] = useState<{ message: string; entry: WorkspaceFile; download: boolean } | null>(null)
  const [projectPath, setProjectPath] = useState<string | null>(null)
  const [rootError, setRootError] = useState(false)
  const locale = getDocumentLocale(document.documentElement)
  const section = useRef<HTMLElement>(null)
  const title = useRef<HTMLHeadingElement>(null)
  const generation = useRef(0)
  const origin =
    bot.machine === "vm" || bot.machine === "cloud"
      ? "Workspace da VM"
      : bot.projectId || (bot.cwd && bot.cwd !== bot.homeDir)
        ? "Workspace do projeto"
        : "Pasta do bot"
  const remote = bot.machine === "vm" || bot.machine === "cloud"
  const rootPath = remote ? "/workspace" : bot.cwd || (bot.projectId ? projectPath : bot.homeDir)
  const currentRoot = folderRoot ?? rootPath

  // biome-ignore lint/correctness/useExhaustiveDependencies: revision also retries origin lookup
  useEffect(() => {
    if (bot.machine === "vm" || !bot.projectId) return
    let active = true
    setProjectPath(null)
    setRootError(false)
    void api
      .request("GET /projects", {})
      .then(({ projects }) => {
        if (active)
          setProjectPath(
            projects.find((project) => project.id === bot.projectId && !project.archivedAt)?.path ??
              bot.cwd ??
              bot.homeDir,
          )
      })
      .catch(() => {
        if (active) setRootError(true)
      })
    return () => {
      active = false
    }
  }, [api, bot.machine, bot.projectId, bot.cwd, bot.homeDir, revision])

  // biome-ignore lint/correctness/useExhaustiveDependencies: revision explicitly refreshes the directory
  useEffect(() => {
    let active = true
    generation.current += 1
    setLoading(true)
    setFiles([])
    setError(null)
    setReadError(null)
    setFile(null)
    setBusy(false)
    void api
      .request("GET /bots/:id/files", { path }, { id: bot.id })
      .then((response) => {
        if (active) setFiles(response.files)
      })
      .catch((reason) => {
        if (active) setError(userFacingError(reason))
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
      generation.current += 1
    }
  }, [api, bot.id, bot.machine, bot.cwd, bot.homeDir, bot.projectId, path, revision])

  // biome-ignore lint/correctness/useExhaustiveDependencies: folder navigation also resets its parent scroll
  useLayoutEffect(() => {
    const scroller = section.current?.closest<HTMLElement>(".bot-panel-body")
    if (scroller) scroller.scrollTop = 0
    if (file) title.current?.focus({ preventScroll: true })
  }, [file, path])

  const { notice, saveBytes, saveImage } = useSaveNotice()
  const read = async (entry: WorkspaceFile, download = false, forceImage = false) => {
    const current = ++generation.current
    setBusy(true)
    setReadError(null)
    try {
      if (download && imageName.test(entry.name)) {
        const raw = await api
          .request("GET /bots/:id/files/content", { path: entry.path }, { id: bot.id })
          .catch(() => null)
        if (current !== generation.current) return
        if (raw) return void (await saveBytes(raw))
        const blob = await loadImage(() => api.request("GET /bots/:id/images", { path: entry.path }, { id: bot.id }))
        if (current === generation.current) await saveImage(async () => blob, entry.name)
        return
      }
      if (forceImage || imageName.test(entry.name)) {
        setFile({
          name: entry.name,
          mime: "image/preview",
          base64: "",
          imagePath: entry.path.startsWith("/") ? entry.path : rootPath ? `${rootPath}/${entry.path}` : entry.path,
        })
        return
      }
      const content = await api.request("GET /bots/:id/files/content", { path: entry.path }, { id: bot.id })
      if (current !== generation.current) return
      if (download) await saveBytes(content)
      else setFile(content)
    } catch (reason) {
      if (current === generation.current) setReadError({ message: userFacingError(reason), entry, download })
    } finally {
      if (current === generation.current) setBusy(false)
    }
  }
  const back = () => {
    generation.current += 1
    setFile(null)
    setReadError(null)
    setBusy(false)
    if (!file) {
      if (path === currentRoot) {
        setFolderRoot(null)
        setPath("")
      } else setPath(path.split("/").slice(0, -1).join("/"))
    }
  }
  const navigateImage = useCallback(
    (target: string, base = "") => {
      const relative =
        rootPath && target.startsWith(`${rootPath}/`)
          ? target.slice(rootPath.length + 1)
          : target.startsWith("/")
            ? target
            : [base, target].filter(Boolean).join("/")
      if (relative.split("/").includes("..")) return
      const name = relative.split("/").at(-1) ?? "Imagem"
      if (relative.startsWith("/")) {
        setFolderRoot(bot.folders?.find((folder) => relative.startsWith(`${folder.path}/`))?.path ?? null)
        setPath(relative.split("/").slice(0, -1).join("/"))
        setFile(null)
        setPendingImage({ name, path: relative })
        return
      }
      setPath(relative.split("/").slice(0, -1).join("/"))
      setFile(null)
      setPendingImage({ name, path: rootPath ? `${rootPath}/${relative}` : relative })
    },
    [rootPath, bot.folders],
  )
  const evidence = useMemo<EvidenceContextValue>(
    () => ({
      api,
      bot,
      base: path,
      onLibrary: (target) => navigateImage(target, path),
      ...(onComputer ? { onComputer } : {}),
    }),
    [api, bot, path, navigateImage, onComputer],
  )
  useEffect(() => {
    if (request && rootPath) navigateImage(request.path)
  }, [request, rootPath, navigateImage])
  useEffect(() => {
    if (pendingImage && !loading) {
      setFile({ name: pendingImage.name, mime: "image/preview", base64: "", imagePath: pendingImage.path })
      setPendingImage(null)
    }
  }, [pendingImage, loading])
  const breadcrumbBase = currentRoot && path.startsWith(currentRoot) ? currentRoot : path.startsWith("/") ? "" : null
  const parts = (breadcrumbBase ? path.slice(breadcrumbBase.length) : path).split("/").filter(Boolean)
  return (
    <section ref={section} className="bot-library" aria-label={`Biblioteca de ${bot.name}`}>
      {notice && (
        <p className="muted-copy" role="status">
          {notice}
        </p>
      )}
      {file ? (
        <article className="library-viewer" aria-label={`Arquivo ${file.name}`}>
          <header className="library-viewer-header">
            <button className="button button-quiet" type="button" onClick={back}>
              <PanelIcon name="back" /> Voltar aos arquivos
            </button>
            <div className="library-heading">
              <h3 ref={title} tabIndex={-1}>
                {file.name}
              </h3>
              <button
                className="panel-icon-button"
                type="button"
                aria-label="Baixar arquivo"
                title="Baixar arquivo"
                onClick={() =>
                  file.mime === "image/preview"
                    ? void read(
                        {
                          name: file.name,
                          path: file.imagePath ?? [path, file.name].filter(Boolean).join("/"),
                          directory: false,
                          bytes: 0,
                        },
                        true,
                        true,
                      )
                    : void saveBytes(file)
                }
              >
                <PanelIcon name="download" />
              </button>
            </div>
            <p className="library-file-location">
              {file.imagePath ??
                [path.startsWith("/") ? path : [rootPath, path].filter(Boolean).join("/"), file.name]
                  .filter(Boolean)
                  .join("/")}
            </p>
          </header>
          <div className="library-viewer-content">
            {file.mime === "image/preview" ? (
              <EvidenceContext.Provider value={evidence}>
                <EvidenceGallery
                  images={[{ path: file.imagePath ?? file.name, caption: file.name, filename: file.name }]}
                />
              </EvidenceContext.Provider>
            ) : /^image\/(png|jpeg|gif|webp)$/.test(file.mime) ? (
              <img src={`data:${file.mime};base64,${file.base64}`} alt={file.name} />
            ) : textFile(file) ? (
              /\.md$/i.test(file.name) ? (
                <MarkdownContent content={fileText(file)} evidence={evidence} />
              ) : (
                <pre>{fileText(file)}</pre>
              )
            ) : (
              <p className="muted-copy">Prévia indisponível para este formato. Baixe para abrir no seu computador.</p>
            )}
          </div>
        </article>
      ) : (
        <>
          <header className="library-origin">
            <div className="library-heading">
              <h3>{folderRoot ? "Pasta autorizada" : origin}</h3>
              <button
                className="panel-icon-button"
                type="button"
                aria-label="Atualizar arquivos"
                title="Atualizar arquivos"
                disabled={loading || busy}
                onClick={() => setRevision((value) => value + 1)}
              >
                <PanelIcon name="refresh" />
              </button>
            </div>
            <p className="library-root-path">
              {currentRoot ?? (rootError ? "Caminho do projeto indisponível" : "Carregando caminho…")}
            </p>
            {rootError && (
              <button className="button button-quiet" type="button" onClick={() => setRevision((value) => value + 1)}>
                Tentar novamente
              </button>
            )}
            <p className="library-limit">
              {t("Imagens de até 15 MB; demais arquivos de até 512 KB. Pastas ocultas e links não são exibidos.")}
            </p>
          </header>
          {!!bot.folders?.length && (
            <nav className="library-breadcrumbs" aria-label="Pastas autorizadas">
              {bot.folders.map((folder) => (
                <button
                  key={folder.path}
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setFolderRoot(folder.path)
                    setPath(folder.path)
                  }}
                >
                  <PanelIcon name="folder" /> {folder.path}
                </button>
              ))}
            </nav>
          )}
          <nav className="library-breadcrumbs" aria-label="Caminho da biblioteca">
            <button
              type="button"
              disabled={busy || (!path && !folderRoot)}
              aria-current={!path ? "page" : undefined}
              onClick={() => {
                setFolderRoot(null)
                setPath("")
              }}
            >
              Raiz
            </button>
            {parts.map((part, index) => (
              <span key={parts.slice(0, index + 1).join("/")}>
                <span aria-hidden="true">/</span>
                <button
                  type="button"
                  disabled={busy || index === parts.length - 1}
                  aria-current={index === parts.length - 1 ? "page" : undefined}
                  onClick={() =>
                    setPath(
                      `${breadcrumbBase === null ? "" : `${breadcrumbBase}/`}${parts.slice(0, index + 1).join("/")}`,
                    )
                  }
                >
                  {part}
                </button>
              </span>
            ))}
          </nav>
          {path && (
            <button className="button button-quiet library-back" type="button" onClick={back}>
              <PanelIcon name="back" /> Voltar · Pasta anterior
            </button>
          )}
          {error ? (
            <div className="bot-panel-state library-error" role="alert">
              <PanelIcon name="folder" />
              <strong>Não foi possível abrir {path ? `“${parts.at(-1)}”` : "esta pasta"}</strong>
              <p>{error}</p>
              <button className="button button-quiet" type="button" onClick={() => setRevision((value) => value + 1)}>
                Tentar novamente
              </button>
            </div>
          ) : loading ? (
            <div className="library-loading" role="status">
              <p>Carregando arquivos…</p>
              <span />
              <span />
              <span />
            </div>
          ) : files.length ? (
            <>
              <p className="library-count">
                {files.length} {files.length === 1 ? "item" : "itens"}
              </p>
              <ul className="library-files">
                {files.map((entry) => (
                  <li key={entry.path}>
                    <button
                      className="library-file"
                      type="button"
                      disabled={busy}
                      onClick={() => (entry.directory ? setPath(entry.path) : void read(entry))}
                    >
                      <PanelIcon name={entry.directory ? "folder" : "file"} />
                      <span>{entry.name}</span>
                      <small>{entry.directory ? "Pasta" : getFileSize(entry.bytes, locale)}</small>
                    </button>
                    {!entry.directory && (
                      <button
                        className="panel-icon-button"
                        type="button"
                        disabled={busy}
                        aria-label={`Baixar ${entry.name}`}
                        title={`Baixar ${entry.name}`}
                        onClick={() => void read(entry, true)}
                      >
                        <PanelIcon name="download" />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <div className="bot-panel-empty">
              <PanelIcon name="folder" />
              <strong>Nenhum arquivo por aqui</strong>
              <p>
                {path ? "Esta pasta está vazia." : "Os arquivos criados nesta pasta aparecem na biblioteca do bot."}
              </p>
            </div>
          )}
          {readError && (
            <div className="bot-panel-state library-error" role="alert">
              <strong>
                Não foi possível {readError.download ? "baixar" : "abrir"} “{readError.entry.name}”
              </strong>
              <p>{readError.message}</p>
              <button
                className="button button-quiet"
                type="button"
                disabled={busy}
                onClick={() => void read(readError.entry, readError.download)}
              >
                Tentar novamente
              </button>
            </div>
          )}
          {busy && (
            <p className="muted-copy" role="status">
              Abrindo arquivo…
            </p>
          )}
        </>
      )}
    </section>
  )
}
