# start-edge.ps1 — launch Edge with CDP debug port and open BOSS Zhipin job search.
# Usage: .\start-edge.ps1 [-Port 9335] [-City 101280600]
param(
  [int]$Port = 9335,
  [string]$City = '101280600'
)
$edge = @(
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $edge) { Write-Error "Edge not found. Install Edge or edit this script to point at Chrome."; exit 1 }
$profile = Join-Path $env:LOCALAPPDATA "boss-autoply-profile"
$url = "https://www.zhipin.com/web/geek/jobs?query=HRBP&city=$City"
Start-Process -FilePath $edge -ArgumentList "--remote-debugging-port=$Port", "--user-data-dir=$profile", "--no-first-run", $url
Write-Host "Edge launched with CDP on :$Port. Scan-login once, then run: node zp_daily.js"
