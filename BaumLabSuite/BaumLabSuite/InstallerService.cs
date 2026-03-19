using System.Diagnostics;
using System.Net.Http;

namespace BaumLabSuite;

internal static class InstallerService
{
    private static readonly HttpClient _http = new();
    private static readonly string _tmpDir =
        Path.Combine(Path.GetTempPath(), "BaumLabSuite");

    static InstallerService()
    {
        _http.DefaultRequestHeaders.Add("User-Agent", "BaumLabSuite/1.0");
        _http.Timeout = TimeSpan.FromMinutes(10);
        Directory.CreateDirectory(_tmpDir);
    }

    /// <summary>
    /// Downloads and silently installs (or updates) <paramref name="app"/>.
    /// Reports byte-level download progress via <paramref name="onProgress"/> (0–100).
    /// </summary>
    public static async Task InstallAsync(
        AppDefinition      app,
        Action<int>        onProgress,
        Action<string>     onLog,
        CancellationToken  ct = default)
    {
        if (app.DownloadUrl is null)
        {
            app.Status       = AppStatus.Failed;
            app.ErrorMessage = "No download URL available.";
            return;
        }

        app.Status = AppStatus.Installing;
        string exePath = Path.Combine(_tmpDir, $"{app.Name}-Setup.exe");

        // ── Download ─────────────────────────────────────────────────────────
        try
        {
            onLog($"Downloading {app.Name} v{app.LatestVersion}…");
            using var response = await _http.GetAsync(app.DownloadUrl,
                HttpCompletionOption.ResponseHeadersRead, ct);
            response.EnsureSuccessStatusCode();

            long? total = response.Content.Headers.ContentLength;
            await using var src  = await response.Content.ReadAsStreamAsync(ct);
            await using var dest = File.Create(exePath);

            byte[] buf     = new byte[81920];
            long   written = 0;
            int    read;
            while ((read = await src.ReadAsync(buf, ct)) > 0)
            {
                await dest.WriteAsync(buf.AsMemory(0, read), ct);
                written += read;
                if (total > 0)
                    onProgress((int)(written * 100 / total.Value));
            }
            onProgress(100);
        }
        catch (OperationCanceledException)
        {
            app.Status       = AppStatus.Failed;
            app.ErrorMessage = "Cancelled.";
            return;
        }
        catch (Exception ex)
        {
            app.Status       = AppStatus.Failed;
            app.ErrorMessage = $"Download failed: {ex.Message}";
            onLog($"Error: {app.ErrorMessage}");
            return;
        }

        // ── Run installer silently ────────────────────────────────────────────
        try
        {
            onLog($"Installing {app.Name}…");
            var psi = new ProcessStartInfo(exePath)
            {
                // /VERYSILENT   = no UI at all
                // /NORESTART    = don't reboot
                // /CLOSEAPPLICATIONS = close running instances automatically
                Arguments       = "/VERYSILENT /NORESTART /CLOSEAPPLICATIONS",
                UseShellExecute = true,   // required for UAC elevation prompt if needed
            };
            using var proc = Process.Start(psi)
                ?? throw new Exception("Failed to start installer process.");
            await proc.WaitForExitAsync(ct);

            if (proc.ExitCode != 0)
                throw new Exception($"Installer exited with code {proc.ExitCode}.");

            app.Status           = AppStatus.Done;
            app.InstalledVersion = app.LatestVersion;
            onLog($"{app.Name} installed successfully.");
        }
        catch (OperationCanceledException)
        {
            app.Status       = AppStatus.Failed;
            app.ErrorMessage = "Cancelled during install.";
        }
        catch (Exception ex)
        {
            app.Status       = AppStatus.Failed;
            app.ErrorMessage = ex.Message;
            onLog($"Error: {app.ErrorMessage}");
        }
        finally
        {
            try { File.Delete(exePath); } catch { }
        }
    }
}
