namespace BaumLabSuite;

/// <summary>The canonical list of all BaumLab apps managed by the suite.</summary>
internal static class AppCatalog
{
    public static List<AppDefinition> All() =>
    [
        new()
        {
            Name        = "BaumDash",
            Repo        = "BaumDash",
            Description = "Ultrawide desktop dashboard — audio mixer, media, Discord, system stats",
            InnoAppId   = "F1E2D3C4-B5A6-4789-9ABC-DEF012345678",
        },
        new()
        {
            Name        = "BaumLaunch",
            Repo        = "BaumLaunch",
            Description = "WinGet GUI package manager with system tray updater and curated app catalog",
            InnoAppId   = "A1B2C3D4-E5F6-7890-ABCD-EF1234567890",
        },
        new()
        {
            Name        = "BaumAdminTool",
            Repo        = "BaumAdminTool",
            Description = "Windows admin utility — system info, process monitor, RoboCopy backup, event logs",
            InnoAppId   = "B3C4D5E6-F7A8-9B0C-1D2E-3F4A5B6C7D8E",
        },
        new()
        {
            Name        = "BaumSecure",
            Repo        = "BaumSecure",
            Description = "Homelab security analyzer — scans external attack surface and flags misconfigurations",
            InnoAppId   = "B3C4D5E6-F7A8-9012-BCDE-F01234567890",
        },
        new()
        {
            Name        = "BaumScriptCodex",
            Repo        = "BaumScriptCodex",
            Description = "Script library for IT admins — store, search, and copy PowerShell/Bash/Batch scripts",
            InnoAppId   = "C1D2E3F4-A5B6-7890-CDEF-012345678901",
        },
        new()
        {
            Name        = "BaumKeyGenerator",
            Repo        = "BaumKeyGenerator",
            Description = "Secret key generator — hex, base64, JWT, database passwords, Vaultwarden tokens",
            InnoAppId   = "B4A7C3D2-E5F6-4890-BCDE-F12345678901",
        },
        new()
        {
            Name        = "BaumConfigure",
            Repo        = "BaumConfigure",
            Description = "Turing Pi 2 node configurator — generate cloud-init images, set hostname/users/SSH keys, flash via BMC",
            InnoAppId   = "D4E5F6A7-B8C9-0DA1-B2C3-D4E5F6A7B8C9",
        },
    ];
}
