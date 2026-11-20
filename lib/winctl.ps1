# Paper Vault window helper (started by `pv serve`, exits when its stdin closes).
#
# - Registers the global hotkey; pressing it shows the assistant window, or
#   hides it (no taskbar button) when it is already in front. Opens a new Edge
#   app window if none exists.
# - Reads commands from stdin, one per line: show | hide | toggle | quit.
# - Writes status lines to stdout: "ready", "hotkey-failed", "opened", ...
#
# Pure ASCII on purpose: Windows PowerShell 5.1 reads scripts in the ANSI code page.

param(
  [Parameter(Mandatory = $true)][string]$Edge,
  [Parameter(Mandatory = $true)][string]$Url,
  [Parameter(Mandatory = $true)][uint32]$Mods,
  [Parameter(Mandatory = $true)][uint32]$Vk,
  [string]$Title = 'Paper Vault'
)

$ErrorActionPreference = 'Stop'

Add-Type -ReferencedAssemblies System.Windows.Forms -TypeDefinition @'
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

public class PvWindowHelper : Form {
  [DllImport("user32.dll")] static extern bool RegisterHotKey(IntPtr h, int id, uint mods, uint vk);
  [DllImport("user32.dll")] static extern bool UnregisterHotKey(IntPtr h, int id);
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);

  const int WM_HOTKEY = 0x0312;
  const uint MOD_NOREPEAT = 0x4000;
  const int SW_HIDE = 0, SW_SHOW = 5, SW_RESTORE = 9;

  readonly string edge, url, title;
  readonly uint mods, vk;
  IntPtr last = IntPtr.Zero;

  public PvWindowHelper(string edge, string url, string title, uint mods, uint vk) {
    this.edge = edge; this.url = url; this.title = title; this.mods = mods; this.vk = vk;
    ShowInTaskbar = false;
    FormBorderStyle = FormBorderStyle.None;
    var _ = Handle; // create the window handle without ever showing the form
    Say(RegisterHotKey(Handle, 1, mods | MOD_NOREPEAT, vk) ? "ready" : "hotkey-failed");
    var reader = new Thread(ReadCommands) { IsBackground = true };
    reader.Start();
  }

  protected override void SetVisibleCore(bool value) { base.SetVisibleCore(false); }

  static void Say(string s) { Console.Out.WriteLine(s); Console.Out.Flush(); }

  void ReadCommands() {
    string line;
    try {
      while ((line = Console.In.ReadLine()) != null) {
        string cmd = line.Trim();
        BeginInvoke(new Action(() => Run(cmd)));
      }
    } catch (IOException) { }
    BeginInvoke(new Action(() => Application.Exit())); // parent server is gone
  }

  void Run(string cmd) {
    try {
      if (cmd == "show") ShowAssistant();
      else if (cmd == "hide") HideAssistant(Find());
      else if (cmd == "toggle") Toggle();
      else if (cmd == "quit") Application.Exit();
    } catch (Exception e) { Say("error " + e.Message.Replace('\n', ' ')); }
  }

  protected override void WndProc(ref Message m) {
    if (m.Msg == WM_HOTKEY) { try { Toggle(); } catch (Exception e) { Say("error " + e.Message.Replace('\n', ' ')); } }
    base.WndProc(ref m);
  }

  protected override void OnFormClosed(FormClosedEventArgs e) { UnregisterHotKey(Handle, 1); base.OnFormClosed(e); }

  // Top-level Chromium window whose title contains our marker, visible or hidden.
  IntPtr Find() {
    if (last != IntPtr.Zero && Matches(last)) return last;
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      if (GetWindow(h, 4 /* GW_OWNER */) == IntPtr.Zero && Matches(h)) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    last = found;
    return found;
  }

  bool Matches(IntPtr h) {
    var cls = new StringBuilder(64);
    GetClassName(h, cls, cls.Capacity);
    if (!cls.ToString().StartsWith("Chrome_WidgetWin")) return false;
    var t = new StringBuilder(512);
    GetWindowText(h, t, t.Capacity);
    return t.ToString().Contains(title);
  }

  void Toggle() {
    IntPtr h = Find();
    if (h == IntPtr.Zero) { Open(); return; }
    bool shown = IsWindowVisible(h) && !IsIconic(h);
    if (shown && GetForegroundWindow() == h) HideAssistant(h); else ShowAssistant();
  }

  IntPtr previous = IntPtr.Zero; // window the user was in before we came forward

  void HideAssistant(IntPtr h) {
    if (h == IntPtr.Zero) return;
    ShowWindow(h, SW_HIDE);
    // Give the keyboard back to where the user was, not to an invisible window.
    if (previous != IntPtr.Zero && previous != h && IsWindowVisible(previous)) SetForegroundWindow(previous);
    Say("hidden");
  }

  void ShowAssistant() {
    IntPtr h = Find();
    if (h == IntPtr.Zero) { Open(); return; }
    IntPtr fg = GetForegroundWindow();
    if (fg != h && fg != IntPtr.Zero) previous = fg;
    ShowWindow(h, SW_SHOW);
    if (IsIconic(h)) ShowWindow(h, SW_RESTORE);
    // Windows only lets the process that got the last input take the foreground;
    // a synthetic Alt tap satisfies that rule.
    keybd_event(0x12, 0, 0, UIntPtr.Zero);
    keybd_event(0x12, 0, 2, UIntPtr.Zero);
    SetForegroundWindow(h);
    Say("shown");
  }

  void Open() {
    if (string.IsNullOrEmpty(edge) || !File.Exists(edge)) Process.Start(url);
    else Process.Start(edge, "--app=" + url + " --window-size=1600,1000");
    Say("opened");
  }
}
'@

[System.Windows.Forms.Application]::Run((New-Object PvWindowHelper($Edge, $Url, $Title, $Mods, $Vk)))
