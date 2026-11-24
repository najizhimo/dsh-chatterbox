# 用 Windows Media Foundation（WPF MediaPlayer）播放一段 wav，播完自动退出。
# 由 speak.py 以隐藏窗口方式启动：pwsh（或 5.1 的 powershell）-NoProfile -STA -WindowStyle Hidden -File play_media.ps1 -Path <wav>
# 为什么不用 winsound：它走老的 waveOut/sndPlaySound，长于约 12 秒的音轨会把蓝牙链路拉断，
# 整个耳机会静音，必须重连（2026-11-18 实测：10.07 s 正常，12.02 / 12.77 s 断）。

param(
    [Parameter(Mandatory = $true)][string]$Path,
    [double]$MaxWait = 120
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $Path)) { exit 2 }

Add-Type -AssemblyName PresentationCore

$player = New-Object System.Windows.Media.MediaPlayer
try {
    $player.Open([Uri]$Path)
    $player.Volume = 1.0
    $player.Play()                     # 立刻起播，别等元数据——等 5 秒纯属浪费

    $t0 = Get-Date
    $dur = 0.0
    $deadline = $t0.AddSeconds($MaxWait)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 80
        if ($player.NaturalDuration.HasTimeSpan) { $dur = $player.NaturalDuration.TimeSpan.TotalSeconds }
        if ($dur -gt 0 -and $player.Position.TotalSeconds -ge $dur - 0.05) { break }
        if (-not $dur -and ((Get-Date) - $t0).TotalSeconds -gt 8) { break }   # 拿不到时长就别死等
    }
    exit 0
}
finally {
    $player.Close()
}
