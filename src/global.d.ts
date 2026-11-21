// Type-level allowance for the Symbol-keyed entries this plugin keeps on globalThis.
declare global {
  // eslint-disable-next-line no-var
  var [string]: unknown;
}
