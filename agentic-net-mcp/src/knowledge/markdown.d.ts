/**
 * Ambient module declaration so `import doc from './x.md'` typechecks: tsup bundles .md
 * files as raw strings (loader: {'.md': 'text'}); vitest mirrors it with a tiny plugin.
 */
declare module '*.md' {
  const text: string;
  export default text;
}
