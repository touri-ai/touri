import DOMPurify from "dompurify"

const localReference = /^#[\w:.-]+$/

const checkStyle = (value: string): void => {
  const css = value.replace(/\/\*[\s\S]*?\*\//g, "")
  // Diagrams may animate local edges, but may not load resources or escape their SVG styles.
  if (css.includes("\\") || /@(?!(?:-webkit-)?keyframes\b)/i.test(css)) throw new Error("Unsupported diagram style")
  for (const match of css.matchAll(/url\s*\(([^)]*)\)/gi)) {
    const reference = (match[1] ?? "").trim().replace(/^(['"])(.*)\1$/, "$2")
    if (!localReference.test(reference)) throw new Error("External diagram resource")
  }
}

/** Keep only inert SVG. The caller also isolates its styles in a shadow root. */
export const sanitizeMermaidSvg = (markup: string): string => {
  const clean = DOMPurify.sanitize(markup, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: ["foreignobject", "a", "image", "script", "animate", "animatemotion", "animatetransform", "set"],
    ALLOW_DATA_ATTR: false,
  })
  const document = new DOMParser().parseFromString(clean, "image/svg+xml")
  const svg = document.documentElement
  if (svg.localName !== "svg" || document.querySelector("parsererror")) throw new Error("Invalid diagram SVG")
  for (const element of [svg, ...svg.querySelectorAll("*")]) {
    if (element.localName === "style") checkStyle(element.textContent ?? "")
    for (const attribute of [...element.attributes]) {
      if (attribute.localName === "href" && !localReference.test(attribute.value))
        element.removeAttributeNode(attribute)
      else if (attribute.name === "style" || /url\s*\(/i.test(attribute.value)) checkStyle(attribute.value)
    }
  }
  return new XMLSerializer().serializeToString(svg)
}
