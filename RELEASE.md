# NWPUOJ v2.3.0 Release Runbook

## Source Release

For a GitHub source release, synchronize `VERSION`, package metadata, Web configuration,
Compose image tags, and README; add the matching version section to `CHANGELOG.md`.
Run `npm ci && npm test` from `custom`, validate `docker compose config --quiet`, and review
the staged files. Exclude secrets, uploads, local exports, backups, and private import workspaces.
Create the release commit and annotated `v2.3.0` tag, then push the branch and tag atomically.
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

The production host runs `custom/scripts/weekly-backup.sh` every Sunday at 03:00 Asia/Shanghai.
It writes one validated archive to `../nwpuoj-backups/nwpuoj-latest.tar.gz`, containing the SQL
dump, uploads volume, config volume, image inventory, and source revision. A new archive replaces
the previous one only after completion and gzip validation; failed runs leave the previous archive
in place. Code updates do not create a separate backup. Changes made since the last weekly archive
are not included in rollback data. Do not use `docker compose down -v`.

## Validate And Deploy

```bash
cd custom
npm ci
npm test
node scripts/compatibility-inventory.js --write
cd ..
docker compose config --quiet
docker compose build judge-runner-1 web
docker compose up -d --force-recreate judge-runner-1
docker compose ps
docker compose up -d --force-recreate judge-daemon
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
extract the latest weekly archive and restore its SQL dump and uploads/config data into explicitly
named `nwpuoj_*` volumes. Start MariaDB first, then Web and the Judge stack. Re-run health, queue,
login, problem read, submission, and contest read checks. Writes made after that weekly archive are
not present in the restored data.

Restore the database and both volumes from one archive as a complete set; do not restore only
projection tables or mix files from different weekly archives. Do not try to enable v1 routes in
the v2 image.

## Publish

After validation, create the annotated `v2.3.0` tag and GitHub release from the reviewed release
commit. Include the matching `CHANGELOG.md` section and validation results. For a production
deployment, also record compatibility counts, image digest, latest weekly archive timestamp,
contest drill evidence, and the named rollback owner in the deployment record.
