# NWPUOJ v2.2.0 Release Runbook

## Source Release

For a GitHub source release, synchronize `VERSION`, package metadata, Web configuration,
Compose image tags, and README; add the matching version section to `CHANGELOG.md`.
Run `npm ci && npm test` from `custom`, validate `docker compose config --quiet`, and review
the staged files. Exclude secrets, uploads, local exports, backups, and private import workspaces.
Create the release commit and annotated `v2.2.0` tag, then push the branch and tag atomically.
The `Release` GitHub Actions workflow reruns the tests and publishes the matching changelog
section. Verify the workflow and published GitHub Release before reporting completion.

Production deployment is a separate operation. The backup, health, deployment, and rollback
steps below apply when changing a running installation.

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

After validation, create the annotated `v2.2.0` tag and GitHub release from the reviewed release
commit. Include the matching `CHANGELOG.md` section and validation results. For a production
deployment, also record compatibility counts, image digest, backup identifiers, contest drill
evidence, and the named rollback owner in the deployment record.
