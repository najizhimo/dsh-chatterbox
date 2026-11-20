param(
  [Parameter(Mandatory = $true)][string[]]$Paths
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
