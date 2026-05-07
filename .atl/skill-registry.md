# Skill Registry

**Delegator use only.** Any agent that launches sub-agents reads this registry to resolve compact rules, then injects them directly into sub-agent prompts. Sub-agents do NOT read this registry or individual SKILL.md files.

See `_shared/skill-resolver.md` for the full resolution protocol.

## User Skills

| Trigger | Skill | Path |
|---------|-------|------|
| When building or refactoring UI components, modals, cards, forms, layouts, dashboards, or when auditing visual polish, spacing, micro-interactions, and motion | clinmedia-ops-ui | C:\Users\Angel\Documents\Code\Clinmedia\clinmedia-ops\.opencode\skills\clinmedia-ops-ui\SKILL.md |
| When writing or refactoring React components in .tsx (hooks, state, server/client split, actions, Context patterns) | clinmedia-ops-react | C:\Users\Angel\Documents\Code\Clinmedia\clinmedia-ops\.opencode\skills\clinmedia-ops-react\SKILL.md |
| When writing or refactoring .ts/.tsx files (types, interfaces, generics, const maps, type guards, removing any, tightening unknown, discriminated unions) | typescript-strict | C:\Users\Angel\Documents\Code\Clinmedia\clinmedia-ops\.opencode\skills\typescript-strict\SKILL.md |
| UI/UX design intelligence with searchable database | ui-ux-pro-max | C:\Users\Angel\Documents\Code\Clinmedia\clinmedia-ops\.opencode\skills\ui-ux-pro-max\SKILL.md |
| Create distinctive, production-grade frontend interfaces with high design quality. Use when the user asks to build web components, pages, artifacts, posters, or applications | impeccable | C:\Users\Angel\Documents\Code\Clinmedia\clinmedia-ops\.opencode\skills\impeccable\SKILL.md |
| When writing or refactoring Electron Main Process code (ipc.js, main.js, AppStateManager, services in src/main/) | electron-main-architecture | C:\Users\Angel\Documents\Code\Clinmedia\clinmedia-ops\.opencode\skills\electron-main-architecture\SKILL.md |
| When writing/refactoring preload.js or IPC bridge | electron-ipc-patterns | C:\Users\Angel\Documents\Code\Clinmedia\clinmedia-ops\.opencode\skills\electron-ipc-patterns\SKILL.md |
| When adding/using Zustand stores in the renderer | zustand-ui-only | C:\Users\Angel\Documents\Code\Clinmedia\clinmedia-ops\.opencode\skills\zustand-ui-only\SKILL.md |

## Compact Rules

Pre-digested rules per skill. Delegators copy matching blocks into sub-agent prompts as `## Project Standards (auto-resolved)`.

### clinmedia-ops-ui
- Dark mode ONLY — OLED-friendly (`--surface-base: oklch(0.18 0.01 250)`) — NEVER add light mode
- OKLCH for ALL surfaces/text/borders — no hex except SVG fills; use the 12 CSS custom property tokens from SKILL.md
- Banned patterns (NEVER use): border-left stripes >1px, gradient text (`background-clip: text`), glassmorphism, emoji as icons, cards-in-cards, bounce/elastic easing, purple/cyan AI palette, hero metrics, sparklines as decoration, generic Inter/Arial/Roboto
- Fonts: Satoshi/Founders Grotesk for display, Inter for body, JetBrains Mono for data — Major Third 1.25 scale (xs through 2xl)
- 4pt spacing scale: `--space-{xs|sm|md|lg|xl|2xl|3xl}` — use `gap` NOT margins for sibling spacing
- Motion: animate only `transform` and `opacity` — NEVER `width/height/padding/margin` — 150ms ease-out hover, 300ms spring drawer, 200ms modal — respect `prefers-reduced-motion: reduce`
- Cards: fixed height 76px, flat hierarchy (one level only), padding `--space-md`, border `1px solid --border-default`, hover `scale(1.02)` + `--surface-hover`
- Drawers: slide from right, `max-w-lg` (32rem), scrim `oklch(0 0 0 / 0.4)`, spring damping 25/stiffness 200 — NEVER full-screen on desktop
- Modals: centered `max-w-md`, scrim `oklch(0 0 0 / 0.6)`, NO animation, type-to-confirm for destructive actions, NOT full-screen on desktop
- Semantic colors: success `oklch(0.65 0.18 150)`, warning `oklch(0.7 0.18 75)`, error `oklch(0.6 0.2 25)`, info `oklch(0.6 0.12 250)`, accent `oklch(0.6 0.15 250)` — each with a `-bg` variant at 15% alpha
- Spanish UX writing — labels, messages, status in Spanish — no fluff, no celebration, just status
- Gauges: SVG `<circle>` with `strokeDasharray`/`strokeDashoffset`, 90x90 viewBox, 36px radius, 6px stroke, color by threshold (green <70, amber 70-90, red >90), 1s easeOut on mount

