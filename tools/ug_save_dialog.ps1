# Fills Chrome's "Save As" dialog with a full path and presses Save. Usage: ug_save_dialog.ps1 <full path>
param([string]$Path, [int]$TimeoutSec = 20)
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
Add-Type 'using System;using System.Runtime.InteropServices;public class W{[DllImport("user32.dll")]public static extern bool SetForegroundWindow(IntPtr h);}'
$A = [System.Windows.Automation.AutomationElement]
$S = [System.Windows.Automation.TreeScope]
function Prop($p, $v) { New-Object System.Windows.Automation.PropertyCondition($p, $v) }
$end = (Get-Date).AddSeconds($TimeoutSec)
while ((Get-Date) -lt $end) {
  $dlg = $A::RootElement.FindFirst($S::Descendants, (New-Object System.Windows.Automation.AndCondition(
    (Prop $A::ClassNameProperty '#32770'), (Prop $A::NameProperty 'Save As'))))
  if ($dlg) {
    [W]::SetForegroundWindow([IntPtr]$dlg.Current.NativeWindowHandle) | Out-Null
    Start-Sleep -Milliseconds 400
    Set-Clipboard -Value $Path
    [System.Windows.Forms.SendKeys]::SendWait('^a')
    [System.Windows.Forms.SendKeys]::SendWait('^v')
    Start-Sleep -Milliseconds 300
    [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
    if ($true) {
      Write-Output 'saved'; exit 0
    }
  }
  Start-Sleep -Milliseconds 300
}
Write-Output 'no dialog'; exit 1
