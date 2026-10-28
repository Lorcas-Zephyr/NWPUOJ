#!/usr/bin/env bash
set -euo pipefail

# Pinned upstream binaries; the runtime is mounted read-only in the web service.
runtime_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/tools/jplag"
mkdir -p "$runtime_dir"
install_stage=$(mktemp -d "$runtime_dir/.install-XXXXXX")
trap 'rm -rf -- "$install_stage"' EXIT
download_asset() {
  local url=$1 size=$2 output=$3 parts=16 chunk start end part
  chunk=$(((size + parts - 1) / parts))
  local pids=() failed=0
  for ((part=0; part<parts; part++)); do
    start=$((part * chunk))
    end=$((start + chunk - 1))
    if ((end >= size)); then end=$((size - 1)); fi
    curl -fsSL --retry 4 --connect-timeout 20 --max-time 1800 \
      -H 'Accept: application/octet-stream' --range "$start-$end" \
      "$url?part=$part" -o "$output.part-$part" &
    pids+=("$!")
  done
  for part in "${pids[@]}"; do wait "$part" || failed=1; done
  if ((failed)); then return 1; fi
  # Assembly of downloaded binary parts; checksums below validate the artifact.
  for ((part=0; part<parts; part++)); do cat "$output.part-$part"; done > "$output"
}
download_asset 'https://api.github.com/repos/jplag/JPlag/releases/assets/327397664' 83582176 "$install_stage/jplag.jar"
printf '%s  %s\n' 5f2c21e8b88ed77134effcb3a5a3ab13d188f6a3e16d401387f7479e92db9aa2 "$install_stage/jplag.jar" | sha256sum -c -
download_asset 'https://api.github.com/repos/adoptium/temurin25-binaries/releases/assets/523665086' 141329719 "$install_stage/jdk.tar.gz"
printf '%s  %s\n' dbb698396d478e7fa2b1e50f4103324b2a99b90569ee27c33f2261f9215cf41e "$install_stage/jdk.tar.gz" | sha256sum -c -
mkdir "$install_stage/jdk"
tar -xzf "$install_stage/jdk.tar.gz" -C "$install_stage/jdk" --strip-components=1
if [[ -e "$runtime_dir/jdk" ]]; then
  echo 'JDK already installed; keeping existing runtime.'
else
  mv "$install_stage/jdk" "$runtime_dir/jdk"
fi
mv "$install_stage/jplag.jar" "$runtime_dir/jplag.jar"
"$runtime_dir/jdk/bin/java" -jar "$runtime_dir/jplag.jar" --help >/dev/null
echo 'JPlag 6.3.0 and Java 25 installed and verified.'
