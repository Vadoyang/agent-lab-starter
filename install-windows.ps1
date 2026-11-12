#Requires -RunAsAdministrator
<#
.SYNOPSIS
  AI Agent 治理藍隊實驗環境：Windows 11 Pro 一鍵安裝（WSL2 + Ubuntu 24.04 + 開源 Docker Engine）

.DESCRIPTION
  在 Windows 11 上建立一個 WSL2 Linux 環境，把整套實驗環境裝在裡面：
    1. 檢查 Windows 版本（需要 Windows 11 22H2 以上，才能用 mirrored 網路模式）
    2. 安裝或更新 WSL（第一次安裝需要重新開機，開機後再執行一次本腳本）
    3. 寫入 %USERPROFILE%\.wslconfig：記憶體上限、mirrored 網路、VM 與發行版不自動關閉
    4. 安裝 Ubuntu 24.04，開啟 systemd（Docker 服務需要）
    5. 開 Hyper-V 防火牆的入口網站、Grafana、Wazuh 三個埠，讓區網其他電腦連得到
    6. 把本資料夾複製進 WSL 的 Linux 檔案系統（放在 /mnt/c 下效能差，且權限不對）
    7. 在 WSL 裡執行 install.sh（Docker 選「自動安裝」：裝的是開源 Docker Engine，不是 Docker Desktop）
    8. 建立登入後自動啟動 WSL 的排程工作，讓容器在重開機後回來

  為什麼不用 Docker Desktop：Docker Desktop 對大型組織需要付費授權，且本身不是開源軟體；
  本計畫限定開源工具，所以在 WSL 裡直接裝 Docker Engine。

.PARAMETER Distro
  WSL 發行版名稱，預設 Ubuntu-24.04。

.PARAMETER Memory
  給 WSL 虛擬機的記憶體上限，預設 40GB（64 GB 主機留約 24 GB 給 Windows）。

.PARAMETER InstallArgs
  轉交給 install.sh 的參數，例如 '--ollama point --model-url http://192.168.1.50:11434'。

.PARAMETER Update
  只同步程式碼進 WSL（保留 .env、紀錄、憑證、結果）並套用（./lab.sh update），不重跑整個安裝。
  套件換新版、或自動化佈署代理修改了佈署腳本之後使用。

.PARAMETER Reinstall
  WSL 裡已經有 /root/agent-lab-starter 時，先刪掉再重新複製（會連同資料與 .env 一起刪）。

.PARAMETER SkipAutostart
  不建立登入後自動啟動的排程工作。

.EXAMPLE
  # 以系統管理員身分開啟 PowerShell，切到本資料夾後執行：
  Set-ExecutionPolicy -Scope Process Bypass -Force
  .\install-windows.ps1

.EXAMPLE
  .\install-windows.ps1 -InstallArgs '--ollama point --model-url http://192.168.1.50:11434'

.NOTES
  結束代碼：0＝完成；3010＝需要重新開機後重跑；2＝需要人手動完成一步後重跑；1＝失敗。
  自動化佈署（例如 Codex）請帶齊不互動參數，例如：
    -InstallArgs '--yes --docker install --ollama point --model-url http://<DGX>:11434 --model <模型> --host-ip <本機IP>'
  本檔需存成 UTF-8（含 BOM），Windows PowerShell 5.1 才能正確顯示中文。
  標示〔待實機驗證〕的步驟尚未在實體 Windows 主機上驗證過。
#>
param(
  [string]$Distro = "Ubuntu-24.04",
  [string]$Memory = "40GB",
  [string]$InstallArgs = "",
  [switch]$Reinstall,
  [switch]$Update,
  [switch]$SkipAutostart
)

