# AgentLab one-line installer for Windows 11 Pro.
# Downloads the kit from GitHub, then runs install-windows.ps1 (which prints Chinese guidance).
#
#   Open PowerShell (Administrator is best) and paste ONE line:
#     irm https://raw.githubusercontent.com/Vadoyang/agent-lab-starter/main/get.ps1 | iex
#
#   With options (scriptblock form), for example the model server on a DGX:
#     & ([scriptblock]::Create((irm https://raw.githubusercontent.com/Vadoyang/agent-lab-starter/main/get.ps1))) -InstallArgs '--ollama point --model-url http://192.168.1.50:11434'
#
#   Running it again later updates the code and keeps .env, logs, certificates and results.
#
# Options:
#   -Repo owner/name   GitHub repository (default Vadoyang/agent-lab-starter, or $env:AGENTLAB_REPO)
#   -Ref  name         branch or tag to download (default main, or $env:AGENTLAB_REF)
#   -Dir  path         where to put the kit on Windows (default C:\agentlab\agent-lab-starter)
#   -InstallArgs '...' passed to install-windows.ps1 -> install.sh (non-interactive install)
#   -Update            only sync the new code into WSL and apply it (install-windows.ps1 -Update)
#   -DownloadOnly      download/refresh the kit folder, do not install
#
# Exit status is left in $LASTEXITCODE: 0 done, 3010 restart Windows then run again,
# 2 one manual step then run again, 1 failed (see deploy-logs, or run repair-windows.ps1 -Auto).
#
# MAINTAINERS: keep this file ASCII-only and saved WITHOUT a UTF-8 BOM.
# "irm | iex" fails when the text starts with a BOM, and Windows PowerShell 5.1 can mis-decode
# non-ASCII characters fetched this way. Do not call "exit" at top level: under "irm | iex" it
# would close the user's PowerShell window before they can read the messages.
param(
  [string]$Repo = $(if ($env:AGENTLAB_REPO) { $env:AGENTLAB_REPO } else { "Vadoyang/agent-lab-starter" }),
  [string]$Ref  = $(if ($env:AGENTLAB_REF)  { $env:AGENTLAB_REF }  else { "main" }),
  [string]$Dir  = $(if ($env:AGENTLAB_DIR)  { $env:AGENTLAB_DIR }  else { "C:\agentlab\agent-lab-starter" }),
  [string]$InstallArgs = "",
  [switch]$Update,
  [switch]$DownloadOnly,
  [string]$ArchiveUrl = "",   # override the download URL (mirror or test server)
  [switch]$NoElevate          # do not open a new Administrator window; fail instead
)

