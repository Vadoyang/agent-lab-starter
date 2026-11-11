#Requires -Version 5.1
<#
.SYNOPSIS
  AI Agent 治理藍隊實驗環境：Windows 端的佈署前檢查（Pre）與佈署後驗收（Post）

.DESCRIPTION
  給人看，也給自動化佈署代理（例如 Codex）當「完成證據」。每一項檢查都輸出：
  id、說明、是否必要、結果（pass/fail/warn/skip）、證據。結果同時寫成 JSON 檔。

  -Stage Pre   只讀取、不做任何變更：Windows 版本、虛擬化、記憶體、磁碟、WSL 狀態、
               是否待重新開機、是否已裝 Docker Desktop、模型主機連不連得到、下載來源連不連得到。
  -Stage Post  Windows 端（.wslconfig、systemd、防火牆、排程工作、入口網站可連）
               ＋呼叫 WSL 內的 ./lab.sh verify（環境本身的逐項驗收），合併成一份報告。

.PARAMETER Stage
  Pre 或 Post。

.PARAMETER LlmUrl
  模型服務位址（例如 http://192.168.1.50:11434），Pre 會測試連線，Post 不需要。

.PARAMETER WithModel
  Post 時另外跑一次良性冒煙測試（需要模型在線）。

.PARAMETER Report
  報告 JSON 的輸出路徑，預設寫在本資料夾：deploy-report-<stage>.json。

.EXAMPLE
  .\verify-windows.ps1 -Stage Pre -LlmUrl http://192.168.1.50:11434
  .\verify-windows.ps1 -Stage Post -WithModel

.NOTES
  〔待實機驗證〕本檔尚未在實體 Windows 11 主機上執行過。
  Pre 不需要系統管理員權限；Post 的防火牆與排程工作查詢在非管理員下可能讀不到，會標成 warn。
#>
param(
  [ValidateSet("Pre", "Post")][string]$Stage = "Pre",
  [string]$LlmUrl = "",
  [switch]$WithModel,
  [string]$Distro = "Ubuntu-24.04",
  [string]$Report = ""
)

$ErrorActionPreference = "Continue"
$env:WSL_UTF8 = "1"
$LinuxDir = "/root/agent-lab-starter"
$Ports = @(8080, 3000, 8443)
$checks = New-Object System.Collections.ArrayList
if (-not $Report) { $Report = Join-Path $PSScriptRoot ("deploy-report-" + $Stage.ToLower() + ".json") }

function Add-Check($id, $desc, [bool]$required, $result, $evidence) {
  [void]$checks.Add([ordered]@{ id = $id; desc = $desc; required = $required; result = $result; evidence = $evidence })
}
function PF([bool]$ok) { if ($ok) { "pass" } else { "fail" } }
function Get-Distros {
  $raw = & wsl.exe --list --quiet 2>$null
  if ($LASTEXITCODE -ne 0 -or -not $raw) { return @() }
  return @($raw | ForEach-Object { ($_ -replace "`0", "").Trim() } | Where-Object { $_ })
}
function Test-Tcp($hostName, [int]$port) {
  try {
    $c = New-Object System.Net.Sockets.TcpClient
    $iar = $c.BeginConnect($hostName, $port, $null, $null)
    $ok = $iar.AsyncWaitHandle.WaitOne(3000) -and $c.Connected
    $c.Close(); return $ok
  } catch { return $false }
}
function Get-LanIp {
  $ip = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
         Where-Object { $_.IPAddress -notmatch '^(127|169\.254)\.' -and $_.PrefixOrigin -ne 'WellKnown' } |
         Select-Object -First 1).IPAddress
  return $ip
}
function Test-Http($url) {
  try {
    $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 10
    return @{ ok = ($r.StatusCode -lt 400); status = $r.StatusCode }
  } catch { return @{ ok = $false; status = $_.Exception.Message } }
}

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator)

