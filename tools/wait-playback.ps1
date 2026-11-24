# Wait until every TTS playback process has exited.
#
# Used by the Host plugin as the authoritative "the reply audio really finished"
# signal: speak.py starts playback in a detached process (play_media.ps1 for the
# Media Foundation path, a pythonw one-liner for the old winsound path).
#
# Two phases so the Host learns about the end almost immediately:
#   1. one WMI query finds the player pids (unavoidable, ~1 s, runs while audio plays);
#   2. Wait-Process blocks on those pids instead of re-querying WMI in a loop.
# Exit codes: 0 = nothing is playing any more, 2 = timed out.
param(
    [int]$TimeoutSeconds = 150
)

$pids = @(
    Get-CimInstance Win32_Process -Filter "Name='pwsh.exe' OR Name='powershell.exe' OR Name='pythonw.exe'" -ErrorAction SilentlyContinue |
        Where-Object {
            ($_.CommandLine -like '*play_media.ps1*') -or ($_.CommandLine -like '*winsound.PlaySound*')
        } |
        Select-Object -ExpandProperty ProcessId
)

if ($pids.Count -eq 0) { exit 0 }

$remaining = [int][math]::Ceiling(($TimeoutSeconds * 1000 - 1500) / 1000)
if ($remaining -lt 1) { exit 2 }

try {
    Wait-Process -Id $pids -Timeout $remaining -ErrorAction Stop
} catch {
    # Timeout (or a pid vanished mid-wait): fall through to the liveness check.
}

$alive = @($pids | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })
if ($alive.Count -gt 0) { exit 2 }
exit 0
