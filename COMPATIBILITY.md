# NWPUOJ v2 Compatibility Status

Updated: 2026-08-01

## Status

NWPUOJ v2.0.0 is v2-only. Browser writes, JSON reads, forms, and client calls use `/api/v2`.
The v1 API and page-write routes are physically removed from the Web image during `Dockerfile.web`
build. They cannot be re-enabled with a rollout flag.

The generated `COMPATIBILITY-INVENTORY.json` currently enforces:

- 0 v1 API reads;
- 0 v1 write routes and route shapes;
- 0 v1 form actions;
- 0 v1 client calls;
- 0 compatibility adapters;
- 0 custom runtime callbacks outside v2.

The 96 registered non-API `GET` handlers are server-rendered page routes, not compatibility APIs.
The upstream `/judge` write endpoint is an internal signed Judge callback and is the only route shape
allowed by the image cleanup tool. It is not a browser or public API contract.

## Enforcement

The release has three independent gates:

1. `custom/scripts/retire-v1-routes.js` removes v1 routes from the pinned upstream Web image.
2. `custom/scripts/compatibility-inventory.js` scans custom modules, templates, and browser calls.
3. `custom/libs/v2-route-enforcement.js` returns `410 V2_ROUTE_REQUIRED` if a non-v2 write reaches
   the application while `SYZOJ_V2_ONLY=true`.

Regenerate and verify the checked-in inventory with:

```bash
cd custom
node scripts/compatibility-inventory.js --write
node --test tests/compatibility_inventory.test.js tests/v2_route_retirement.test.js
```

## Data Boundary

Existing SYZOJ tables remain the durable storage and Judge protocol boundary where the v2 domain
services require them. They are not a v1 HTTP compatibility layer. v2 events, snapshots, standings,
Rating projections, audit records, and task state are committed through v2 domain services and are
validated against those durable rows.

The archived migration evidence reports:

| Domain | Source rows | Projection rows | Result |
| --- | ---: | ---: | --- |
| Identity | 7 | 7 | consistent |
| Problems | 11084 | 11084 | consistent |
| Submissions | 30 | 30 | consistent |
| Contests | 2 | 2 | consistent |
| Rating | 0 | 0 | consistent |

A complete contest-cycle record and rollback rehearsal record are retained in the database. The
migration controls and migration archive were removed from the normal administration UI after the
gate completed.

## Rollback Boundary

Rollback means restoring the pre-release database backup, upload/config volume archives, and the
previous published application image. It does not mean enabling v1 routes in the v2 image.

Never drop projection, event, audit, or source tables as part of an application rollback. Never use
`docker compose down -v`. Follow [RELEASE.md](RELEASE.md) and verify queues are drained before backup
or restore.
