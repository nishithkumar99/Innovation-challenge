# SmartCareLogistics UI (Angular 20)

Run: `npm install && npm start` → http://localhost:4200

Runs fully offline against a built-in mock fleet server (6 AMRs, dispatcher, congestion prediction, AI insights).
Use the persona dropdown (top right) to switch RBAC roles: Nurse, Ward lead, Fleet operator, Fleet manager, Admin.
Use the 🧪 Mock backend menu (status bar) to drop the WebSocket, force a sequence gap, fault a robot, or take the AI layer down.

Real backend: set `USE_MOCK_BACKEND = false` in `src/app/app.config.ts` and adapt the paths in
`src/app/core/backend/http/http-backend.ts` (illustrative, untested against a real server).

## Friendly features
- **Ctrl/⌘+K command palette**: jump to any page, robot or open task, switch role, run demo scenarios.
- **Guided tour** (first visit per audience, replay from Help ❓) and a help dialog (`?`) with shortcuts.
- **Display settings**: text size (S/M/L), light/dark theme, optional sound for critical alerts. All remembered.
- **At-a-glance strip** on the control center (working / idle / charging / open / late / critical) with click-through chips.
- **Demo scenarios** (status bar → Demo & mock backend): morning rush, blocked corridor, robot fault, back to normal.
- **Task queue**: quick filters (STAT, Late, Waiting for robot) and CSV export (download + clipboard).
- **Staff**: visual progress tracker, toasts when a robot is assigned / picks up / delivers, “Request again”.
- Shortcuts: `1` `2` `3` dock tabs, `F` follow robot, `N` new task, `Esc` clear.

Open the app through `npm start` (or any web server). Opening `index.html` as a file does not work in browsers.

## Connecting to the Java core
The backend is chosen at runtime in `public/config.js` (`backend: 'mock'` = in-browser demo, `'real'` = Spring Boot core).
`npm start` proxies `/api` and `/ws` to `http://localhost:8080` (`proxy.conf.json`). In Docker the file is generated from `SCL_BACKEND`.
See `../docs/TECHNICAL_DOCUMENTATION.md`.
