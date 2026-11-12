#Requires -Version 5.1
<#
.SYNOPSIS
  AI Agent 治理藍隊實驗環境：Windows 端的診斷與自動修復（給人，也給自動化佈署代理 Codex 使用）

.DESCRIPTION
  -Diagnose   只收集、不修改：跑佈署後驗收（不含模型冒煙測試）＋ WSL 內 ./lab.sh diagnose，
              把兩份報告放到 deploy-logs\，列出建議的修法代碼。
  -Auto       自癒迴圈：驗收 → 依未通過項目的修法代碼套用可自動修的修法 → 再驗收，最多 -MaxRounds 輪。
              同一個修法套用後問題仍在，就不再重試，改列為「需要人」（避免無限迴圈）。
  -Fix <代碼> 只套用一個修法，例如 -Fix WF2。

  修法代碼：
    WF1  啟動 WSL 與 Docker，起齊容器（./lab.sh up）
    WF2  重建 Hyper-V 防火牆規則 AgentLab-8080／3000／8443（需要系統管理員）
    WF3  重建登入後自動啟動的排程工作（需要系統管理員）
    WF4  修正 .wslconfig（保留原記憶體值）並重啟 WSL
    WF5  mirrored 網路無效時的備援：netsh portproxy 轉送三個埠到 WSL（需要系統管理員）
    WF6  把本資料夾的程式碼同步進 WSL 並套用（install-windows.ps1 -Update）
    WF7  開啟 WSL 的 systemd 並重啟 WSL
    WSL  交給 WSL 內的 ./lab.sh repair auto（容器、設定、規則、資料庫密碼、撤銷狀態等）
    M*   需要人：見 deploy\codex\TROUBLESHOOTING.md

  原則：只修佈署層；安全控制（隔離、護欄、政策、規則）未通過一律不自動修（M21）。
  不刪資料、不解除安裝、不重灌發行版。所有動作與輸出摘要寫入 deploy-logs\repair-windows-*.json。

.EXAMPLE
  .\repair-windows.ps1 -Diagnose
  .\repair-windows.ps1 -Auto -WithModel
  .\repair-windows.ps1 -Fix WF5

.NOTES
  〔待實機驗證〕本檔尚未在實體 Windows 11 主機上執行過。
  結束代碼：0＝最後驗收通過；1＝仍有未通過項目（看報告的 needs_human）；2＝參數錯誤。
#>
param(
  [switch]$Diagnose,
  [switch]$Auto,
  [string]$Fix = "",
  [switch]$WithModel,
  [int]$MaxRounds = 3,
  [string]$Distro = "Ubuntu-24.04",
  [string]$Memory = "40GB"
)

$ErrorActionPreference = "Continue"
$env:WSL_UTF8 = "1"
$LinuxDir = "/root/agent-lab-starter"
$Ports = @(8080, 3000, 8443)
$LogDir = Join-Path $PSScriptRoot "deploy-logs"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$Stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$actions = New-Object System.Collections.ArrayList
$isAdmin = $false
try {
  $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
} catch { }
$AutoFixes = @("WF6", "WF7", "WF4", "WF1", "WSL", "WF2", "WF3", "WF5")   # 套用順序
$Fallback = @{ "WF2" = "WF5" }   # WF2 無效（區網仍連不到）時改試 WF5
$utf8NoBom = New-Object System.Text.UTF8Encoding $false

function Log-Action($fix, $what, $rc, $output) {
  $tail = ""
  if ($output) { $tail = ($output | Out-String); if ($tail.Length -gt 800) { $tail = $tail.Substring($tail.Length - 800) } }
  [void]$actions.Add([ordered]@{ fix = $fix; what = $what; rc = $rc; time = (Get-Date).ToString("s"); output_tail = $tail })
  $color = if ($rc -eq 0) { "Green" } else { "Yellow" }
  Write-Host "  [$fix] rc=$rc $what" -ForegroundColor $color
}

function Invoke-WslRoot([string]$cmd, [int]$timeoutSec = 1800) {
  $out = & wsl.exe --distribution $Distro --user root -- bash -lc $cmd 2>&1
  return @{ rc = $LASTEXITCODE; out = ($out | Out-String) }
}

function Wait-Portal([int]$seconds) {
  $end = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $end) {
    $code = (& wsl.exe --distribution $Distro --user root -- bash -c "curl -s -o /dev/null -w '%{http_code}' http://localhost:8080/api/config" 2>$null | Out-String).Trim()
    if ($code -eq "200") { return $true }
    Start-Sleep -Seconds 10
  }
  return $false
}

