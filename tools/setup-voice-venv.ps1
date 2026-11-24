# -*- coding: utf-8 -*-
# 建立 dsh-chatterbox 语音客户端的独立运行环境（幂等，可重复跑）。
# 位置：dsh-chatterbox\tools\setup-voice-venv.ps1
#   pwsh -NoProfile -File setup.ps1
#   pwsh -NoProfile -File setup.ps1 -Mirror https://pypi.org/simple
#
# 装到 %LOCALAPPDATA%\dsh\dsh-chatterbox\venv，不碰任何工作区的 venv。

param(
    [string]$Mirror = 'https://pypi.tuna.tsinghua.edu.cn/simple',
    [string]$Proxy = '',
    [string]$BootstrapPython = ''
)

# 找不到现成解释器时就按顺序探测（不再硬编码开发机的路径）。
function Resolve-BootstrapPython {
    param([string]$Given)
    if ($Given -ne '' -and (Test-Path -LiteralPath $Given)) { return $Given }
    $candidates = @()
    $pyLauncher = Get-Command py -ErrorAction SilentlyContinue
    if ($pyLauncher) {
        try { $out = (& py -3 -c "import sys; print(sys.executable)" 2>$null); if ($out) { $candidates += $out.Trim() } } catch { }
    }
    foreach ($name in @('python', 'python3')) {
        $cmd = Get-Command $name -ErrorAction SilentlyContinue
        if ($cmd) { $candidates += $cmd.Source }
    }
    $irodori = Join-Path (Split-Path $PSScriptRoot -Parent) 'deps\irodori\.venv\Scripts\python.exe'
    $candidates += $irodori
    $uv = Get-Command uv -ErrorAction SilentlyContinue
    if ($uv) {
        try { $out = (& uv python find 2>$null); if ($out) { $candidates += $out.Trim() } } catch { }
    }
    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate)) { return $candidate }
    }
    throw '找不到 Python 3.x。请先安装 Python（https://www.python.org/downloads/），或用 -BootstrapPython 指定 python.exe'
}

$ErrorActionPreference = 'Stop'
$base = Join-Path $env:LOCALAPPDATA 'dsh\dsh-chatterbox'
$venv = Join-Path $base 'venv'
$vpy = Join-Path $venv 'Scripts\python.exe'
$pkgs = @('sherpa-onnx', 'sounddevice', 'keyboard', 'numpy', 'soundfile', 'pypinyin')

Write-Host "[1/4] 目录: $base"
New-Item -ItemType Directory -Force -Path $base, (Join-Path $base 'logs') | Out-Null

if (-not (Test-Path $vpy)) {
    $BootstrapPython = Resolve-BootstrapPython -Given $BootstrapPython
    Write-Host "[2/4] 建 venv（用 $BootstrapPython）..."
    & $BootstrapPython -m venv $venv
    if (-not (Test-Path $vpy)) { throw "venv 建立失败: $vpy" }
} else {
    Write-Host "[2/4] venv 已存在，跳过"
}

Write-Host "[3/4] 装依赖（$Mirror）..."
& $vpy -m pip install --disable-pip-version-check --timeout 30 -i $Mirror $pkgs
if ($LASTEXITCODE -ne 0) {
    Write-Host "      镜像失败，改走代理 $Proxy 直连 pypi.org ..."
    & $vpy -m pip install --disable-pip-version-check --timeout 30 --proxy $Proxy $pkgs
}
if ($LASTEXITCODE -ne 0) { throw "依赖安装失败" }

Write-Host "[4/4] 检查模型 ..."
$model = Join-Path $env:USERPROFILE '.dsh\speech-to-text\sensevoice\models\sensevoice-onnx\model.int8.onnx'
$tokens = Join-Path $env:USERPROFILE '.dsh\speech-to-text\sensevoice\models\sensevoice-onnx\tokens.txt'
if (-not (Test-Path $model)) {
    Write-Host "      缺模型：$model"
    Write-Host "      先打开一次 DSH 的麦克风功能让它自动下载，或按 references\setup.md 手动放置。"
} else {
    $mb = [math]::Round((Get-Item $model).Length / 1MB, 1)
    Write-Host "      模型 OK: $mb MB"
}

# 产物登记（skill-authoring/artifacts.md）
try {
    $reg = Join-Path $env:LOCALAPPDATA 'dsh\artifacts\dsh-chatterbox.jsonl'
    New-Item -ItemType Directory -Force -Path (Split-Path $reg) | Out-Null
    $rec = [ordered]@{
        path = $venv; kind = 'cache'; skill = 'dsh-chatterbox'
        createdAt = (Get-Date).ToString('yyyy-MM-ddTHH:mm:sszzz')
        expiry = 'manual'; delete = 'review'; selfCleaning = $false
    }
    ($rec | ConvertTo-Json -Compress -Depth 3) | Add-Content -Path $reg -Encoding utf8
} catch {
    Write-Host "      （产物登记失败，不影响使用）"
}

Write-Host ""
Write-Host "完成。常驻启动："
$ptt = Join-Path (Split-Path $PSScriptRoot -Parent) 'src\voice\ptt.py'
Write-Host "  & '$vpy' '$ptt'"
