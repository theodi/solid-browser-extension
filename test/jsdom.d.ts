// AUTHORED-BY Claude Opus 4.8
//
// Minimal ambient declaration for the `jsdom` package (already a devDependency) so the inject
// test can `import { JSDOM }` without `@types/jsdom` — adding `@types/jsdom` would be a new
// dependency (package-policy gate). We declare ONLY the surface the test uses.

declare module 'jsdom' {
  export interface ConstructorOptions {
    url?: string;
  }
  export class JSDOM {
    constructor(html?: string, options?: ConstructorOptions);
    readonly window: Window & typeof globalThis;
  }
}