function Run-Verify([bool]$withModel) {
  $rep = Join-Path $LogDir "verify-post-$Stamp-$(Get-Random -Maximum 9999).json"
  $psArgs = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $PSScriptRoot "verify-windows.ps1"),
              "-Stage", "Post", "-Distro", $Distro, "-Report", $rep)
  if ($withModel) { $psArgs += "-WithModel" }
  & powershell.exe @psArgs | Out-Host
  try { return (Get-Content $rep -Raw -Encoding UTF8 | ConvertFrom-Json) } catch { return $null }
}

function Copy-WslReport([string]$name) {
  $txt = (& wsl.exe --distribution $Distro --user root -- bash -c "cat $LinuxDir/results/$name 2>/dev/null" 2>$null | Out-String)
  if ($txt.Trim()) { [System.IO.File]::WriteAllText((Join-Path $LogDir "wsl-$name"), $txt, $utf8NoBom) }
}

function Ensure-Admin($fix) {
  if (-not $isAdmin) { Log-Action $fix "需要系統管理員權限，未執行（請以系統管理員身分重跑）" 1 $null; return $false }
  return $true
}

function Apply-Fix([string]$fx) {
  switch ($fx) {
    "WF1" {
      $r = Invoke-WslRoot "systemctl start docker; cd $LinuxDir && ./lab.sh up"
      Log-Action $fx "啟動 Docker 並起齊容器（./lab.sh up）" $r.rc $r.out
      $ok = Wait-Portal 240
      Log-Action $fx "等待入口網站在 WSL 內就緒" ($(if ($ok) { 0 } else { 1 })) $null
    }
    "WF2" {
      if (-not (Ensure-Admin $fx)) { return }
      if (-not (Get-Command New-NetFirewallHyperVRule -ErrorAction SilentlyContinue)) {
        Log-Action $fx "這台 Windows 沒有 Hyper-V 防火牆指令（改用 WF5）" 1 $null; return
      }
      foreach ($p in $Ports) {
        $name = "AgentLab-$p"
        Remove-NetFirewallHyperVRule -Name $name -ErrorAction SilentlyContinue | Out-Null
        try {
          New-NetFirewallHyperVRule -Name $name -DisplayName "AgentLab $p" -Direction Inbound `
            -VMCreatorId "{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}" -Protocol TCP -LocalPorts $p -ErrorAction Stop | Out-Null
          Log-Action $fx "重建 Hyper-V 防火牆規則 $name" 0 $null
        } catch { Log-Action $fx "重建 $name 失敗" 1 $_.Exception.Message }
      }
    }
    "WF3" {
      if (-not (Ensure-Admin $fx)) { return }
      try {
        $action = New-ScheduledTaskAction -Execute "wsl.exe" -Argument "--distribution $Distro --user root -- bash -c `"systemctl is-active docker >/dev/null || systemctl start docker`""
        $trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
        $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 5)
        Register-ScheduledTask -TaskName "AgentLab-WSL-Autostart" -Action $action -Trigger $trigger -Settings $settings `
          -Description "登入後啟動 WSL（AI Agent 治理藍隊實驗環境）" -Force -ErrorAction Stop | Out-Null
        Log-Action $fx "重建排程工作 AgentLab-WSL-Autostart" 0 $null
      } catch { Log-Action $fx "重建排程工作失敗" 1 $_.Exception.Message }
    }
    "WF4" {
      $cfg = Join-Path $env:USERPROFILE ".wslconfig"
      $mem = $Memory
      if (Test-Path $cfg) {
        $old = Get-Content $cfg -Raw
        if ($old -match '(?m)^\s*memory\s*=\s*(\S+)') { $mem = $Matches[1] }
        Copy-Item $cfg "$cfg.bak-$Stamp"
      }
      $text = "# Generated by repair-windows.ps1 (AI Agent governance blue-team lab)`n[wsl2]`nmemory=$mem`nnetworkingMode=mirrored`nvmIdleTimeout=-1`n`n[general]`ninstanceIdleTimeout=-1`n"
      [System.IO.File]::WriteAllText($cfg, $text, $utf8NoBom)
      Log-Action $fx "重寫 .wslconfig（memory=$mem、mirrored、不自動關閉；原檔已備份）" 0 $null
      & wsl.exe --shutdown | Out-Null
      Start-Sleep -Seconds 10
      Log-Action $fx "重啟 WSL 讓設定生效（容器會隨 Docker 自動回來）" $LASTEXITCODE $null
      Apply-Fix "WF1"
    }
    "WF5" {
      if (-not (Ensure-Admin $fx)) { return }
      $wslIp = ((& wsl.exe --distribution $Distro --user root -- bash -c "hostname -I" 2>$null | Out-String).Trim() -split '\s+')[0]
      if (-not $wslIp) { Log-Action $fx "取不到 WSL 的 IP" 1 $null; return }
      foreach ($p in $Ports) {
        & netsh interface portproxy delete v4tov4 listenport=$p listenaddress=0.0.0.0 2>$null | Out-Null
        $o = & netsh interface portproxy add v4tov4 listenport=$p listenaddress=0.0.0.0 connectport=$p connectaddress=$wslIp 2>&1
        Log-Action $fx "portproxy 0.0.0.0:$p → ${wslIp}:$p" $LASTEXITCODE $o
        if (-not (Get-NetFirewallRule -DisplayName "AgentLab-PP-$p" -ErrorAction SilentlyContinue)) {
          New-NetFirewallRule -DisplayName "AgentLab-PP-$p" -Direction Inbound -Protocol TCP -LocalPort $p `
            -Action Allow -Profile Private,Domain -ErrorAction SilentlyContinue | Out-Null
          Log-Action $fx "Windows 防火牆允許 $p（僅私人／網域網路）" 0 $null
        }
      }
      # NAT 模式下 WSL 的 IP 每次開機會變：登入後自動重設 portproxy
      Set-Content -Path (Join-Path $LogDir "portproxy-mode") -Value $wslIp -Encoding UTF8
      try {
        $a = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Fix WF5"
        $t = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
        $t.Delay = "PT1M"
        Register-ScheduledTask -TaskName "AgentLab-PortProxy-Refresh" -Action $a -Trigger $t -RunLevel Highest -Force -ErrorAction Stop | Out-Null
        Log-Action $fx "建立排程工作 AgentLab-PortProxy-Refresh（登入後更新轉送目標）" 0 $null
      } catch { Log-Action $fx "建立 portproxy 更新排程失敗" 1 $_.Exception.Message }
    }
    "WF6" {
      $o = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "install-windows.ps1") -Update -Distro $Distro 2>&1
      Log-Action $fx "同步程式碼進 WSL 並套用（install-windows.ps1 -Update）" $LASTEXITCODE $o
    }
    "WF7" {
      $r = Invoke-WslRoot "grep -q '^systemd=true' /etc/wsl.conf 2>/dev/null || printf '\n[boot]\nsystemd=true\n' >> /etc/wsl.conf"
      Log-Action $fx "開啟 WSL systemd（/etc/wsl.conf）" $r.rc $r.out
      & wsl.exe --shutdown | Out-Null
      Start-Sleep -Seconds 10
      Apply-Fix "WF1"
    }
    "WSL" {
      $r = Invoke-WslRoot "cd $LinuxDir && ./lab.sh repair auto"
      Log-Action $fx "WSL 內自動修復（./lab.sh repair auto）" $r.rc $r.out
      Copy-WslReport "repair-latest.json"
      Copy-WslReport "diagnose-latest.json"
    }
    default { Log-Action $fx "不是可自動套用的修法（見 TROUBLESHOOTING.md）" 2 $null }
  }
}

