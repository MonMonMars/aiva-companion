$ErrorActionPreference = 'Continue'
$root = "c:\Users\Simon Lai\WorkBuddy\2026-09-18-15-55-01\llm-companion"
$out = Join-Path $root "public\espeakng"
New-Item -ItemType Directory -Force -Path $out | Out-Null
$log = Join-Path $root "espeak_fetch.log"
"start $(Get-Date)" | Set-Content $log

# steveseguin/espeakng.js 提供 SimpleTTS 包装器（espeakng-simple.js）与原始 eSpeakNG（espeakng.min.js）。
# 两者共用 espeakng.worker.js + espeakng.worker.data，且 worker 必须同源托管。
$baseUrls = @(
  "https://cdn.jsdelivr.net/gh/steveseguin/espeakng.js@main/",
  "https://cdn.jsdelivr.net/gh/steveseguin/espeakng.js@master/",
  "https://raw.githubusercontent.com/steveseguin/espeakng.js/main/"
)
$files = @("espeakng-simple.js", "espeakng.min.js", "espeakng.worker.js", "espeakng.worker.data")

foreach ($f in $files) {
  $ok = $false
  foreach ($b in $baseUrls) {
    $url = $b + $f
    $dest = Join-Path $out $f
    try {
      Invoke-WebRequest -Uri $url -OutFile $dest -TimeoutSec 180 -UseBasicParsing -ErrorAction Stop
      $sz = (Get-Item $dest -ErrorAction SilentlyContinue).Length
      "OK   $f  <- $url  ($sz bytes)" | Tee-Object -Append -FilePath $log
      $ok = $true
      break
    } catch {
      "FAIL $f  $url  $($_.Exception.Message)" | Tee-Object -Append -FilePath $log
    }
  }
  if (-not $ok) { "ALLFAIL $f" | Tee-Object -Append -FilePath $log }
}
"done $(Get-Date)" | Tee-Object -Append -FilePath $log
