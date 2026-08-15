cd app
npm ci
upstream="$RUNNER_TEMP/prime-agent-source-0.7.2"
archive="$RUNNER_TEMP/prime-agent-0.7.2.tgz"
release_root="$RUNNER_TEMP/prime-agent-release-0.7.2"
candidate="$GITHUB_WORKSPACE/app/harness-sidecar/vendor/v0.7.2/prime-daemon-adapter.mjs"
report="$RUNNER_TEMP/prime-adapter-0.7.2.json"
rm -rf "$upstream" "$release_root"
git init "$upstream"
git -C "$upstream" remote add origin https://github.com/PrimeIntellect-ai/prime-agent.git
git -C "$upstream" fetch --depth=1 origin 83a0f9f9566219551fcb6ffaf7f519a815749a58
git -C "$upstream" checkout --detach FETCH_HEAD
npm ci --prefix "$upstream" --ignore-scripts --no-audit --no-fund
npm run --prefix "$upstream" build
curl --fail --location --proto '=https' --tlsv1.2 --max-filesize 33554432 \
  --output "$archive" \
  https://github.com/PrimeIntellect-ai/prime-agent/releases/download/v0.7.2/prime-agent-0.7.2.tgz
echo "bc5471f2a626d727b88a45eb745fff93b10c554a3c4fc5912f25d8c64b987f5e  $archive" | sha256sum --check --strict
mkdir "$release_root"
tar --extract --gzip --file "$archive" --directory "$release_root" --no-same-owner --no-same-permissions
node scripts/audit-reviewed-prime-adapter-candidate.mjs \
  "$release_root/package" \
  0.7.2 \
  sha256:0b45bc86527fcdb73dae76d319f6f50f6d40827a63614303664a57e8fe41c8cf \
  sha256:0555400963ce5c9fa3059c3ed571748715d3ddda3830085eb8f12da00708d49b \
  "$candidate" \
  "$upstream" | tee "$report"
node --input-type=module -e '
  import { readFileSync } from "node:fs";
  const report = JSON.parse(readFileSync(process.argv[1], "utf8"));
  const expectedAdapter = "sha256:d2b986eb7aeba9dedb1d86d0f4a0b76399d59bbcadfae836360245dd5340c721";
  const expectedLegal = "sha256:069f9fa5fc8d064749505b43d7acabe06bb7431ba2901c3c5444bba8df797404";
  if (report.adapter.digest !== expectedAdapter || report.legal?.digest !== expectedLegal) {
    throw new Error(`reviewed adapter evidence changed: ${JSON.stringify(report)}`);
  }
' "$report"
echo "d2b986eb7aeba9dedb1d86d0f4a0b76399d59bbcadfae836360245dd5340c721  $candidate" | sha256sum --check --strict
echo "069f9fa5fc8d064749505b43d7acabe06bb7431ba2901c3c5444bba8df797404  $candidate.LEGAL.txt" | sha256sum --check --strict
