# Watches what VS Code starts. Start it first, then open VS Code as usual. It writes %USERPROFILE%\.fretboard\procwatch.log.
#   powershell -ExecutionPolicy Bypass -File tools\procwatch.ps1 [-Minutes 30] [-Kill] [-Limit 120]
# Every 2 s it counts the programs that sit under VS Code (Code.exe) and logs the count by name. When the count jumps by
# 10 or more it also logs the newest ones with their parent and command line, so the cause shows up in the log.
# With -Kill it closes VS Code (and everything under it) when the count passes -Limit.
param([double]$Minutes = 30, [switch]$Kill, [int]$Limit = 120)

$log = Join-Path $env:USERPROFILE '.fretboard\procwatch.log'
New-Item -ItemType Directory -Force -Path (Split-Path $log) | Out-Null
function Say($m) {
  $l = '{0} {1}' -f (Get-Date).ToString('yyyy-MM-dd HH:mm:ss'), $m
  Add-Content -Path $log -Value $l
  Write-Host $l
}
function Short($s, $n) { if ($null -eq $s) { return '' }; if ($s.Length -gt $n) { return $s.Substring(0, $n) + '...' }; return $s }

Say "watching for $Minutes min (Kill=$Kill, Limit=$Limit)"
$end = (Get-Date).AddMinutes($Minutes)
$last = 0
$tick = 0
while ((Get-Date) -lt $end) {
  $all = @(Get-CimInstance Win32_Process)
  $byId = @{}
  $kids = @{}
  foreach ($p in $all) {
    $byId[[int]$p.ProcessId] = $p
    $pp = [int]$p.ParentProcessId
    if (-not $kids.ContainsKey($pp)) { $kids[$pp] = New-Object System.Collections.ArrayList }
    [void]$kids[$pp].Add($p)
  }
  $seen = @{}
  $queue = New-Object System.Collections.Queue
  foreach ($r in ($all | Where-Object { $_.Name -eq 'Code.exe' })) { $seen[[int]$r.ProcessId] = $r; $queue.Enqueue([int]$r.ProcessId) }
  while ($queue.Count -gt 0) {
    $id = $queue.Dequeue()
    if ($kids.ContainsKey($id)) {
      foreach ($c in $kids[$id]) {
        if (-not $seen.ContainsKey([int]$c.ProcessId)) { $seen[[int]$c.ProcessId] = $c; $queue.Enqueue([int]$c.ProcessId) }
      }
    }
  }
  $n = $seen.Count
  $cmds = @($all | Where-Object { $_.Name -eq 'cmd.exe' }).Count
  if ($n -ne $last -or ($tick % 15) -eq 0) {
    $names = ($seen.Values | Group-Object Name | Sort-Object Count -Descending | Select-Object -First 6 | ForEach-Object { '{0}={1}' -f $_.Name, $_.Count }) -join ' '
    Say ("under VS Code: {0}  (all cmd.exe on the PC: {1})  {2}" -f $n, $cmds, $names)
  }
  if ($n - $last -ge 10) {
    Say 'newest ones:'
    $seen.Values | Sort-Object CreationDate -Descending | Select-Object -First 15 | ForEach-Object {
      $par = $byId[[int]$_.ParentProcessId]
      $pn = if ($par) { $par.Name } else { '?' }
      Say ('   {0} pid {1} <- {2} :: {3}' -f $_.Name, $_.ProcessId, $pn, (Short $_.CommandLine 170))
    }
  }
  if ($Kill -and $n -gt $Limit) {
    Say "over the limit ($n > $Limit): closing VS Code"
    foreach ($p in ($seen.Values | Sort-Object CreationDate -Descending)) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
    Say 'closed'
    $n = 0
  }
  $last = $n
  $tick++
  Start-Sleep -Seconds 2
}
Say 'done'
