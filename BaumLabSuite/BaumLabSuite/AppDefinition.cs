namespace BaumLabSuite;

public enum AppStatus
{
    Unknown,
    Checking,
    NotInstalled,
    UpToDate,
    UpdateAvailable,
    Installing,
    Done,
    Failed,
    NoRelease,
}

/// <summary>Metadata and runtime state for one Baum app.</summary>
public class AppDefinition
{
    // ── Static metadata ──────────────────────────────────────────────────────

    public string Name        { get; init; } = "";
    public string Repo        { get; init; } = "";   // GitHub repo name
    public string Description { get; init; } = "";

    /// <summary>
    /// Inno Setup AppId GUID (without braces), used to find the registry
    /// uninstall entry <c>{Guid}_is1</c>.
    /// </summary>
    public string InnoAppId   { get; init; } = "";

    // ── Runtime state ─────────────────────────────────────────────────────────

    public AppStatus Status           { get; set; } = AppStatus.Unknown;
    public string?   InstalledVersion { get; set; }
    public string?   LatestVersion    { get; set; }
    public string?   DownloadUrl      { get; set; }
    public string?   ErrorMessage     { get; set; }
    public bool      IsSelected       { get; set; } = true;

    // ── Helpers ───────────────────────────────────────────────────────────────

    public bool IsInstalled => InstalledVersion != null;

    public string StatusText => Status switch
    {
        AppStatus.Checking         => "Checking…",
        AppStatus.NotInstalled     => "Not installed",
        AppStatus.UpToDate         => $"Up to date  v{InstalledVersion}",
        AppStatus.UpdateAvailable  => $"Update available  v{LatestVersion}",
        AppStatus.Installing       => "Installing…",
        AppStatus.Done             => $"Installed  v{LatestVersion}",
        AppStatus.Failed           => $"Failed: {ErrorMessage}",
        AppStatus.NoRelease        => "No release available",
        _                          => "—",
    };

    public System.Drawing.Color StatusColor => Status switch
    {
        AppStatus.UpToDate         => AppTheme.Success,
        AppStatus.UpdateAvailable  => AppTheme.Warning,
        AppStatus.Done             => AppTheme.Success,
        AppStatus.Failed           => AppTheme.Danger,
        AppStatus.NoRelease        => AppTheme.Muted,
        AppStatus.Installing       => AppTheme.Accent,
        _                          => AppTheme.TextSecondary,
    };

    public bool CanAct => Status is AppStatus.NotInstalled
                                  or AppStatus.UpdateAvailable
                                  or AppStatus.Failed;

    /// <summary>Two-letter abbreviation shown in the icon tile.</summary>
    public string Initials => Name.Length >= 2
        ? Name.Replace("Baum", "")[..Math.Min(2, Name.Replace("Baum", "").Length)].ToUpper()
        : Name[..1].ToUpper();
}