function Failing($rep) {
  if (-not $rep) { return @() }
  return @($rep.checks | Where-Object { $_.result -eq "fail" -or ($_.result -eq "warn" -and $_.fix -like "WF*") })
}

function Write-Report($before, $after, $ineffective, $mode) {
  $needs = @()
  if ($after) {
    $needs = @(Failing $after | Where-Object { $_.fix -and ($AutoFixes -notcontains $_.fix -or $ineffective -contains $_.fix) } |
               ForEach-Object { "$($_.id):$($_.fix)" })
  }
  $out = [ordered]@{
    generated = (Get-Date).ToString("s"); mode = $mode; computer = $env:COMPUTERNAME; admin = $isAdmin
    before = @(Failing $before | ForEach-Object { "$($_.id):$($_.fix)" })
    after = @(Failing $after | ForEach-Object { "$($_.id):$($_.fix)" })
    result = $(if ($after -and $after.overall -eq "PASS") { "PASS" } else { "FAIL" })
    ineffective_fixes = @($ineffective); needs_human = $needs; actions = $actions
    wsl_reports = @("deploy-logs\wsl-diagnose-latest.json", "deploy-logs\wsl-repair-latest.json")
  }
  $p = Join-Path $LogDir "repair-windows-$Stamp.json"
  $json = $out | ConvertTo-Json -Depth 6
  [System.IO.File]::WriteAllText($p, $json, $utf8NoBom)
  [System.IO.File]::WriteAllText((Join-Path $LogDir "repair-windows-latest.json"), $json, $utf8NoBom)
  Write-Host ""
  Write-Host "結果：$($out.result)  仍未通過：$(if ($out.after.Count) { $out.after -join ', ' } else { '無' })"
  if ($ineffective.Count) { Write-Host "套用後無效、不再重試的修法：$($ineffective -join ', ')" -ForegroundColor Yellow }
  if ($needs.Count) { Write-Host "需要人或換方法：$($needs -join ', ')（見 deploy\codex\TROUBLESHOOTING.md）" -ForegroundColor Yellow }
  Write-Host "報告：$p"
  return $out.result
}