$ErrorActionPreference = "Stop"
# 完整安裝紀錄：給人與自動化佈署代理（Codex）回頭查錯
$LogDir = Join-Path $PSScriptRoot "deploy-logs"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$Transcript = Join-Path $LogDir ("install-windows-" + (Get-Date -Format "yyyyMMdd-HHmmss") + ".log")
try { Start-Transcript -Path $Transcript -Append | Out-Null } catch { }
$env:WSL_UTF8 = "1"          # 讓 wsl.exe 輸出 UTF-8（舊版是 UTF-16，字串比對會失敗）
$Ports = @(8080, 3000, 8443)  # 入口網站、Grafana、Wazuh dashboard
$LinuxDir = "/root/agent-lab-starter"

function Step($t) { Write-Host ""; Write-Host "== $t" -ForegroundColor Cyan }
function Ok($t)   { Write-Host "  [OK] $t" -ForegroundColor Green }
function Info($t) { Write-Host "  $t" }
function Warn($t) { Write-Host "  [!] $t" -ForegroundColor Yellow }
function Die($t)  {
  Write-Host "  [X] $t" -ForegroundColor Red
  Write-Host "  下一步：.\repair-windows.ps1 -Diagnose（收齊診斷資料），或 .\repair-windows.ps1 -Auto（自動修復）" -ForegroundColor Yellow
  Write-Host "  完整紀錄：$Transcript"
  try { Stop-Transcript | Out-Null } catch { }
  exit 1
}
function Get-SourceStamp {
  # 本資料夾（Windows 端套件）最新的修改時間（epoch 秒），用來判斷 WSL 內是否落後
  $files = Get-ChildItem -Path $PSScriptRoot -Recurse -File -ErrorAction SilentlyContinue |
           Where-Object { $_.FullName -notmatch '\\(deploy-logs|\.git|__pycache__)\\' -and $_.Name -notmatch '^deploy-report' }
  # Windows PowerShell 5.1 的 Measure-Object -Maximum 不接受日期，改用排序
  $newest = ($files | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1).LastWriteTimeUtc
  if (-not $newest) { return 0 }
  return [int64]([DateTimeOffset]$newest).ToUnixTimeSeconds()
}

function Invoke-Wsl {
  # 用 root 在指定發行版執行指令；回傳 exit code
  param([string[]]$Cmd)
  & wsl.exe --distribution $Distro --user root -- @Cmd | Out-Host   # 輸出直接顯示，不混進回傳值
  return $LASTEXITCODE
}

function Write-LfFile($Path, $Text) {
  # Linux 端讀的檔案：LF 換行、UTF-8 無 BOM
  $utf8NoBom = New-Object System.Text.UTF8Encoding $false
  [System.IO.File]::WriteAllText($Path, ($Text -replace "`r`n", "`n"), $utf8NoBom)
}

function Get-Distros {
  $raw = & wsl.exe --list --quiet 2>$null
  if ($LASTEXITCODE -ne 0 -or -not $raw) { return @() }
  return @($raw | ForEach-Object { ($_ -replace "`0", "").Trim() } | Where-Object { $_ })
}

# =============================================================================
Step "第 1 步：檢查 Windows 版本"
# =============================================================================
$os = Get-CimInstance Win32_OperatingSystem
$build = [int]$os.BuildNumber
Info "$($os.Caption)（組建 $build）"
if ($build -lt 22621) {
  Die "需要 Windows 11 22H2（組建 22621）以上才能用 mirrored 網路模式。請先執行 Windows Update。"
}
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
$memGB = [math]::Round($os.TotalVisibleMemorySize / 1MB)
Info "CPU：$($cpu.Name)（$($cpu.NumberOfCores) 核 / $($cpu.NumberOfLogicalProcessors) 執行緒）；記憶體：約 $memGB GB"
if ($memGB -lt 16) { Warn "記憶體少於 16 GB，Wazuh 加上本機模型可能跑不動。" }
Ok "Windows 版本符合。"

