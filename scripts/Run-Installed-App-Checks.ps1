param([Parameter(Mandatory=$true)][string]$AppDir)
$ErrorActionPreference = 'Stop'
$KitRoot = $PSScriptRoot
$AppDir = (Resolve-Path $AppDir).Path
$Resources = Join-Path $AppDir 'resources'
$Runtime = Join-Path $Resources 'runtime'
$Node = Join-Path $Runtime 'node\node.exe'
$Python = Join-Path $Runtime 'python\python.exe'
$env:PAPERDESK_TEST_EXECUTABLE = Join-Path $AppDir 'Paperdesk.exe'
$env:PAPERDESK_TEST_RUNTIME = $Runtime
$env:PAPERDESK_TEST_COMPONENTS_DIR = Join-Path $env:LOCALAPPDATA 'Paperdesk\components'
$env:PAPERDESK_BROWSER_MODULE = Join-Path $Runtime 'browser-module\playwright-core'
$env:PAPERDESK_BACKEND_DIR = Join-Path $Resources 'src\backend'
$env:PYTHONUTF8 = '1'
$env:PYTHONTZPATH = Join-Path $Runtime 'tzdata\zoneinfo'
$ResultDir = Join-Path $KitRoot 'build\test-results'
New-Item -ItemType Directory -Force $ResultDir | Out-Null
$SystemInfo = Get-CimInstance Win32_OperatingSystem | Select-Object Caption,Version,BuildNumber,OSArchitecture
$SystemInfo | ConvertTo-Json | Set-Content -Encoding utf8 (Join-Path $ResultDir 'windows-system.json')
& $Python -B (Join-Path $KitRoot 'scripts\smoke-credentials.py')
if ($LASTEXITCODE -ne 0) { throw 'Native credential test failed.' }
& $Node (Join-Path $KitRoot 'scripts\smoke-browsers.cjs')
if ($LASTEXITCODE -ne 0) { throw 'Bundled browser test failed.' }
& $Node (Join-Path $KitRoot 'scripts\smoke-desktop.cjs')
if ($LASTEXITCODE -ne 0) { throw 'Installed app test failed.' }
Write-Host ('Validation passed. Results: ' + $ResultDir)
