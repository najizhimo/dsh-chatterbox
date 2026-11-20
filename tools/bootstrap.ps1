# -*- coding: utf-8 -*-
# dsh-chatterbox 一键初始化：识别 venv → 下载外部依赖 →（可选）Irodori venv → 打印后续命令
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File "<插件>\tools\bootstrap.ps1"
#   powershell ... -File bootstrap.ps1 -Port 18801 -WithTtsVenv
#
# 只读网络、只写插件自己的目录与 %LOCALAPPDATA%\dsh\dsh-chatterbox；不碰别的项目。

param(
    [string]$Port = '18801',
    [string]$BootstrapPython = '',
    [switch]$WithTtsVenv,
    [int]$TimeoutSeconds = 3600
)

$ErrorActionPreference = 'Stop'
$plugin = Split-Path $PSScriptRoot -Parent
$base = "http://127.0.0.1:$Port"

Write-Host ''
Write-Host '=== dsh-chatterbox 初始化 ==='
Write-Host "插件目录: $plugin"
Write-Host ''

# 1) 识别 venv
Write-Host '[1/4] 识别用 venv（sherpa-onnx 等 6 个包）'
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'setup-voice-venv.ps1') -BootstrapPython $BootstrapPython
if ($LASTEXITCODE -ne 0) { throw '识别 venv 建立失败' }

# 2) 外部依赖（ASR 模型 / VAD / Irodori 源码）
Write-Host ''
Write-Host '[2/4] 下载外部依赖（约 165 MB，装到 <插件>\deps）'
$started = $false
try {
    Invoke-RestMethod -Method Post -Uri "$base/voice/deps/install" -ContentType 'application/json' -Body '{}' | Out-Null
    $started = $true
} catch {
    Write-Host '      插件没在运行（或端口不是这个）：跳过自动下载。'
    Write-Host '      打开 DSH → 设置 → 插件 → chatterbox 依赖 → 「下载并安装缺失」即可。'
}
if ($started) {
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 3
        try { $state = Invoke-RestMethod -Uri "$base/voice/deps/install" } catch { break }
        if ($state.running) {
            $mb = [math]::Round($state.received / 1MB, 1)
            Write-Host ("      下载中: {0} — {1} MB" -f $state.label, $mb)
            continue
        }
        Write-Host ("      完成: done={0} failed={1}" -f (($state.done -join ','), ($state.failed -join ',')))
        break
    }
}

# 3) Irodori venv（可选）
Write-Host ''
$irodori = Join-Path $plugin 'deps\irodori'
if ($WithTtsVenv) {
    Write-Host '[3/4] Irodori venv（uv sync，约 5.2 GB）'
    if (-not (Test-Path -LiteralPath $irodori)) { throw "找不到 $irodori（先完成第 2 步）" }
    $uv = Get-Command uv -ErrorAction SilentlyContinue
    if (-not $uv) { throw '需要 uv：https://github.com/astral-sh/uv' }
    Push-Location $irodori
    try { & uv sync --extra cu128 --frozen } finally { Pop-Location }
} else {
    Write-Host '[3/4] Irodori venv：跳过（加 -WithTtsVenv 可自动跑，或手动：cd deps\irodori; uv sync --extra cu128 --frozen）'
}

# 4) HF 权重
Write-Host ''
Write-Host '[4/4] HF 权重（约 4.6 GB，需手动跑一次）'
$hf = Join-Path $plugin 'deps\hf-cache'
Write-Host '  $env:HF_HOME = "' + $hf + '"'
Write-Host '  python -m huggingface_hub.commands.huggingface_cli download Aratako/Irodori-TTS-v4.1-Small --local-dir "$env:HF_HOME\hub\models--Aratako--Irodori-TTS-v4.1-Small"'
Write-Host '  python -m huggingface_hub.commands.huggingface_cli download Aratako/Semantic-DACVAE-Japanese-32dim --local-dir "$env:HF_HOME\hub\models--Aratako--Semantic-DACVAE-Japanese-32dim"'
Write-Host ''
Write-Host '置音色档案：把 cb_* 文件夹放到 <插件>\deps\voices\（或工作区 voices\），然后在配置页选它。'
Write-Host '完成后：设置 → 插件 → chatterbox 依赖 → 开始检测，应全部就绪。'
