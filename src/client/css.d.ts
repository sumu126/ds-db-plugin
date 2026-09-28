/**
 * Stylesheet module declaration for the client bundle: the build compiles every
 * `*.module.css` file through the CSS Modules pipeline and hands the compiled
 * class map to this default export. The pattern also covers a plain `.css`
 * import, which the same build treats identically.
 */
declare module '*.module.css' {
  const classes: Record<string, string>
  export default classes
}
