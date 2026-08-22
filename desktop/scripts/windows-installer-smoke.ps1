$ErrorActionPreference = "Stop"

$installer = Get-ChildItem -Path (Join-Path $PSScriptRoot "..\release") -Filter "Mboo-Code-*-win-x64.exe" -File | Select-Object -First 1
if (-not $installer) {
  throw "找不到 Windows x64 NSIS 安装包"
}

$installDirectory = Join-Path $env:RUNNER_TEMP "mboo-code-installed"
$appDataRoot = Join-Path $env:RUNNER_TEMP "mboo-code-appdata"
$appDirectory = Join-Path $installDirectory "Mboo Code.exe"
$uninstaller = Join-Path $installDirectory "Uninstall Mboo Code.exe"

Remove-Item -Path $installDirectory, $appDataRoot -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $appDataRoot | Out-Null

Write-Host "Installing $($installer.FullName)"
$installProcess = Start-Process -FilePath $installer.FullName -ArgumentList @("/S", "/D=`"$installDirectory`"") -Wait -PassThru
if ($installProcess.ExitCode -ne 0) {
  throw "NSIS 安装失败，退出码：$($installProcess.ExitCode)"
}
if (-not (Test-Path -LiteralPath $appDirectory)) {
  throw "安装完成后找不到 Mboo Code.exe：$appDirectory"
}

$originalAppData = $env:APPDATA
$env:APPDATA = $appDataRoot
try {
  Write-Host "Starting $appDirectory"
  $appProcess = Start-Process -FilePath $appDirectory -PassThru
  $startupLog = Wait-ForStartupLog -RootDirectory $appDataRoot -ProcessId $appProcess.Id
  if (-not (Select-String -Path $startupLog -Pattern "phase=ready" -Quiet)) {
    throw "桌面服务未进入 ready：$startupLog"
  }

  Write-Host "Killing the application process tree"
  & taskkill.exe /PID $appProcess.Id /T /F | Out-Null
  Wait-ForProcessTreeExit -RootProcessId $appProcess.Id
} finally {
  if ($null -eq $originalAppData) {
    Remove-Item Env:APPDATA -ErrorAction SilentlyContinue
  } else {
    $env:APPDATA = $originalAppData
  }
}

if (-not (Test-Path -LiteralPath $uninstaller)) {
  throw "安装目录缺少卸载程序：$uninstaller"
}

Write-Host "Uninstalling from $installDirectory"
$uninstallProcess = Start-Process -FilePath $uninstaller -ArgumentList "/S" -Wait -PassThru
if ($uninstallProcess.ExitCode -ne 0) {
  throw "NSIS 卸载失败，退出码：$($uninstallProcess.ExitCode)"
}
if (Test-Path -LiteralPath $appDirectory) {
  throw "卸载完成后主程序仍存在：$appDirectory"
}

Write-Host "Windows installer smoke test passed"

function Wait-ForStartupLog {
  param(
    [Parameter(Mandatory = $true)][string]$RootDirectory,
    [Parameter(Mandatory = $true)][int]$ProcessId
  )

  for ($attempt = 0; $attempt -lt 90; $attempt++) {
    if (-not (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)) {
      throw "Mboo Code 在启动完成前退出，PID：$ProcessId"
    }
    $log = Get-ChildItem -Path $RootDirectory -Filter "desktop-startup.log" -File -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($log) {
      return $log.FullName
    }
    Start-Sleep -Seconds 1
  }
  throw "90 秒内未找到 desktop-startup.log：$RootDirectory"
}

function Wait-ForProcessTreeExit {
  param(
    [Parameter(Mandatory = $true)][int]$RootProcessId
  )

  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    $root = Get-Process -Id $RootProcessId -ErrorAction SilentlyContinue
    $java = Get-Process -Name "java" -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "*Mboo Code*" }
    $node = Get-Process -Name "node" -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "*Mboo Code*" }
    if (-not $root -and -not $java -and -not $node) {
      return
    }
    Start-Sleep -Seconds 1
  }
  throw "应用进程树未在 30 秒内清理：PID $RootProcessId"
}
