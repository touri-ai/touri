import { readdir } from "node:fs/promises"
import { join, relative } from "node:path"

/** Build-time assets are bundled into the desktop server; no runtime download is needed. */
export const getEmbeddedUiSource = async (directory: string, importDirectory: string): Promise<string> => {
  const files = await getFiles(directory)
  const imports = files.map((file, index) => {
    const path = relative(importDirectory, file).replaceAll("\\", "/")
    return `import f${index} from ${JSON.stringify(`./${path}`)} with { type: "file" }`
  })
  const entries = files.map(
    (file, index) => `  ${JSON.stringify(relative(directory, file).replaceAll("\\", "/"))}: f${index},`,
  )
  return `${imports.join("\n")}\nexport const embeddedUi: Record<string, string> = {\n${entries.join("\n")}\n}\n`
}

const getFiles = async (directory: string): Promise<Array<string>> => {
  const entries = await readdir(directory, { withFileTypes: true })
  const children = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) return getFiles(path)
      return Promise.resolve(entry.isFile() ? [path] : [])
    }),
  )
  return children.flat()
}
