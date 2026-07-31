# AeroModem

Browser-based, zero-install, phone-to-phone file transfer through **sound**.
Vanilla TypeScript + Vite. No network, no server, no pairing — two phones, one static page.

See [`PLAN.md`](./PLAN.md) for the phased build plan and [`PROGRESS.md`](./PROGRESS.md)
for measured numbers after each phase.

## Develop

```bash
npm install
npm test          # Vitest, Node — no hardware required
npm run dev       # Vite dev server
npm run build     # static bundle → dist/ (GitHub Pages–ready)
```

Phase 0 status: scaffold only. DSP, audio, and the modem land in Phases 1–6.
