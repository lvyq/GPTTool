# Third-Party Notices

GPTTool is distributed under PolyForm Noncommercial 1.0.0. The packages below remain subject to their own licenses; nothing in the GPTTool license narrows rights granted by those licenses.

## Runtime dependencies

| Component | Version | License | Purpose |
| --- | ---: | --- | --- |
| Electron | 43.1.1 | MIT; bundled Chromium notices | Desktop runtime |
| qrcode | 1.5.4 | MIT | Local QR generation |
| sql.js | 1.14.1 | MIT | Read-only access to local SQLite state |
| ws | 8.21.1 | MIT | Desktop and relay WebSockets |
| jsQR | 1.4.0 | Apache-2.0 | In-browser local QR decoding |
| pg | 8.16.3 | MIT | PostgreSQL relay storage |
| mysql2 | 3.14.2 | MIT | Legacy MySQL migration/compatibility |

## Build dependencies

| Component | License |
| --- | --- |
| TypeScript | Apache-2.0 |
| esbuild | MIT |
| tsx | MIT |
| electron-builder | MIT |

Packaged desktop builds copy Electron's `LICENSE` and `LICENSES.chromium.html` alongside the application resources. npm transitive dependencies and their notices can be enumerated from `package-lock.json`; distributors are responsible for retaining all applicable notices.

## External software and services

- **OpenAI ChatGPT / Codex desktop client** — user-installed external dependency; GPTTool does not redistribute it. OpenAI, ChatGPT and Codex names are used only to describe compatibility and do not imply endorsement.
- **PostgreSQL / Nginx / systemd** — optional self-hosting infrastructure, installed separately by the operator under their respective licenses.

## Similar projects

`CoimgRain/Codex-Mini` is not a dependency and no code or asset from it is distributed here. Its separate source-available license does not replace GPTTool's license. See `docs/ORIGIN_AND_IP.zh-CN.md` for the independent-implementation audit.
