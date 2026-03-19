using Microsoft.Win32;

namespace BaumLabSuite;

internal static class RegistryHelper
{
    private static readonly string[] _uninstallPaths =
    [
        @"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
        @"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall",
    ];

    /// <summary>
    /// Searches the registry for the installed version of <paramref name="app"/>.
    /// Checks both HKCU and HKLM, by AppId and by DisplayName.
    /// Populates <see cref="AppDefinition.InstalledVersion"/> and resolves the final status.
    /// </summary>
    public static void Resolve(AppDefinition app)
    {
        string? installed = FindByAppId(app.InnoAppId)
                         ?? FindByDisplayName(app.Name);

        app.InstalledVersion = installed;

        if (app.Status == AppStatus.Failed) return;  // keep error state

        if (installed is null)
        {
            app.Status = AppStatus.NotInstalled;
            return;
        }

        if (app.LatestVersion is null || app.DownloadUrl is null)
        {
            app.Status = AppStatus.UpToDate;  // installed but can't check remote
            return;
        }

        app.Status = VersionIsNewer(app.LatestVersion, installed)
            ? AppStatus.UpdateAvailable
            : AppStatus.UpToDate;
    }

    // ── Lookup helpers ────────────────────────────────────────────────────────

    private static string? FindByAppId(string appId)
    {
        // Inno Setup registers under {AppId}_is1
        string subKey = $"{{{appId}}}_is1";
        return TryReadDisplayVersion(Registry.CurrentUser,    subKey)
            ?? TryReadDisplayVersion(Registry.LocalMachine,   subKey);
    }

    private static string? FindByDisplayName(string displayName)
    {
        foreach (var hive in new[] { Registry.CurrentUser, Registry.LocalMachine })
        {
            foreach (var path in _uninstallPaths)
            {
                using var parent = hive.OpenSubKey(path);
                if (parent is null) continue;

                foreach (var name in parent.GetSubKeyNames())
                {
                    using var key = parent.OpenSubKey(name);
                    if (key is null) continue;
                    var dn = key.GetValue("DisplayName") as string;
                    if (string.Equals(dn, displayName, StringComparison.OrdinalIgnoreCase))
                        return key.GetValue("DisplayVersion") as string;
                }
            }
        }
        return null;
    }

    private static string? TryReadDisplayVersion(RegistryKey hive, string subKey)
    {
        foreach (var path in _uninstallPaths)
        {
            using var key = hive.OpenSubKey($@"{path}\{subKey}");
            if (key is null) continue;
            return key.GetValue("DisplayVersion") as string;
        }
        return null;
    }

    // ── Simple version compare (numeric, e.g. "2.8.2" vs "2.8.1") ────────────

    private static bool VersionIsNewer(string remote, string local)
    {
        if (!Version.TryParse(remote, out var r)) return false;
        if (!Version.TryParse(local,  out var l)) return false;
        return r > l;
    }
}
