# AeroModem

Browser-based, zero-install, phone-to-phone file transfer through **sound**.
Vanilla TypeScript + Vite. No network, no server, no pairing — two phones, one static page.

**Live app (GitHub Pages, HTTPS):** https://vprchlik.github.io/AeroModem/

Open that URL on both phones for a hardware session. HTTPS is required for
`getUserMedia` / `AudioContext`. See [`TESTING.md`](./TESTING.md) for the
measurement protocol.

See [`PLAN.md`](./PLAN.md) for the phased build plan and [`PROGRESS.md`](./PROGRESS.md)
for measured numbers after each phase.

## Develop

```bash
npm install
npm test          # Vitest, Node — no hardware required
npm run dev       # Vite dev server (base=/)
npm run build     # static bundle → dist/
# GitHub Pages build uses VITE_BASE=/AeroModem/ (see .github/workflows/pages.yml)
```

## Modes

| Mode | Band | Payload | Use when |
|---|---|---|---|
| Fast | ≈2–20 kHz | QPSK | quiet small room, short range |
| Robust | ≈2–20 kHz | BPSK | ordinary reverberant rooms |
| Quiet | ≈17–23 kHz | QPSK | near-ultrasonic; needs strong high-band speakers |