### clinmedia-ops-react
- No manual `useMemo`/`useCallback` preemptively — CRA (no React Compiler), only add if profiling shows a hot path issue
- Named imports ONLY: `import { useState } from "react"` — NEVER `import React from "react"`
- Custom hooks return typed objects (interface), NOT tuples (except `useState`)
- Context: separate Context interface from Provider state — narrow contexts, narrow consumers
- `useCallback` only when handler is passed as a prop (identity matters) — inline is fine for internal handlers
- Props: destructure, typed interface (extract to `types.ts` when shared), NEVER inline unions or `any`
- Constants OUTSIDE component (not recreated every render) — `as const` for arrays/objects
- `useEffect`: one concern per effect — NEVER monolithic effects — always return cleanup function for subscriptions/event listeners
- Fragment (`<>`) over unnecessary `<div>` wrapper
- Early returns for loading/empty states — main render stays un-nested
- Cleanup: `useEffect` return must remove event listeners, subscriptions, timers — match the add/remove API exactly

### typescript-strict
- Const Types pattern REQUIRED: create `const X = { ... } as const`, then `type X = (typeof X)[keyof typeof X]` — NEVER direct union strings
- Flat interfaces: ONE level depth — nested objects get their own interface — NEVER inline nested `{ ... }`
- Discriminated unions for coupled props: if two+ props are only meaningful together, they belong to the SAME union branch with `never` for unused fields — NEVER independent optionals that allow invalid half-states
- NEVER use `any` — use `unknown` for unknown data, generics for flexible types, type guards for narrowing
- `import type` REQUIRED for type-only imports: `import type { X } from "./y"` — NEVER `import { X } from "./y"` when X is only a type
- Branded types for IDs: `type ServerId = string & { readonly __brand: "ServerId" }` — prevents type confusion at compile time
- `Record<string, unknown>` for dynamic data (API responses, SSH results) — NEVER `Record<string, any>`
- Utility types: prefer `Pick`, `Omit`, `Partial`, `Required`, `Readonly`, `Record`, `Extract`, `Exclude`, `NonNullable`, `ReturnType`, `Parameters`, `Awaited` — don't reinvent

### ui-ux-pro-max
- Workflow: analyze requirements → generate design system with `--design-system` flag → supplement with domain searches as needed → consult stack guidelines
- Start with: `python3 scripts/search.py "<product_type> <industry> <keywords>" --design-system -p "Project Name"`
- Persist with `--persist` for MASTER.md + page overrides pattern (hierarchical retrieval: page file overrides Master file)
- Available domains: product, style, typography, color, landing, chart, ux, react, web, prompt
- Available stacks: html-tailwind (default), react, nextjs, vue, svelte, swiftui, react-native, flutter, shadcn, jetpack-compose
- Common rules: no emoji icons (use SVG), cursor-pointer on all clickables, hover feedback with transitions (150-300ms), correct contrast in both modes
- Pre-delivery checklist: no emoji icons, consistent SVG set, cursor-pointer on all clickable, hover transitions, focus states, contrast 4.5:1+, responsive at 375/768/1024/1440px, alt text on images, `prefers-reduced-motion` respected

