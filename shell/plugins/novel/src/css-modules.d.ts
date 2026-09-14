/** CSS Modules side-channel: every *.module.css import yields a class-name map. */

declare module '*.module.css' {
  const classes: Record<string, string>
  export default classes
}
