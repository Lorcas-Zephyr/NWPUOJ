# NWPUOJ v2.0.1 Release Runbook

## Preconditions

- The release commit is reviewed and the working tree contains no accidental files.
- `COMPATIBILITY-INVENTORY.json` reports zero v1 API reads, writes, forms, clients, and adapters.
- MariaDB, RabbitMQ, Redis, Web, Judge Control, Judge Daemons, and Judge Runners are healthy.
- No submission or unified job is running and RabbitMQ has no ready or unacknowledged task.

## Backup

Create all artifacts before changing containers:

```bash
mkdir -p release-backup
docker compose exec -T mariadb mariadb-dump -uroot \
  --single-transaction --routines --events syzoj > release-backup/nwpuoj-v2.sql
docker run --rm -v nwpuoj_uploads:/data:ro -v "$PWD/release-backup:/backup" \
  alpine:3.20 tar czf /backup/uploads.tar.gz -C /data .
docker run --rm -v nwpuoj_config:/data:ro -v "$PWD/release-backup:/backup" \
  alpine:3.20 tar czf /backup/config.tar.gz -C /data .
```

Record the current image digests with `docker compose images --format json` and keep the previous
release checkout available. Do not use `docker compose down -v`.

## Validate And Deploy

```bash
cd custom
npm ci
npm test
node scripts/compatibility-inventory.js --write
cd ..
docker compose config --quiet
docker compose build web
docker compose up -d --force-recreate web
docker compose ps
curl -fsS http://127.0.0.1/help >/dev/null
```

Compile every mounted EJS template in the running Web container, confirm Web/Judge Control/worker
health and restart counts, then perform the role matrix for anonymous, ordinary user, participant,
problem reviewer, contest manager, Judge operator, site administrator, and site owner.

Create one short disposable ACM contest. Verify registration, participant administration, problem
access, source submission, live status, standings, contest end, Rating calculation, notification,
invalid-submission handling, contest deletion, and downstream Rating recalculation. Delete all
disposable contest accounts and data through normal v2 administration actions.

## Rollback

Stop Web and Judge services before restoring. Restore the previous published checkout/image, then
restore the SQL dump and both volume archives into explicitly named `nwpuoj_*` volumes. Start
MariaDB first, then Web and the Judge stack. Re-run health, queue, login, problem read, submission,
and contest read checks.

Do not partially restore only projection tables. Do not try to enable v1 routes in the v2 image.
If the release schema has accepted production writes, use the complete pre-release database and
volume set so rows, files, events, and projections return to one consistent point in time.

## Publish

After validation, create the annotated `v2.0.1` tag and GitHub release from the reviewed release
commit. Include `CHANGELOG.md`, compatibility counts, test totals, image digest, backup identifiers,
contest drill evidence, and the named rollback owner in the release notes.
