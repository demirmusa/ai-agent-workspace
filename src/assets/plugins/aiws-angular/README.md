# Angular plugin

Dedicated views in the chat for `ng` and `nx` commands, an IDE-style test explorer, proportional bundle size bars, and analysis cards that extract architectural structures from the Angular files that are edited and read.

## What changes in the chat

- **ng build**: build errors from esbuild and webpack output, a bundle table with proportional size bars (`initial` / `lazy`), total and transfer size, the number of SSR/prerendered static routes, budget warnings
- **ng test / nx test (IDE Test Explorer)**: a suite-based test tree from Karma/Jasmine, Jest and Vitest output, passed/failed/skipped test cases, success percentage, `Expected` / `Actual` diffs, `file:line` locations, stack trace and browser information
- **ng serve**: the local development address and build errors
- **ng generate**: schematic, name, created and updated files
- **ng lint, update, add, e2e and Nx targets**: `nx test web`, `nx run web:build`, `nx affected -t lint` and the number of Nx cache hits
- **Angular code analysis (`files` and `read`)**: `@Component` (`selector`, `standalone`, `OnPush`), `@Directive`, `@Pipe`, `@Injectable`, Angular Signals (`signal`, `computed`, `linkedSignal`, `resource`, `effect`), signal inputs/outputs (`input`, `output`, `model`, `viewChild`), `inject()` dependencies, `HttpClient` calls, template control flow (`@if`, `@for`, `@switch`, `@defer`), Reactive Forms (`FormGroup`, `FormBuilder`) and `Routes` (`loadComponent` / `loadChildren`)
- **Status panel**: a panel that shows the last build, bundle size, tests and the latest commands

## Installation

Ships with AIWS and is on by default; it can be turned off under **Settings → Plugins**. The plugin uses only the `aiws.conversation` API and has no server code. API: `src/assets/agent-skills/aiws-plugin-development`.
