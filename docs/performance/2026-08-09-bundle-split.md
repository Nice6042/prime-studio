# Bundle split measurements

The production build is measured from Vite's Rollup manifest. The measurement
starts at the HTML entry, follows only static imports for the initial closure,
and measures each reachable dynamic-import closure separately. Counts are exact
JavaScript byte lengths and Node gzipSync byte lengths.

| Metric | Before | After | Budget |
| --- | ---: | ---: | ---: |
| Initial static closure, raw bytes | 632368 | 245366 | 500000 |
| Initial static closure, gzip bytes | 195509 | 78502 | 194560 |

The initial closure decreased by 387002 raw bytes and 117007 gzip bytes.

## Lazy entry closures after the split

| Dynamic entry | Raw bytes | Gzip bytes | Gzip budget |
| --- | ---: | ---: | ---: |
| Markdown | 335777 | 102017 | 122880 |
| Artifacts, including shared Markdown | 337798 | 102931 | 122880 |
| Palette | 2268 | 1137 | 122880 |
| Settings | 33756 | 10888 | 122880 |
| Usage | 8483 | 2874 | 122880 |
| Fleet | 8118 | 3014 | 122880 |

These after-values describe the checked-in bundle configuration. From the repository
root, the following PowerShell command rebuilds the production assets and fails if the
entry/closure measurements drift:

```powershell
Push-Location app
try {
  npm run build
  if ($LASTEXITCODE -ne 0) { throw 'Production build failed' }
  $report = npm run --silent measure:bundle | ConvertFrom-Json
  if ($LASTEXITCODE -ne 0) { throw 'Bundle measurement failed' }
  $actual = [ordered]@{
    initial = @([int64]$report.initial.rawBytes, [int64]$report.initial.gzipBytes)
    lazy = @($report.lazy | ForEach-Object {
      [ordered]@{
        entry = $_.entry
        rawBytes = [int64]$_.rawBytes
        gzipBytes = [int64]$_.gzipBytes
      }
    })
  }
  $expected = [ordered]@{
    initial = @(245366, 78502)
    lazy = @(
      [ordered]@{ entry = 'src/Markdown.tsx'; rawBytes = 335777; gzipBytes = 102017 },
      [ordered]@{ entry = 'src/components/Artifacts.tsx'; rawBytes = 337798; gzipBytes = 102931 },
      [ordered]@{ entry = 'src/components/Palette.tsx'; rawBytes = 2268; gzipBytes = 1137 },
      [ordered]@{ entry = 'src/components/Settings.tsx'; rawBytes = 33756; gzipBytes = 10888 },
      [ordered]@{ entry = 'src/components/Usage.tsx'; rawBytes = 8483; gzipBytes = 2874 },
      [ordered]@{ entry = 'src/components/Fleet.tsx'; rawBytes = 8118; gzipBytes = 3014 }
    )
  }
  if (($actual | ConvertTo-Json -Depth 4 -Compress) -ne
      ($expected | ConvertTo-Json -Depth 4 -Compress)) {
    throw 'Bundle evidence differs from the pinned integrated measurement'
  }
  npm run test:bundle
  if ($LASTEXITCODE -ne 0) { throw 'Bundle measurement tests failed' }
} finally {
  Pop-Location
}
```

The build retains Vite's default chunk warning threshold. It enables only the
manifest required for entry-closure measurement.
