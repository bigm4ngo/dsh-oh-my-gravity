// The slice of the DeepSeek Harness (dsh) service surface this plugin actually touches. The dsh
// packages are not dependencies here; these shapes were read off the installed service type files
// and narrowed to what this plugin calls.
/** Session ids cross the wire as plain strings; this is where a string becomes a branded id. */
export const asSessionId = (id) => 
// SAFETY: the brand only records provenance; every id here came from dsh itself.
id;
//# sourceMappingURL=dsh.js.map