#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
if [[ -n "${NWPUOJ_BACKUP_DIR:-}" ]]; then
    BACKUP_DIR="$NWPUOJ_BACKUP_DIR"
else
    BACKUP_DIR="$(dirname "$REPO_ROOT")/nwpuoj-backups"
fi

mkdir -p "$BACKUP_DIR"
exec 9>"$BACKUP_DIR/.weekly-backup.lock"
if ! flock -n 9; then
    echo "A weekly backup is already running; skipping."
    exit 0
fi

find "$BACKUP_DIR" -maxdepth 1 -type f -name '.nwpuoj-latest.*.tar.gz' -delete
find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -name '.work.*' -exec rm -rf -- {} +

WORK_DIR="$(mktemp -d "$BACKUP_DIR/.work.XXXXXXXX")"
ARCHIVE_TMP="$BACKUP_DIR/.nwpuoj-latest.$$.tar.gz"

cleanup() {
    if [[ -d "$WORK_DIR" ]]; then
        rm -rf -- "$WORK_DIR"
    fi
    if [[ -f "$ARCHIVE_TMP" ]]; then
        unlink "$ARCHIVE_TMP"
    fi
}
trap cleanup EXIT

echo "Starting NWPUOJ weekly backup at $(date '+%Y-%m-%d %H:%M:%S %z')."
docker compose --project-directory "$REPO_ROOT" -f "$REPO_ROOT/docker-compose.yml" \
    exec -T mariadb sh -ec \
    'exec mariadb-dump -uroot -p"$MYSQL_ROOT_PASSWORD" --single-transaction --routines --events syzoj' \
    > "$WORK_DIR/database.sql"
docker compose --project-directory "$REPO_ROOT" -f "$REPO_ROOT/docker-compose.yml" \
    images --format json > "$WORK_DIR/images.json"
printf 'created_at=%s\ncommit=%s\n' \
    "$(date '+%Y-%m-%dT%H:%M:%S%z')" \
    "$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || printf unknown)" \
    > "$WORK_DIR/manifest.txt"

docker run --rm \
    -v "$WORK_DIR:/source/metadata:ro" \
    -v nwpuoj_uploads:/source/uploads:ro \
    -v nwpuoj_config:/source/config:ro \
    -v "$BACKUP_DIR:/out" \
    alpine:3.20 tar czf "/out/$(basename "$ARCHIVE_TMP")" -C /source .
gzip -t "$ARCHIVE_TMP"
tar -tzf "$ARCHIVE_TMP" >/dev/null
mv -f -- "$ARCHIVE_TMP" "$BACKUP_DIR/nwpuoj-latest.tar.gz"
echo "NWPUOJ weekly backup completed: $BACKUP_DIR/nwpuoj-latest.tar.gz ($(du -h "$BACKUP_DIR/nwpuoj-latest.tar.gz" | cut -f1))."