function Invoke-AgentLabGet {
  param(
    [string]$Repo, [string]$Ref, [string]$Dir, [string]$InstallArgs,
    [bool]$Update, [bool]$DownloadOnly, [string]$ArchiveUrl, [bool]$NoElevate
  )
  $ErrorActionPreference = "Stop"
  $ProgressPreference = "SilentlyContinue"   # Invoke-WebRequest is very slow in PS 5.1 with the progress bar
  function Say($m)  { Write-Host "[agentlab] $m" -ForegroundColor Cyan }
  function Note($m) { Write-Host "[agentlab] $m" -ForegroundColor Yellow }
  function Fail($m) { Write-Host "[agentlab] ERROR: $m" -ForegroundColor Red; $global:LASTEXITCODE = 1 }

  $onWindows = ($env:OS -eq "Windows_NT")
  $isAdmin = $false
  if ($onWindows) {
    try {
      $id = [Security.Principal.WindowsIdentity]::GetCurrent()
      $isAdmin = ([Security.Principal.WindowsPrincipal]$id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    } catch { $isAdmin = $false }
  }

  Say "AgentLab installer: repo $Repo, ref $Ref, folder $Dir"

  # ---- 1. Installing needs Administrator: reopen this installer in an elevated window -----------
  if (-not $DownloadOnly) {
    if (-not $onWindows) { Fail "This installer is for Windows. On Linux use get.sh."; return }
    if (-not $isAdmin) {
      if ($NoElevate) { Fail "Please open PowerShell with 'Run as administrator' and paste the command again."; return }
      Say "Administrator rights are needed. Opening a new Administrator window..."
      Say "Click 'Yes' on the Windows prompt, then follow the NEW window. You can close this one."
      try {
        $self = Join-Path $env:TEMP "agentlab-get.ps1"
        $selfUrl = "https://raw.githubusercontent.com/$Repo/$Ref/get.ps1"
        Invoke-WebRequest -UseBasicParsing -Uri $selfUrl -OutFile $self
        $argList = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-NoExit", "-File", "`"$self`"",
                     "-Repo", $Repo, "-Ref", $Ref, "-Dir", "`"$Dir`"")
        if ($InstallArgs) { $argList += @("-InstallArgs", "`"$InstallArgs`"") }
        if ($ArchiveUrl)  { $argList += @("-ArchiveUrl", "`"$ArchiveUrl`"") }
        if ($Update)      { $argList += "-Update" }
        Start-Process -FilePath "powershell.exe" -Verb RunAs -ArgumentList $argList | Out-Null
      } catch {
        Fail "Could not open an Administrator window ($($_.Exception.Message)). Right-click Start > 'Terminal (Admin)' and paste the command again."
      }
      return
    }
  }

  try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }

  # ---- 2. Get the code ----------------------------------------------------------------------------
  if (Test-Path -LiteralPath (Join-Path $Dir ".git")) {
    # A git clone is the maintainer copy (ChatGPT/Codex commits fixes there). Never overwrite it.
    Say "$Dir is a git clone (maintainer copy). Updating with 'git pull --ff-only' instead of overwriting."
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Fail "git is not installed, so this clone cannot be updated."; return }
    & git -C $Dir pull --ff-only
    if ($LASTEXITCODE -ne 0) { Fail "git pull failed (local changes or another branch?). Nothing was overwritten. Check 'git status' in $Dir."; return }
  } else {
    $customArchive = [bool]$ArchiveUrl
    if (-not $ArchiveUrl) { $ArchiveUrl = "https://github.com/$Repo/archive/$Ref.zip" }
    $work = Join-Path ([IO.Path]::GetTempPath()) ("agentlab-" + [Guid]::NewGuid().ToString("N").Substring(0, 8))
    New-Item -ItemType Directory -Force -Path $work | Out-Null
    $zip = Join-Path $work "kit.zip"
    Say "Downloading $ArchiveUrl"
    $ok = $false
    for ($i = 1; ($i -le 3) -and (-not $ok); $i++) {
      try { Invoke-WebRequest -UseBasicParsing -Uri $ArchiveUrl -OutFile $zip; $ok = $true }
      catch { Note "Download attempt $i failed: $($_.Exception.Message)"; Start-Sleep -Seconds (5 * $i) }
    }
    if (-not $ok) {
      Fail "Cannot download the kit. Check the internet connection, and that the GitHub repository $Repo is public and has branch/tag '$Ref'."
      return
    }
    $unz = Join-Path $work "x"
    Expand-Archive -LiteralPath $zip -DestinationPath $unz -Force
    $top = Get-ChildItem -LiteralPath $unz -Directory | Select-Object -First 1
    if ((-not $top) -or (-not (Test-Path -LiteralPath (Join-Path $top.FullName "install-windows.ps1")))) {
      Fail "The downloaded archive does not look like the AgentLab kit (install-windows.ps1 missing)."
      return
    }
    # Copy over the old code without deleting anything: .env, deploy-logs and reports are not in the
    # archive, so they survive. (The WSL copy keeps its own .env, logs, certificates and results.)
    New-Item -ItemType Directory -Force -Path $Dir | Out-Null
    $robo = Get-Command robocopy.exe -ErrorAction SilentlyContinue
    if ($robo) {
      & robocopy.exe $top.FullName $Dir /E /R:2 /W:2 /NFL /NDL /NJH /NJS /NP | Out-Null
      if ($LASTEXITCODE -ge 8) { Fail "Copying files failed (robocopy exit $LASTEXITCODE)."; return }
    } else {
      Get-ChildItem -LiteralPath $top.FullName -Force | Copy-Item -Destination $Dir -Recurse -Force
    }
    if ($onWindows) { Get-ChildItem -LiteralPath $Dir -Recurse -File | Unblock-File -ErrorAction SilentlyContinue }

    # Record exactly which version was installed (shown in reports; useful when asking for help)
    $sha = ""
    if (-not $customArchive) {
      try {
        $c = Invoke-RestMethod -UseBasicParsing -TimeoutSec 15 -Uri "https://api.github.com/repos/$Repo/commits/$Ref" `
             -Headers @{ "User-Agent" = "agentlab-get"; "Accept" = "application/vnd.github+json" }
        $sha = [string]$c.sha
      } catch { $sha = "" }
    }
    [ordered]@{ repo = $Repo; ref = $Ref; commit = $sha; archive = $ArchiveUrl; downloaded_at = (Get-Date).ToString("s") } |
      ConvertTo-Json | Set-Content -LiteralPath (Join-Path $Dir ".source.json") -Encoding ASCII
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
    if ($sha) { Say "Kit is in $Dir (commit $($sha.Substring(0, 7)))" } else { Say "Kit is in $Dir" }
  }

  if ($DownloadOnly) {
    Say "Download only: nothing installed. To install: cd '$Dir'; .\install-windows.ps1"
    $global:LASTEXITCODE = 0
    return
  }

  # ---- 3. Install (or update) -------------------------------------------------------------------
  $installer = Join-Path $Dir "install-windows.ps1"
  $psArgs = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $installer)
  if ($Update)      { $psArgs += "-Update" }
  if ($InstallArgs) { $psArgs += @("-InstallArgs", $InstallArgs) }
  Say "Starting install-windows.ps1 (it asks a few questions in Chinese; the first run can take 20+ minutes)..."
  & powershell.exe @psArgs
  $code = $LASTEXITCODE

  Write-Host ""
  switch ($code) {
    0       { Say "DONE. Open the portal address printed above. To update later, paste the same command again." }
    3010    { Note "RESTART NEEDED (WSL was just installed). Restart Windows, log in, open PowerShell as Administrator and paste the SAME command again." }
    2       { Note "ONE MANUAL STEP: open 'Ubuntu 24.04' from the Start menu once, create a user name and password, close it, then paste the SAME command again." }
    default { Fail "Install did not finish (exit $code). Logs: $Dir\deploy-logs . Try: cd '$Dir'; .\repair-windows.ps1 -Auto  (or ask ChatGPT/Codex to run the self-heal loop in AGENTS.md)." }
  }
  $global:LASTEXITCODE = $code
}

Invoke-AgentLabGet -Repo $Repo -Ref $Ref -Dir $Dir -InstallArgs $InstallArgs `
  -Update ([bool]$Update) -DownloadOnly ([bool]$DownloadOnly) -ArchiveUrl $ArchiveUrl -NoElevate ([bool]$NoElevate)
