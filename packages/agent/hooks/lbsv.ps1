# lbsv (LabSave) shell hook for PowerShell 7+ and Windows PowerShell 5.1. Dot-source it from $PROFILE,
# AFTER anything else that sets the prompt (oh-my-posh, starship):
#   . "$HOME\.config\lbsv\lbsv.ps1"
#
# At each prompt this overwrites one small file, $env:LBSV_STATE_DIR\<pid>, in-process: no
# subprocess, no network. Recorded: pid, user, host, cwd. Never command output.
# Command text only if you opt in with $env:LBSV_RECORD_CMDS = '1' (redacted again by the agent and the hub).

if ($global:__lbsvFile) { return }
$__lbsvDir = $env:LBSV_STATE_DIR
if (-not $__lbsvDir) {
  $__lbsvBase = $env:XDG_STATE_HOME
  if (-not $__lbsvBase) { $__lbsvBase = Join-Path $HOME (Join-Path '.local' 'state') }
  $__lbsvDir = Join-Path $__lbsvBase (Join-Path 'lbsv' 'shells')
}
try { [void][IO.Directory]::CreateDirectory($__lbsvDir) } catch { return }
$global:__lbsvFile = Join-Path $__lbsvDir "$PID"
$global:__lbsvHead = "v=1`nshell=$(if ($PSVersionTable.PSEdition -eq 'Core') { 'pwsh' } else { 'powershell' })`npid=$PID`nuser=$([Environment]::UserName)`nhost=$([Environment]::MachineName)`nstarted=$([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())`n"
$global:__lbsvPrompt = $function:prompt

function global:prompt {
  $__lbsvExit = $global:LASTEXITCODE
  try {
    $loc = $ExecutionContext.SessionState.Path.CurrentFileSystemLocation.ProviderPath
    $body = $global:__lbsvHead + "cwd=$loc`n"
    if ($env:LBSV_RECORD_CMDS -eq '1') {
      $h = Get-History -Count 1
      if ($h) { $body += "cmd=$($h.CommandLine)`n" }
    }
    [IO.File]::WriteAllText($global:__lbsvFile, $body)
  } catch { }
  $global:LASTEXITCODE = $__lbsvExit
  if ($global:__lbsvPrompt) { & $global:__lbsvPrompt } else { "PS $($executionContext.SessionState.Path.CurrentLocation)$('>' * ($nestedPromptLevel + 1)) " }
}

# Tidy up on a clean exit (the agent also drops files whose process is gone).
$null = Register-EngineEvent -SourceIdentifier PowerShell.Exiting -SupportEvent -Action { try { [IO.File]::Delete($global:__lbsvFile) } catch { } }
