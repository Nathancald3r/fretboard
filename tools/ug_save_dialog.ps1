# Fills Chrome's "Save As" dialog with a full path and presses Save. Usage: ug_save_dialog.ps1 <full path>
# Sets the file name box directly with window messages (no typing or clipboard), so using the
# computer meanwhile can't mix keys in. Chrome opens each dialog in a new helper process: the
# newest dialog is this save, and any older leftover one is cancelled so it's never filled by mistake.
param([string]$Path, [int]$TimeoutSec = 25, [int]$MaxAgeSec = 30)
Add-Type @'
using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices;
public class SaveDlg {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr p, EnumProc f, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetParent(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern IntPtr GetDlgItem(IntPtr h, int id);
  [DllImport("user32.dll")] static extern int GetDlgCtrlID(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, string l);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  static string Cls(IntPtr h) { var s = new StringBuilder(256); GetClassName(h, s, 256); return s.ToString(); }
  static string Txt(IntPtr h) { var s = new StringBuilder(256); GetWindowText(h, s, 256); return s.ToString(); }
  public static List<IntPtr> Dialogs() {
    var r = new List<IntPtr>();
    EnumWindows((h, l) => { if (IsWindowVisible(h) && Cls(h) == "#32770" && Txt(h) == "Save As") r.Add(h); return true; }, IntPtr.Zero);
    return r;
  }
  public static IntPtr NameBox(IntPtr dlg) {  // the File name box
    IntPtr found = IntPtr.Zero;
    EnumChildWindows(dlg, (h, l) => {
      if (Cls(h) == "Edit" && GetDlgCtrlID(h) == 1001) { found = h; return false; }  // 1001: the File name box (not the address bar)
      return true; }, IntPtr.Zero);
    return found;
  }
  public static void SetText(IntPtr h, string t) { SendMessage(h, 0x000C, IntPtr.Zero, t); }
  public static bool Click(IntPtr dlg, int id) { var b = GetDlgItem(dlg, id); return b != IntPtr.Zero && PostMessage(b, 0x00F5, IntPtr.Zero, IntPtr.Zero); }
}
'@
function Started($h) { $p = 0; [SaveDlg]::GetWindowThreadProcessId($h, [ref]$p) | Out-Null; try { (Get-Process -Id $p).StartTime } catch { Get-Date 0 } }
$since = (Get-Date).AddSeconds(-$MaxAgeSec)  # a dialog opened before this is a leftover
$end = (Get-Date).AddSeconds($TimeoutSec)
while ((Get-Date) -lt $end) {
  $all = @([SaveDlg]::Dialogs() | Sort-Object { Started $_ } -Descending)
  if ($all.Count -and (Started $all[0]) -gt $since) {
    foreach ($old in ($all | Select-Object -Skip 1)) { [SaveDlg]::Click($old, 2) | Out-Null }  # Cancel leftovers
    $box = [SaveDlg]::NameBox($all[0])
    if ($box -ne [IntPtr]::Zero) {
      [SaveDlg]::SetText($box, $Path)
      Start-Sleep -Milliseconds 300
      if ([SaveDlg]::Click($all[0], 1)) { Write-Output 'saved'; exit 0 }
    }
  }
  Start-Sleep -Milliseconds 400
}
Write-Output 'no dialog'; exit 1
