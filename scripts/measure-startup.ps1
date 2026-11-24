param([Parameter(Mandatory = $true)][string]$Executable)
$ErrorActionPreference = 'Stop'
$executablePath = (Resolve-Path -LiteralPath $Executable).Path
$root = Join-Path (Get-Location).Path ('test-startup-' + [Guid]::NewGuid().ToString())
$profile = Join-Path $root 'profile'
New-Item -ItemType Directory -Path $profile -Force | Out-Null
$mainId = $null
$launcher = $null
try {
  $watch = [Diagnostics.Stopwatch]::StartNew()
  $launcher = Start-Process -FilePath $executablePath -ArgumentList "--user-data-dir=$profile" -PassThru
  for ($attempt = 0; $attempt -lt 200; $attempt++) {
    $candidates = Get-CimInstance Win32_Process -Filter "Name = 'Demo Simulator.exe'" | Where-Object { $_.CommandLine -like "*$profile*" }
    foreach ($candidate in $candidates) {
      $process = Get-Process -Id $candidate.ProcessId -ErrorAction SilentlyContinue
      if ($process -and $process.MainWindowTitle -eq 'Demo Simulator' -and $process.Responding) {
        $mainId = $process.Id
        $watch.Stop()
        Write-Output ("Responsive window: {0} ms - {1}" -f $watch.ElapsedMilliseconds, $executablePath)
        break
      }
    }
    if ($mainId) { break }
    Start-Sleep -Milliseconds 50
  }
  if (-not $mainId) { throw 'No responsive demo editor appeared within the measurement window.' }
} finally {
  if ($mainId) {
    $process = Get-Process -Id $mainId -ErrorAction SilentlyContinue
    if ($process) { $process.CloseMainWindow() | Out-Null }
    Start-Sleep -Milliseconds 500
    Stop-Process -Id $mainId -Force -ErrorAction SilentlyContinue
  }
  if ($launcher) { Stop-Process -Id $launcher.Id -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Milliseconds 250
  Remove-Item -LiteralPath $root -Recurse -Force
}