if ($Stage -eq "Pre") {
  # ---------------------------------------------------------------- 佈署前檢查（不做任何變更）
  $os = Get-CimInstance Win32_OperatingSystem
  $build = [int]$os.BuildNumber
  Add-Check "W01" "Windows 11 22H2 以上（組建 ≥ 22621，mirrored 網路需要）" $true (PF ($build -ge 22621)) "$($os.Caption) build $build"
  $cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
  $cs = Get-CimInstance Win32_ComputerSystem
  $virt = $cpu.VirtualizationFirmwareEnabled -or $cs.HypervisorPresent
  Add-Check "W02" "BIOS 已開啟虛擬化（或 Hyper-V 已在執行）" $true (PF $virt) "VirtualizationFirmwareEnabled=$($cpu.VirtualizationFirmwareEnabled) HypervisorPresent=$($cs.HypervisorPresent) CPU=$($cpu.Name) cores=$($cpu.NumberOfCores) threads=$($cpu.NumberOfLogicalProcessors)"
  $memGB = [math]::Round($os.TotalVisibleMemorySize / 1MB)
  Add-Check "W03" "記憶體 ≥ 48 GB（WSL 分 40 GB，Windows 留其餘）" $true (PF ($memGB -ge 48)) "約 $memGB GB"
  $drive = Get-PSDrive -Name ($env:SystemDrive.TrimEnd(':')) -ErrorAction SilentlyContinue
  $freeGB = if ($drive) { [math]::Round($drive.Free / 1GB) } else { 0 }
  Add-Check "W04" "系統碟剩餘空間 ≥ 80 GB（WSL 虛擬磁碟與容器映像）" $true (PF ($freeGB -ge 80)) "$($env:SystemDrive) 剩 $freeGB GB"
  $pending = (Test-Path "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending") -or
             (Test-Path "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired")
  Add-Check "W05" "目前沒有待重新開機的更新" $false $(if ($pending) { "warn" } else { "pass" }) "RebootPending=$pending"
  & wsl.exe --version *> $null
  $wslOk = ($LASTEXITCODE -eq 0)
  $distros = Get-Distros
  Add-Check "W06" "WSL 狀態（未安裝也可以，install-windows.ps1 會裝；首次安裝需重開機）" $false $(if ($wslOk) { "pass" } else { "warn" }) "wsl_installed=$wslOk distros=$($distros -join ',')"
  $dd = Test-Path "$env:ProgramFiles\Docker\Docker\Docker Desktop.exe"
  Add-Check "W07" "沒有安裝 Docker Desktop（避免與 WSL 內的 Docker Engine 搶 docker 指令）" $true (PF (-not $dd)) "docker_desktop_installed=$dd"
  Add-Check "W08" "本資料夾是完整的套件（有 install-windows.ps1 與 install.sh）" $true `
    (PF ((Test-Path (Join-Path $PSScriptRoot "install.sh")) -and (Test-Path (Join-Path $PSScriptRoot "install-windows.ps1")))) "$PSScriptRoot"
  $net = @{}
  foreach ($h in @("download.docker.com", "registry-1.docker.io", "pypi.org", "github.com")) { $net[$h] = Test-Tcp $h 443 }
  Add-Check "W09" "下載來源連得到（Docker、映像檔、Python 套件）" $true (PF (-not ($net.Values -contains $false))) $net
  if ($LlmUrl) {
    try { $u = [Uri]$LlmUrl; $ok = Test-Tcp $u.Host $u.Port } catch { $ok = $false }
    $models = Test-Http ($LlmUrl.TrimEnd('/') + "/v1/models")
    Add-Check "W10" "模型服務連得到（$LlmUrl）" $true (PF ($ok -and $models.ok)) "tcp=$ok /v1/models=$($models.status)"
  } else {
    Add-Check "W10" "模型服務連線（未提供 -LlmUrl，略過）" $false "skip" "未測試"
  }
  Add-Check "W11" "以系統管理員身分執行（install-windows.ps1 需要）" $false $(if ($isAdmin) { "pass" } else { "warn" }) "admin=$isAdmin"
  $busy = @($Ports | Where-Object { Test-Tcp "127.0.0.1" $_ })
  $res = if ($busy.Count -eq 0) { "pass" } elseif ($distros -contains $Distro) { "warn" } else { "fail" }
  Add-Check "W12" "8080／3000／8443 尚未被其他程式占用（重跑安裝時若是本環境自己在用則為 warn）" $true $res "in_use=$($busy -join ',')"
}
else {
  # ---------------------------------------------------------------- 佈署後驗收
  $distros = Get-Distros
  Add-Check "P01" "WSL 發行版 $Distro 已安裝" $true (PF ($distros -contains $Distro)) "distros=$($distros -join ',')"
  $cfgPath = Join-Path $env:USERPROFILE ".wslconfig"
  $cfg = if (Test-Path $cfgPath) { Get-Content $cfgPath -Raw } else { "" }
  Add-Check "P02" ".wslconfig 設定 mirrored 網路、記憶體上限、閒置不關機" $true `
    (PF (($cfg -match 'networkingMode=mirrored') -and ($cfg -match 'memory=') -and ($cfg -match 'vmIdleTimeout=-1'))) "$cfgPath"
  $pid1 = (& wsl.exe --distribution $Distro --user root -- bash -c "ps -p 1 -o comm=" 2>$null | Out-String).Trim()
  Add-Check "P03" "WSL 內 systemd 已啟用（Docker 服務需要）" $true (PF ($pid1 -eq "systemd")) "pid1=$pid1"
  if (Get-Command Get-NetFirewallHyperVRule -ErrorAction SilentlyContinue) {
    $rules = @($Ports | ForEach-Object { [bool](Get-NetFirewallHyperVRule -Name "AgentLab-$_" -ErrorAction SilentlyContinue) })
    $res = if (-not ($rules -contains $false)) { "pass" } elseif (-not $isAdmin) { "warn" } else { "fail" }
    Add-Check "P04" "Hyper-V 防火牆已開 8080／3000／8443（區網連入用）" $true $res "rules=$($rules -join ',') admin=$isAdmin"
  } else {
    Add-Check "P04" "Hyper-V 防火牆指令不存在" $true "warn" "區網其他電腦可能連不到"
  }
  $task = Get-ScheduledTask -TaskName "AgentLab-WSL-Autostart" -ErrorAction SilentlyContinue
  Add-Check "P05" "登入後自動啟動的排程工作已建立" $false $(if ($task) { "pass" } else { "warn" }) "task=$([bool]$task)"
  $local = Test-Http "http://localhost:8080/api/config"
  Add-Check "P06" "本機瀏覽器連得到入口網站（http://localhost:8080）" $true (PF $local.ok) "status=$($local.status)"
  $lan = Get-LanIp
  if ($lan) {
    $l2 = Test-Http "http://${lan}:8080/api/config"
    Add-Check "P07" "用區網 IP 連得到入口網站（http://${lan}:8080；真正的區網測試仍需另一台電腦）" $true (PF $l2.ok) "status=$($l2.status)"
  } else {
    Add-Check "P07" "找不到區網 IP" $true "fail" "Get-NetIPAddress 沒有結果"
  }
  $g = Test-Http "http://localhost:3000/api/health"
  Add-Check "P08" "Grafana 可連（http://localhost:3000）" $true (PF $g.ok) "status=$($g.status)"

  # WSL 內的逐項驗收
  $arg = if ($WithModel) { "--with-model" } else { "" }
  & wsl.exe --distribution $Distro --user root -- bash -lc "cd $LinuxDir && ./lab.sh verify $arg" | Out-Host
  $json = (& wsl.exe --distribution $Distro --user root -- bash -lc "cat $LinuxDir/results/verify-latest.json" 2>$null | Out-String)
  try {
    $inner = $json | ConvertFrom-Json
    foreach ($c in $inner.checks) { Add-Check $c.id $c.desc ([bool]$c.required) $c.result $c.evidence }
  } catch {
    Add-Check "P09" "WSL 內的驗收報告可讀取（$LinuxDir/results/verify-latest.json）" $true "fail" "讀不到或格式錯誤"
  }
}

