/**
 * Stylesheet module declaration for the client bundle: the build compiles
 * `page.css` through the CSS Modules pipeline and hands the compiled class map
 * to this default export.
 */
declare module '*.css' {
  const classes: Record<string, string>
  export default classes
}
