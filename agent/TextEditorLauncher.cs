using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32;

namespace RboxAgent
{
    // NOT: Bu dosya WPF (RboxTools/Common) ile web ajanında (RboxWeb/agent) aynıdır; yalnızca namespace farklıdır.

    /// <summary>
    /// updateFiles'taki metin dosyalarını (JsonSettings, serialdevices.json, dhcpcd, wpa_supplicant, rapor) açar.
    /// Sıra: Notepad++ (nereye kurulmuş olursa olsun) → Windows'ta .txt için seçili varsayılan uygulama → Not Defteri.
    /// .json çoğu bilgisayarda hiçbir uygulamaya bağlı olmadığı için dosyanın kendi uzantısına değil .txt'ye bakılır.
    /// </summary>
    public static class TextEditorLauncher
    {
        public static void Open(string path)
        {
            string quoted = $"\"{path}\"";
            foreach (var exe in new[] { FindNotepadPlusPlus(), DefaultTxtEditor() })
            {
                if (exe == null) continue;
                try { Process.Start(new ProcessStartInfo(exe, quoted) { UseShellExecute = false }); return; }
                catch { /* sıradakini dene */ }
            }
            Process.Start(new ProcessStartInfo("notepad.exe", quoted) { UseShellExecute = true });
        }

        /// <summary>Hangi düzenleyicinin kullanılacağı (bilgi / tanı için).</summary>
        public static string Describe() => FindNotepadPlusPlus() ?? DefaultTxtEditor() ?? "notepad.exe";

        public static string? FindNotepadPlusPlus()
        {
            var candidates = new List<string?>
            {
                RegValue(@"HKEY_CURRENT_USER\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\notepad++.exe", null),
                RegValue(@"HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\notepad++.exe", null),
                RegValue(@"HKEY_LOCAL_MACHINE\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths\notepad++.exe", null),
                // Kurulum programının yazdığı klasör (App Paths yazılmamış kurulumlar)
                InDir(RegValue(@"HKEY_LOCAL_MACHINE\SOFTWARE\Notepad++", null)),
                InDir(RegValue(@"HKEY_LOCAL_MACHINE\SOFTWARE\WOW6432Node\Notepad++", null)),
                InDir(RegValue(@"HKEY_CURRENT_USER\SOFTWARE\Notepad++", null)),
                InDir(RegValue(@"HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\Notepad++", "InstallLocation")),
                InDir(RegValue(@"HKEY_LOCAL_MACHINE\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\Notepad++", "InstallLocation")),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Notepad++", "notepad++.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "Notepad++", "notepad++.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "Notepad++", "notepad++.exe"),
                // Taşınabilir sürüm ya da farklı klasöre kurulum: .txt varsayılanı Notepad++ ise onun yolu
                DefaultTxtEditor() is { } d && Path.GetFileName(d).Equals("notepad++.exe", StringComparison.OrdinalIgnoreCase) ? d : null,
            };
            return candidates.FirstOrDefault(c => !string.IsNullOrWhiteSpace(c) && File.Exists(c));
        }

        /// <summary>Windows'ta .txt için seçili uygulama (kullanıcının "Birlikte aç" seçimi dahil). Not Defteri ise null.</summary>
        public static string? DefaultTxtEditor()
        {
            try
            {
                uint size = 1024;
                var sb = new StringBuilder((int)size);
                if (AssocQueryString(0, 2 /* ASSOCSTR_EXECUTABLE */, ".txt", "open", sb, ref size) != 0) return null;
                var exe = Environment.ExpandEnvironmentVariables(sb.ToString().Trim().Trim('"'));
                if (exe.Length == 0 || !File.Exists(exe)) return null;
                return Path.GetFileName(exe).Equals("notepad.exe", StringComparison.OrdinalIgnoreCase) ? null : exe;
            }
            catch { return null; }
        }

        private static string? RegValue(string key, string? name)
        {
            try { return (Registry.GetValue(key, name, null) as string)?.Trim().Trim('"'); }
            catch { return null; }
        }

        private static string? InDir(string? dir) =>
            string.IsNullOrWhiteSpace(dir) ? null : Path.Combine(dir, "notepad++.exe");

        [DllImport("shlwapi.dll", CharSet = CharSet.Unicode)]
        private static extern uint AssocQueryString(uint flags, uint str, string assoc, string? extra, StringBuilder? output, ref uint size);
    }
}
