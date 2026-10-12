# Shared theme ordering

Independent Komari plugin for the Next Pro theme (not tied to benchmark scheduling).

- `GET /api/plugin/komari-layout/order`: shared grid/table order, follow flag and revision; hidden nodes excluded for visitors.
- `POST` to the same route: administrator only; `{revision, kind: "grid" | "table" | "follow", value}`. Node orders are UUID arrays; follow is boolean. Stale revisions receive 409.
- Filtered/grouped drags replace only the visible slots in the complete order. New nodes append; removed nodes are ignored. Independent table order survives follow-mode toggles.
- Stored atomically in `plugin-data/komari-layout/layout.json`. Theme polls every five seconds and on focus. Drag handles support pointer, touch and keyboard input.
- Ping task ordering continues using Komari's existing server-side task weights and administrator RPCs; the theme now refreshes that order across clients.
- Run `node --test plugins/komari-layout/test/*.test.js` from the repository root.
