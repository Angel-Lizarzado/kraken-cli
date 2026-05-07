# Proposal: Clinmedia Ops Control Center

## Intent

Build a desktop control center (Electron + React + Node.js) to automate WordPress migration from Hostinger to Plesk with human intervention between phases. Replace legacy Python/PowerShell scripts with a modular, maintainable system that provides real‑time progress visibility and avoids race conditions via UUID‑based task isolation.

## Scope

### In Scope
- Module 0: Dashboard & Server Management – Plesk server cards, SSH key injection
- Module 1: Hostinger Download & Extraction – SSH download, wp‑config.php memory‑limit injection
- Module 2: Plesk Deployment & Sanitization – CLI subscription creation, database cleanup (blacklist, SQL injection prevention)
- Module 3: Cloudflare DNS Integration – API sync from Plesk to Cloudflare
- Module 4: SSL Generation – bulk SSL certificate installation via Plesk CLI
- Core architecture: Electron UI shell, Node.js microservices, UUID‑based task isolation, real‑time progress streaming (IPC/WebSocket), strict workspace file‑system structure

### Out of Scope
- Fully automated pipeline (human approval required between modules)
- Multi‑tenant or concurrent user support (single‑operator desktop application)
- Migration of non‑WordPress sites
- Real‑time collaboration features

## Capabilities

### New Capabilities
- `dashboard-server-management`: Dashboard & Server Management (Plesk server cards, SSH key injection)
- `hostinger-download-extraction`: Hostinger Download & Extraction (SSH, wp‑config.php memory limit injection)
- `plesk-deployment-sanitization`: Plesk Deployment & Sanitization (CLI subscription creation, database cleanup)
- `cloudflare-dns-integration`: Cloudflare DNS Integration (API sync from Plesk to Cloudflare)
- `ssl-generation`: SSL Generation (bulk SSL certificate installation)
- `task-isolation`: UUID‑based task isolation for all server‑side operations
- `real-time-progress`: Real‑time progress streaming from Node.js services to React UI (0‑100%)

### Modified Capabilities
None (no existing specs)

## Approach

Microservices architecture inside an Electron shell:
- **Frontend**: React UI with real‑time progress bars, server cards, and module launchers
- **Backend**: Node.js services (one per module) communicating via IPC/WebSocket
- **Task isolation**: Every operation receives a UUID; temporary scripts and workspace folders use UUID prefixes
- **Progress streaming**: Node.js services stream progress events (0‑100%) to the UI via IPC/WebSocket
- **Security**: SSH key management, API tokens stored in config.json (never in source), SQL injection prevention and blacklist management ported from legacy scripts
- **Workspace structure**: `workspace/{uuid}/` for each task, `workspace/ssh‑keys/`, `workspace/logs/`

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `src/electron/` | New | Electron main process, IPC setup, window management |
| `src/react‑ui/` | New | React components, progress streaming UI, server cards |
| `src/node‑services/` | New | Node.js microservices (module 0‑4), task isolation, progress emitter |
| `config/` | New | config.json (API tokens, server credentials), workspace structure |
| `package.json` | Modified | Add Electron, React, and service dependencies |
| `legacy/` | Unchanged | Reference only – security patterns ported, not modified |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Electron security vulnerabilities | Medium | Follow Electron security best practices, disable Node integration in renderer, use context isolation |
| Cross‑platform compatibility (Windows/macOS) | Low | Test on both platforms early; use platform‑agnostic Node APIs |
| SSH key management & leakage | High | Store keys encrypted in config.json, never log them, use strict file permissions |
| Cloudflare API rate limiting | Medium | Implement exponential backoff, cache DNS records |
| Race conditions between concurrent tasks | High | UUID‑based isolation, separate workspace folders, atomic file operations |

## Rollback Plan

1. **If the application fails during development**: revert the Git commit that introduced the change and remove any added dependencies (`npm uninstall`).
2. **If a deployed version causes issues**: roll back to the previous stable version (Electron app packaging) and restore the legacy scripts from backup.
3. **If a migration task corrupts a server**: each module leaves detailed logs in `workspace/{uuid}/logs/`; use them to manually revert the specific operation (e.g., delete the Plesk subscription, restore the database from backup).

## Dependencies

- Node.js (≥18)
- Electron (≥28)
- React (≥18)
- Plesk CLI (installed on target servers)
- Cloudflare API v4
- SSH2 (Node.js library)

## Success Criteria

- [ ] Each of the 5 modules can be launched independently from the UI and completes its task successfully on a test server
- [ ] Real‑time progress streams from Node.js to React UI (0‑100% with status messages)
- [ ] UUID‑based isolation prevents any file or database collisions when two tasks run concurrently
- [ ] All security patterns from legacy scripts (blacklist management, SQL injection prevention) are preserved
- [ ] Configuration (SSH keys, API tokens) is stored securely in config.json and never leaked to logs