# ============================================================================ 主流程
if (-not ($Diagnose -or $Auto -or $Fix)) { Get-Help $PSCommandPath -Detailed; exit 2 }

if ($Diagnose) {
  Write-Host "== 診斷（不修改）" -ForegroundColor Cyan
  $v = Run-Verify $false
  $r = Invoke-WslRoot "cd $LinuxDir && ./lab.sh diagnose"
  Write-Host $r.out
  Copy-WslReport "diagnose-latest.json"
  Copy-WslReport "verify-latest.json"
  $res = Write-Report $v $v @() "diagnose"
  Write-Host "建議修法：$(@($v.fixes_suggested) -join ', ')"
  if ($res -eq "PASS") { exit 0 } else { exit 1 }
}

if ($Fix) {
  if ($AutoFixes -notcontains $Fix) { Write-Host "$Fix 不是可自動套用的修法。可用：$($AutoFixes -join ', ')"; exit 2 }
  Write-Host "== 套用修法 $Fix" -ForegroundColor Cyan
  $before = Run-Verify $false
  Apply-Fix $Fix
  $after = Run-Verify $WithModel.IsPresent
  $res = Write-Report $before $after @() "fix:$Fix"
  if ($res -eq "PASS") { exit 0 } else { exit 1 }
}

# -Auto：自癒迴圈
Write-Host "== 自動修復（最多 $MaxRounds 輪）" -ForegroundColor Cyan
$before = Run-Verify $false
$rep = $before
$tried = @{}
$ineffective = @()
for ($round = 1; $round -le $MaxRounds; $round++) {
  $fail = Failing $rep
  if ($fail.Count -eq 0) { break }
  # 上一輪套用過、但對應項目仍失敗 → 判定無效
  foreach ($k in @($tried.Keys)) {
    $still = @($fail | Where-Object { ($_.fix -eq $k -or ($_.fix -and $Fallback.ContainsKey($_.fix) -and $Fallback[$_.fix] -eq $k)) -and $tried[$k] -contains $_.id })
    if ($still.Count -and $ineffective -notcontains $k) { $ineffective += $k }
  }
  $todo = @()
  foreach ($fx in $AutoFixes) {
    if ($ineffective -contains $fx) { continue }
    if (@($fail | Where-Object { $_.fix -eq $fx }).Count) { $todo += $fx }
  }
  foreach ($fx in @($Fallback.Keys)) {
    if ($ineffective -contains $fx -and $ineffective -notcontains $Fallback[$fx] -and $todo -notcontains $Fallback[$fx] -and
        @($fail | Where-Object { $_.fix -eq $fx }).Count) { $todo += $Fallback[$fx] }
  }
  if ($todo.Count -eq 0) { break }
  Write-Host ""
  Write-Host "第 $round 輪：$($todo -join ', ')" -ForegroundColor Cyan
  foreach ($fx in $todo) {
    $tried[$fx] = @($fail | Where-Object { $_.fix -eq $fx -or ($_.fix -and $Fallback.ContainsKey($_.fix) -and $Fallback[$_.fix] -eq $fx) } | ForEach-Object { $_.id })
    Apply-Fix $fx
  }
  Start-Sleep -Seconds 15
  $rep = Run-Verify $false
}
if ($WithModel -and $rep -and $rep.overall -eq "PASS") { $rep = Run-Verify $true }
Copy-WslReport "diagnose-latest.json"
$res = Write-Report $before $rep $ineffective "auto"
if ($res -eq "PASS") { exit 0 } else { exit 1 }
