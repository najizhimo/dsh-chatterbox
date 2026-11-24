param(
  # 位置参数：直接跟文件路径（宿主按 "script.ps1 path1 path2 ..." 调用，7 与 5.1 都支持）
  [Parameter(ValueFromRemainingArguments = $true, Mandatory = $true)][string[]]$Paths
)
# Move files to the Windows Recycle Bin (never delete outright).
# Global rule: deletions go through the Recycle Bin so the owner can inspect them.
Add-Type -AssemblyName Microsoft.VisualBasic
$moved = 0
$failed = 0
foreach ($p in $Paths) {
  if (-not (Test-Path -LiteralPath $p -PathType Leaf)) { continue }
  try {
    [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, 'OnlyErrorDialogs', 'SendToRecycleBin')
    $moved++
  } catch {
    $failed++
    Write-Output ("failed: {0} ({1})" -f $p, $_.Exception.Message)
  }
}
Write-Output ("recycled={0} failed={1}" -f $moved, $failed)