### impeccable
- Context gathering required before any design: check instructions → check `.impeccable.md` → run `/impeccable teach`
- Font selection procedure: write 3 brand words → list 3 reflex fonts → REJECT all from reflex list (Fraunces, Inter, DM Sans, etc.) → browse catalog with brand words → cross-check against reflex patterns
- Color: use OKLCH, tint neutrals toward brand hue (chroma 0.005-0.01), 60-30-10 visual weight rule, derive theme from audience context NOT default
- ABSOLUTE BANS: `border-left: Xpx` stripes on cards/items (Ban 1), `background-clip: text` gradient fill (Ban 2)
- Spatial: 4pt scale using semantic names (`--space-sm`), `gap` over margins, container queries for components/viewport queries for page layout
- Motion: only `transform` and `opacity`, exponential easing (ease-out-quart/quint), no bounce/elastic, `prefers-reduced-motion: reduce`
- Responsive: container queries for components, adapt not shrink, never hide critical functionality on mobile
- Pre-delivery: run the AI Slop Test — "would someone say 'AI made this' immediately?" — if yes, it fails

### electron-main-architecture
- Main Process is SOLE owner of business logic, global state (AppStateManager), background jobs, external API communication (SSH, Cloudflare, Plesk)
- Renderer ONLY displays state + fires IPC actions — NEVER imports `fs`, `path`, `child_process`
- AppStateManager: SINGLETON, electron-store for persistence (CERO Redis, solo memoria Node + store local), BrowserWindow.getAllWindows() for broadcast to ALL renderers
- IPC handlers: modular per-domain — one file per domain (config, ssh, extraction, deployment, cloudflare, ssl, workspace, utils), imported by ipc.js orchestrator
- Module execution: operation lock prevents concurrent SSH operations, progress emitter for event-driven updates, task-based lifecycle (create → progress → complete/cancel/error)
- Window lifecycle: splash on startup, main window with config load on did-finish-load, close protection if tasks are running

### electron-ipc-patterns
- NEVER expose `ipcRenderer` directly — always use `contextBridge.exposeInMainWorld`
- Preload is single source of truth: 3 whitelists (SEND_CHANNELS, RECEIVE_CHANNELS, INVOKE_CHANNELS) at top of preload.js
- Channel naming convention: `module:action` for send, `module:event-name` for receive, `action-name` or `domain:action` for invoke
- Each channel validation logs a warning on invalid channel attempt
- Two APIs exposed: `window.api` (legacy, send/receive/receiveListener) and `window.electronAPI` (preferred, typed methods returning cleanup functions)
- safeReceive pattern: returns cleanup function for cleanup in useEffect — `return () => ipcRenderer.removeListener(channel, handler)`
- New IPC channel = add to preload whitelist + register handler + expose typed method

### zustand-ui-only
- UI state ONLY in Zustand (active module, sidebar, modals, filters, tabs, pagination) — NEVER process state
- Process state lives in Main Process AppStateManager, arrives via `state:update` IPC event → `useMainState` hook → `AppStateContext` reducer
- Const types REQUIRED: `const X = { ... } as const; type X = (typeof X)[keyof typeof X]`
- Flat store interfaces, actions in the same interface as state
- No manual memo unless profiled; one concern per useEffect; named imports only
- State update flow: Main Process update → IPC broadcast → preload receive → renderer context update → React re-render

## Project Conventions

| File | Path | Notes |
|------|------|-------|
| AGENTS.md | C:\Users\Angel\Documents\Code\Clinmedia\clinmedia-ops\AGENTS.md | Index — references files below |
| clinmedia-ops-ui SKILL.md | .opencode/skills/clinmedia-ops-ui/SKILL.md | Referenced by AGENTS.md |
| clinmedia-ops-react SKILL.md | .opencode/skills/clinmedia-ops-react/SKILL.md | Referenced by AGENTS.md |
| typescript-strict SKILL.md | .opencode/skills/typescript-strict/SKILL.md | Referenced by AGENTS.md |
| ui-ux-pro-max SKILL.md | .opencode/skills/ui-ux-pro-max/SKILL.md | Referenced by AGENTS.md |
| impeccable SKILL.md | .opencode/skills/impeccable/SKILL.md | Referenced by AGENTS.md |
| electron-main-architecture SKILL.md | .opencode/skills/electron-main-architecture/SKILL.md | Referenced by AGENTS.md |
| electron-ipc-patterns SKILL.md | .opencode/skills/electron-ipc-patterns/SKILL.md | Referenced by AGENTS.md |
| zustand-ui-only SKILL.md | .opencode/skills/zustand-ui-only/SKILL.md | Referenced by AGENTS.md |

Read the convention files listed above for project-specific patterns and rules. All referenced paths have been extracted — no need to read index files to discover more.
