declare module "*.sql" {
  const source: string
  export default source
}

declare module "*/Containerfile" {
  const source: string
  export default source
}
declare module "*.py" {
  const source: string
  export default source
}
declare module "*.sh" {
  const source: string
  export default source
}
declare module "*.cjs" {
  const source: string
  export default source
}
declare module "*.desktop" {
  const content: string
  export default content
}
declare module "*/tint2rc" {
  const content: string
  export default content
}
declare module "*.conf" {
  const content: string
  export default content
}
