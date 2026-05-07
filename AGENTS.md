## Skills

| Skill | Description | Location |
|-------|-------------|----------|
| `clinmedia-ops-ui` | Premium Dark design system + impeccable frontend aesthetics for clinmedia-ops. Updated v2: Layout architecture, component patterns (cards, drawers, tables, gauges), motion system, dashboard design spec, banned patterns. Auto-loads typescript-strict + clinmedia-ops-react. Trigger: UI/UX work in this project. | [SKILL.md](.opencode/skills/clinmedia-ops-ui/SKILL.md) |
| `clinmedia-ops-react` | React 19 patterns adapted for clinmedia-ops (CRA + Electron). No manual memo unless profiled, strong hook return types, Context patterns, event handler guidelines, cleanup patterns. Trigger: Writing/refactoring React .tsx components, hooks, context providers. | [SKILL.md](.opencode/skills/clinmedia-ops-react/SKILL.md) |
| `typescript-strict` | TypeScript strict patterns adapted from Prowler standards. Const types (REQUIRED), flat interfaces, discriminated unions, no `any`, utility types, branded IDs. Trigger: Writing/refactoring .ts/.tsx files, types, interfaces, generics. | [SKILL.md](.opencode/skills/typescript-strict/SKILL.md) |
| `ui-ux-pro-max` | UI/UX design intelligence with 67 styles, 161 color palettes, 57 font pairings. Design system generation with reasoning engine. | [SKILL.md](.opencode/skills/ui-ux-pro-max/SKILL.md) |
| `impeccable` | Production-grade frontend design skill. 18 commands for audit, critique, polish, distill, and more. Curated anti-patterns. | [SKILL.md](.opencode/skills/impeccable/SKILL.md) |
| `electron-main-architecture` | Electron Main Process architecture: AppStateManager singleton, modular IPC handlers, service layer, electron-store persistence, broadcast to all renderers. CERO Redis, solo memoria Node + store local. Trigger: Writing or refactoring Electron Main Process code (ipc.js, main.js, AppStateManager, services in src/main/). | [SKILL.md](.opencode/skills/electron-main-architecture/SKILL.md) |
| `electron-ipc-patterns` | Electron IPC bridge patterns: contextBridge, preload whitelists, typed methods, cleanup pattern, state update flow, backward compat. Trigger: Writing/refactoring preload.js or IPC bridge. | [SKILL.md](.opencode/skills/electron-ipc-patterns/SKILL.md) |
| `zustand-ui-only` | Zustand UI-only state store patterns: active module, sidebar, modal states. NO process state in Zustand. useMainState hook + AppStateContext integration. Trigger: Adding/using Zustand stores in the renderer. | [SKILL.md](.opencode/skills/zustand-ui-only/SKILL.md) |

## Auto-Load Chains

When `clinmedia-ops-ui` loads, also auto-load:
- `typescript-strict` (for .ts/.tsx patterns)
- `clinmedia-ops-react` (for React 19 patterns)

## Design Context

### Users
Sysadmins and DevOps engineers managing Plesk servers and Hostinger migrations.
They work in dark offices, often late at night, monitoring critical infrastructure.
The interface must feel fast, reliable, and authoritative — never playful or distracting.

### Brand Personality
3 words: Precise, Industrial, Confident.
Technical but clear. Spanish-first UX writing. No fluff, no celebration — just status.

### Aesthetic Direction
- **Theme**: Dark mode ONLY (OLED-friendly).
- **Style**: Dimensional Layering + Data-Dense Dashboard. Think: Bloomberg Terminal meets AWS Console, but refined.
- **Anti-references**: No gradient text, no neon accents, no glassmorphism, no emoji as icons, no border-left stripes, no bounce easing, no purple/cyan AI palette.

### Design Principles
1. Information density — every pixel earns its place
2. Status at a glance — color tells the story before text does
3. Progressive disclosure — start simple, reveal depth through interaction
4. Motion with purpose — only for state changes, never decorative
5. Zero AI slop — no border-left stripes, no gradient text, no cards-in-cards

## Commands

- `/audit` — Run quality checks (a11y, spacing, banned patterns, contrast)
- `/critique` — UX review: hierarchy, clarity, emotional resonance
- `/polish` — Final pass, design system alignment, shipping readiness
- `/normalize` — Align with design tokens and spacing system