# =============================================================================
Step "第 2 步：安裝或更新 WSL"
# =============================================================================
& wsl.exe --version *> $null
if ($LASTEXITCODE -ne 0) {
  Info "這台電腦還沒有 WSL，開始安裝（不含發行版）…"
  & wsl.exe --install --no-distribution
  Warn "WSL 安裝完成後需要重新開機。請重新開機，再以系統管理員身分執行一次本腳本。"
  exit 3010   # 3010＝需要重新開機（Windows 安裝程式慣例），自動化佈署據此停下來請人重開機
}
Info "更新 WSL 到最新版…"
& wsl.exe --update | Out-Host
Ok "WSL 已就緒。"

# =============================================================================
Step "第 3 步：設定 WSL 虛擬機（$env:USERPROFILE\.wslconfig）"
# =============================================================================
$cfg = Join-Path $env:USERPROFILE ".wslconfig"
if (Test-Path $cfg) {
  $bak = "$cfg.bak-$(Get-Date -Format yyyyMMdd-HHmmss)"
  Copy-Item $cfg $bak
  Info "已備份原本的 .wslconfig 到 $bak"
}
# 註解刻意用英文（純 ASCII），避免 .wslconfig 編碼問題。各設定的意思：
#   memory               給 WSL 虛擬機的記憶體上限（預設是 Windows 記憶體的一半）
#   networkingMode       mirrored：WSL 共用 Windows 的網路介面，區網連 Windows 的 IP 就能看到入口網站
#   vmIdleTimeout=-1     虛擬機閒置也不關，直到 wsl --shutdown
#   instanceIdleTimeout  發行版閒置也不關（-1），容器才能一直跑
$wslconfig = @"
# Generated by install-windows.ps1 (AI Agent governance blue-team lab)
[wsl2]
memory=$Memory
networkingMode=mirrored
vmIdleTimeout=-1

[general]
instanceIdleTimeout=-1
"@
[System.IO.File]::WriteAllText($cfg, $wslconfig, (New-Object System.Text.UTF8Encoding $false))
Ok "已寫入 .wslconfig（memory=$Memory、mirrored、不自動關閉）。"

# =============================================================================
Step "第 4 步：安裝 $Distro 並開啟 systemd"
# =============================================================================
if ((Get-Distros) -notcontains $Distro) {
  Info "安裝 $Distro（第一次需要下載，約數百 MB）…"
  & wsl.exe --install --distribution $Distro --no-launch
  if ($LASTEXITCODE -ne 0) { Die "安裝 $Distro 失敗。可以手動執行：wsl --install --distribution $Distro" }
  Start-Sleep -Seconds 3
}
if ((Get-Distros) -notcontains $Distro) {
  # 〔待實機驗證〕部分版本的 --no-launch 不會註冊發行版，需要先啟動一次
  Warn "還看不到 $Distro。請在開始功能表打開「Ubuntu 24.04」完成第一次設定（建立帳號），關掉視窗後再執行一次本腳本。"
  exit 2      # 2＝需要人手動完成一個步驟後重跑
}
Ok "$Distro 已安裝。"

$tmp = Join-Path $env:TEMP "agentlab-wslconf.sh"
Write-LfFile $tmp @'
set -e
if ! grep -q '^systemd=true' /etc/wsl.conf 2>/dev/null; then
  printf '\n[boot]\nsystemd=true\n' >> /etc/wsl.conf
fi
cat /etc/wsl.conf
'@
$tmpLinux = (& wsl.exe --distribution $Distro --user root -- wslpath -a "$tmp").Trim()
if ((Invoke-Wsl @("bash", $tmpLinux)) -ne 0) { Die "寫入 /etc/wsl.conf 失敗。" }
Info "重新啟動 WSL，讓 .wslconfig 與 systemd 生效…"
& wsl.exe --shutdown
Start-Sleep -Seconds 10       # 微軟文件：設定變更需等 WSL 完全停止（8 秒規則）
$sd = (& wsl.exe --distribution $Distro --user root -- bash -c "ps -p 1 -o comm=").Trim()
if ($sd -eq "systemd") { Ok "systemd 已啟用。" } else { Warn "PID 1 是 '$sd'，不是 systemd；Docker 可能無法自動啟動。" }

