// Executing the module catches what `node --check` cannot: a parse-valid file that throws on load.
globalThis.HTMLElement = class { attachShadow() { return { addEventListener() {}, querySelectorAll: () => [], querySelector: () => null }; } };
globalThis.customElements = { get: () => undefined, define: () => {} };
const m = await import(process.argv[2]);
console.log('module loaded and element defined:', typeof m.default === 'function');