$failed = @($checks | Where-Object { $_.required -and $_.result -eq "fail" } | ForEach-Object { $_.id })
$warned = @($checks | Where-Object { $_.result -eq "warn" } | ForEach-Object { $_.id })
$out = [ordered]@{
  stage = $Stage
  generated = (Get-Date).ToString("s")
  computer = $env:COMPUTERNAME
  overall = $(if ($failed.Count -eq 0) { "PASS" } else { "FAIL" })
  failed_required = $failed
  warnings = $warned
  checks = $checks
}
$utf8NoBom = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText($Report, ($out | ConvertTo-Json -Depth 6), $utf8NoBom)

foreach ($c in $checks) {
  $mark = $c.result.ToUpper().PadRight(4)
  $req = if ($c.required) { "*" } else { " " }
  $color = switch ($c.result) { "pass" { "Green" } "fail" { "Red" } "warn" { "Yellow" } default { "Gray" } }
  Write-Host "[$mark] $($c.id) $req $($c.desc)" -ForegroundColor $color
}
Write-Host ""
Write-Host "整體：$($out.overall)（* 為必要項）  未通過的必要項：$(if ($failed.Count) { $failed -join ', ' } else { '無' })  警告：$(if ($warned.Count) { $warned -join ', ' } else { '無' })"
Write-Host "報告：$Report"
if ($failed.Count -eq 0) { exit 0 } else { exit 1 }