# =============================================================================
Step "第 5 步：開放防火牆埠（$($Ports -join '、')）"
# =============================================================================
# mirrored 模式下，從區網連進 WSL 受 Hyper-V 防火牆管理（微軟 WSL 網路文件的做法）
$wslVmCreator = "{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}"
if (Get-Command New-NetFirewallHyperVRule -ErrorAction SilentlyContinue) {
  foreach ($p in $Ports) {
    $name = "AgentLab-$p"
    if (-not (Get-NetFirewallHyperVRule -Name $name -ErrorAction SilentlyContinue)) {
      New-NetFirewallHyperVRule -Name $name -DisplayName "AgentLab $p" -Direction Inbound `
        -VMCreatorId $wslVmCreator -Protocol TCP -LocalPorts $p | Out-Null
    }
  }
  Ok "已建立 Hyper-V 防火牆規則：AgentLab-8080／3000／8443。"
} else {
  Warn "這台 Windows 沒有 Hyper-V 防火牆指令；本機瀏覽器可以用，但區網其他電腦可能連不到。"
}
Info "只開這三個埠給區網。這是實驗環境，請勿讓它直接面對網際網路。"

# =============================================================================
Step "第 6 步：把環境複製進 WSL（$LinuxDir）"
# =============================================================================
$src = $PSScriptRoot
if (-not (Test-Path (Join-Path $src "install.sh"))) { Die "找不到 install.sh。請在 agent-lab-starter 資料夾內執行本腳本。" }
$srcLinux = (& wsl.exe --distribution $Distro --user root -- wslpath -a "$src").Trim()
$exists = (Invoke-Wsl @("test", "-d", $LinuxDir)) -eq 0
$stamp = Get-SourceStamp
if ($exists -and -not $Reinstall) {
  # 已安裝過：同步程式碼，但保留使用者的設定與資料（.env、紀錄、憑證、結果、工作佇列）
  Info "WSL 裡已經有 $LinuxDir：同步程式碼（保留 .env、logs、results、jobs、憑證）…"
  $sync = Join-Path $env:TEMP "agentlab-sync.sh"
  Write-LfFile $sync @"
set -e
SRC='$srcLinux'
DST='$LinuxDir'
cd "`$SRC"
tar --exclude=./.env --exclude=./.host_ip --exclude=./logs --exclude=./results --exclude=./jobs \
    --exclude=./deploy-logs --exclude=./.git --exclude='./config/wazuh_indexer_ssl_certs/*' \
    --exclude='*/__pycache__' -cf - . | tar -C "`$DST" -xf -
cd "`$DST"
grep -rlIZ `$'\r' --exclude-dir=.git --exclude-dir=logs --exclude-dir=results --exclude='*.ps1' . | xargs -0 -r sed -i 's/\r`$//'
chmod +x ./*.sh tools/*.py config/wazuh_integrations/custom-soar 2>/dev/null || true
echo $stamp > .synced_src_mtime
echo "synced to `$DST"
"@
  $syncLinux = (& wsl.exe --distribution $Distro --user root -- wslpath -a "$sync").Trim()
  if ((Invoke-Wsl @("bash", $syncLinux)) -ne 0) { Die "同步程式碼失敗。" }
  Ok "程式碼已同步到 WSL 的 $LinuxDir。"
} else {
  $copy = Join-Path $env:TEMP "agentlab-copy.sh"
  Write-LfFile $copy @"
set -e
SRC='$srcLinux'
DST='$LinuxDir'
if [ -d "`$DST" ]; then
  ( cd "`$DST" && [ -x ./uninstall.sh ] && ./uninstall.sh --full --yes ) || true
  rm -rf "`$DST"
fi
mkdir -p "`$DST"
cp -a "`$SRC/." "`$DST/"
rm -rf "`$DST/deploy-logs"
cd "`$DST"
# 從 Windows 下載或用 git 取出時可能變成 CRLF 換行，Linux 腳本會壞掉：所有文字檔（.ps1 除外）一律轉回 LF
grep -rlIZ `$'\r' --exclude-dir=.git --exclude='*.ps1' . | xargs -0 -r sed -i 's/\r`$//'
chmod +x ./*.sh tools/*.py config/wazuh_integrations/custom-soar 2>/dev/null || true
echo $stamp > .synced_src_mtime
echo "copied to `$DST"
"@
  $copyLinux = (& wsl.exe --distribution $Distro --user root -- wslpath -a "$copy").Trim()
  if ((Invoke-Wsl @("bash", $copyLinux)) -ne 0) { Die "複製失敗。" }
  Ok "已複製到 WSL 的 $LinuxDir。"
}

if ($Update) {
  Step "套用更新（./lab.sh update）"
  & wsl.exe --distribution $Distro --user root -- bash -lc "cd $LinuxDir && ./lab.sh update"
  if ($LASTEXITCODE -ne 0) { Die "./lab.sh update 失敗。" }
  Ok "已套用。接著請執行 .\verify-windows.ps1 -Stage Post 驗收。"
  try { Stop-Transcript | Out-Null } catch { }
  exit 0
}

# =============================================================================
Step "第 7 步：在 WSL 裡執行 install.sh"
# =============================================================================
if ($InstallArgs -notmatch '--yes') {
  Info "接下來是 Linux 安裝器的互動畫面。Docker 請選「還沒裝 → 自動安裝」（開源 Docker Engine）。"
}
Info "模型建議選「指向現有模型服務」，填 DGX 的位址；這台主機沒有 GPU，本機跑模型會很慢。"
$cmd = "cd $LinuxDir && ./install.sh $InstallArgs"
& wsl.exe --distribution $Distro --user root -- bash -lc $cmd
if ($LASTEXITCODE -ne 0) { Die "install.sh 沒有成功完成（WSL 內完整紀錄：$LinuxDir/results/install-latest.log）。" }

# =============================================================================
Step "第 8 步：登入後自動啟動（重開機後容器會回來）"
# =============================================================================
if (-not $SkipAutostart) {
  # 〔待實機驗證〕WSL 發行版屬於使用者，所以在「這個使用者登入後」啟動；
  # 啟動後 systemd 會帶起 Docker，容器設定為 restart: unless-stopped 會自己回來。
  $action = New-ScheduledTaskAction -Execute "wsl.exe" -Argument "--distribution $Distro --user root -- bash -c `"systemctl is-active docker >/dev/null || systemctl start docker`""
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 5)
  Register-ScheduledTask -TaskName "AgentLab-WSL-Autostart" -Action $action -Trigger $trigger -Settings $settings `
    -Description "登入後啟動 WSL（AI Agent 治理藍隊實驗環境）" -Force | Out-Null
  Ok "已建立排程工作 AgentLab-WSL-Autostart（登入後執行）。"
}

# =============================================================================
Step "完成"
# =============================================================================
$ip = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
       Where-Object { $_.IPAddress -notmatch '^(127|169\.254)\.' -and $_.PrefixOrigin -ne 'WellKnown' } |
       Select-Object -First 1).IPAddress
if (-not $ip) { $ip = "localhost" }
Write-Host ""
Write-Host "  入口網站（從這裡開始）  http://localhost:8080   區網其他電腦：http://${ip}:8080" -ForegroundColor Green
Write-Host "  Grafana 戰情室          http://localhost:3000"
Write-Host "  Wazuh                   https://localhost:8443（自簽憑證）"
Write-Host ""
Info "操作 PIN 與帳密見上方 install.sh 的完成畫面，或在 WSL 裡看 $LinuxDir/.env。"
Info "日常管理：wsl -d $Distro -u root，然後 cd $LinuxDir; ./lab.sh status"
Info "完整紀錄：$Transcript"
try { Stop-Transcript | Out-Null } catch { }
