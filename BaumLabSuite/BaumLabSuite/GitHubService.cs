using System.Net.Http;
using System.Net.Http.Json;
using System.Text.Json.Serialization;

namespace BaumLabSuite;

internal static class GitHubService
{
    private static readonly HttpClient _http = new();
    private const string Owner = "Bruiserbaum";

    static GitHubService()
    {
        _http.DefaultRequestHeaders.Add("User-Agent", "BaumLabSuite/1.0");
        _http.Timeout = TimeSpan.FromSeconds(15);
    }

    /// <summary>
    /// Fetches the latest release for <paramref name="repo"/> and populates
    /// <see cref="AppDefinition.LatestVersion"/> and <see cref="AppDefinition.DownloadUrl"/>.
    /// </summary>
    public static async Task FetchLatestAsync(AppDefinition app)
    {
        app.Status = AppStatus.Checking;
        try
        {
            var release = await _http.GetFromJsonAsync<GitHubRelease>(
                $"https://api.github.com/repos/{Owner}/{app.Repo}/releases/latest");

            if (release is null)
            {
                app.Status = AppStatus.NoRelease;
                return;
            }

            app.LatestVersion = release.TagName?.TrimStart('v');

            // Find Setup.exe asset — handles both naming conventions:
            //   {AppName}-Setup-{version}.exe   (BaumDash, BaumLaunch, etc.)
            //   {AppName}-{version}-Setup.exe   (BaumKeyGenerator)
            app.DownloadUrl = release.Assets
                ?.FirstOrDefault(a =>
                    a.Name.Contains("Setup", StringComparison.OrdinalIgnoreCase) &&
                    a.Name.EndsWith(".exe", StringComparison.OrdinalIgnoreCase))
                ?.BrowserDownloadUrl;

            if (app.DownloadUrl is null)
            {
                app.Status = AppStatus.NoRelease;
                return;
            }

            // Status will be resolved by RegistryHelper after install check
        }
        catch (Exception ex)
        {
            app.Status       = AppStatus.Failed;
            app.ErrorMessage = ex.Message;
        }
    }

    // ── JSON models ───────────────────────────────────────────────────────────

    private sealed class GitHubRelease
    {
        [JsonPropertyName("tag_name")]
        public string? TagName { get; set; }

        [JsonPropertyName("assets")]
        public List<GitHubAsset>? Assets { get; set; }
    }

    private sealed class GitHubAsset
    {
        [JsonPropertyName("name")]
        public string Name { get; set; } = "";

        [JsonPropertyName("browser_download_url")]
        public string BrowserDownloadUrl { get; set; } = "";
    }
}
