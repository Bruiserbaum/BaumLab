using System.Drawing;
using System.Windows.Forms;

namespace BaumLabSuite;

public class MainForm : Form
{
    // ── App list ──────────────────────────────────────────────────────────────
    private readonly List<AppDefinition> _apps = AppCatalog.All();
    private readonly List<AppRow>        _rows = [];

    // ── Controls ──────────────────────────────────────────────────────────────
    private readonly Panel       _listPanel     = new();
    private readonly Button      _selectAllBtn  = new() { Text = "Select All" };
    private readonly Button      _selectNoneBtn = new() { Text = "Select None" };
    private readonly Button      _refreshBtn    = new() { Text = "Refresh" };
    private readonly Button      _actionBtn     = new() { Text = "Install / Update Selected" };
    private readonly ProgressBar _progressBar   = new();
    private readonly Label       _progressLabel = new();
    private readonly RichTextBox _logBox        = new();
    private readonly Label       _statusLabel   = new();

    private CancellationTokenSource? _cts;

    public MainForm()
    {
        BuildUI();
        _ = RefreshAsync();
    }

    // ── UI construction ───────────────────────────────────────────────────────

    private void BuildUI()
    {
        Text            = "BaumLab Suite";
        Size            = new Size(820, 700);
        MinimumSize     = new Size(700, 560);
        StartPosition   = FormStartPosition.CenterScreen;
        FormBorderStyle = FormBorderStyle.Sizable;
        AppTheme.ApplyToForm(this);

        var root = new TableLayoutPanel
        {
            Dock        = DockStyle.Fill,
            RowCount    = 5,
            ColumnCount = 1,
            BackColor   = AppTheme.Background,
            Padding     = new Padding(14),
        };
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 64));   // header
        root.RowStyles.Add(new RowStyle(SizeType.Percent, 100));   // app list
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 50));   // button bar
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 38));   // progress
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 120));  // log
        Controls.Add(root);

        root.Controls.Add(BuildHeader(),    0, 0);
        root.Controls.Add(BuildListCard(),  0, 1);
        root.Controls.Add(BuildButtonBar(), 0, 2);
        root.Controls.Add(BuildProgress(),  0, 3);
        root.Controls.Add(BuildLog(),       0, 4);
    }

    private static Panel BuildHeader()
    {
        var p = new Panel { Dock = DockStyle.Fill, BackColor = Color.Transparent };

        var title = new Label
        {
            Text      = "BaumLab Suite",
            Font      = AppTheme.FontTitle,
            ForeColor = AppTheme.TextPrimary,
            BackColor = Color.Transparent,
            AutoSize  = true,
            Location  = new Point(0, 6),
        };
        var sub = new Label
        {
            Text      = "Install and keep all your BaumLab apps up to date",
            Font      = AppTheme.FontSubtitle,
            ForeColor = AppTheme.TextSecondary,
            BackColor = Color.Transparent,
            AutoSize  = true,
            Location  = new Point(2, 34),
        };
        p.Controls.Add(title);
        p.Controls.Add(sub);
        return p;
    }

    private Panel BuildListCard()
    {
        var card = new Panel
        {
            Dock      = DockStyle.Fill,
            BackColor = AppTheme.Surface,
            Padding   = new Padding(0),
        };

        // Scrollable inner panel
        _listPanel.Dock          = DockStyle.Fill;
        _listPanel.BackColor     = AppTheme.Surface;
        _listPanel.AutoScroll    = true;
        _listPanel.Padding       = new Padding(0);

        foreach (var app in _apps)
        {
            var row = new AppRow(app);
            _rows.Add(row);
            _listPanel.Controls.Add(row);
        }

        card.Controls.Add(_listPanel);
        return card;
    }

    private Panel BuildButtonBar()
    {
        var bar = new TableLayoutPanel
        {
            Dock        = DockStyle.Fill,
            ColumnCount = 5,
            RowCount    = 1,
            BackColor   = Color.Transparent,
            Padding     = new Padding(0, 8, 0, 0),
        };
        bar.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 100));
        bar.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 100));
        bar.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 90));
        bar.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        bar.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 220));

        _selectAllBtn.Dock  = DockStyle.Fill;
        _selectAllBtn.Margin = new Padding(0, 0, 6, 0);
        AppTheme.StyleSecondary(_selectAllBtn);
        _selectAllBtn.Click += (_, _) => SetAllSelected(true);
        bar.Controls.Add(_selectAllBtn, 0, 0);

        _selectNoneBtn.Dock   = DockStyle.Fill;
        _selectNoneBtn.Margin = new Padding(0, 0, 6, 0);
        AppTheme.StyleSecondary(_selectNoneBtn);
        _selectNoneBtn.Click += (_, _) => SetAllSelected(false);
        bar.Controls.Add(_selectNoneBtn, 1, 0);

        _refreshBtn.Dock   = DockStyle.Fill;
        _refreshBtn.Margin = new Padding(0, 0, 0, 0);
        AppTheme.StyleSecondary(_refreshBtn);
        _refreshBtn.Click += (_, _) => _ = RefreshAsync();
        bar.Controls.Add(_refreshBtn, 2, 0);

        // spacer col 3 is empty

        _actionBtn.Dock   = DockStyle.Fill;
        _actionBtn.Margin = new Padding(0);
        AppTheme.StylePrimary(_actionBtn);
        _actionBtn.Click += (_, _) => _ = InstallSelectedAsync();
        bar.Controls.Add(_actionBtn, 4, 0);

        return bar;
    }

    private Panel BuildProgress()
    {
        var grid = new TableLayoutPanel
        {
            Dock        = DockStyle.Fill,
            ColumnCount = 2,
            RowCount    = 1,
            BackColor   = Color.Transparent,
            Padding     = new Padding(0, 4, 0, 0),
        };
        grid.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        grid.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 200));

        _progressBar.Dock    = DockStyle.Fill;
        _progressBar.Margin  = new Padding(0, 6, 8, 0);
        _progressBar.Minimum = 0;
        _progressBar.Maximum = 100;
        _progressBar.Style   = ProgressBarStyle.Continuous;
        _progressBar.BackColor = AppTheme.SurfaceAlt;
        _progressBar.ForeColor = AppTheme.Accent;
        grid.Controls.Add(_progressBar, 0, 0);

        _progressLabel.Dock      = DockStyle.Fill;
        _progressLabel.ForeColor = AppTheme.TextSecondary;
        _progressLabel.Font      = AppTheme.FontSmall;
        _progressLabel.BackColor = Color.Transparent;
        _progressLabel.TextAlign = ContentAlignment.MiddleLeft;
        grid.Controls.Add(_progressLabel, 1, 0);

        return grid;
    }

    private Panel BuildLog()
    {
        var p = new Panel { Dock = DockStyle.Fill, BackColor = Color.Transparent, Padding = new Padding(0, 4, 0, 0) };

        _logBox.Dock      = DockStyle.Fill;
        _logBox.ReadOnly  = true;
        _logBox.BackColor = AppTheme.SurfaceAlt;
        _logBox.ForeColor = AppTheme.TextSecondary;
        _logBox.Font      = new Font("Cascadia Mono", 8.5f);
        _logBox.BorderStyle = BorderStyle.None;
        _logBox.ScrollBars  = RichTextBoxScrollBars.Vertical;

        p.Controls.Add(_logBox);
        return p;
    }

    // ── Logic ─────────────────────────────────────────────────────────────────

    private async Task RefreshAsync()
    {
        SetBusy(true, "Checking for updates…");
        Log("Checking GitHub releases and installed versions…");

        foreach (var row in _rows)
        {
            row.App.Status = AppStatus.Checking;
            row.RefreshState();
        }

        // Fetch all releases in parallel
        var tasks = _apps.Select(GitHubService.FetchLatestAsync).ToArray();
        await Task.WhenAll(tasks);

        // Resolve installed versions from registry
        foreach (var app in _apps)
            RegistryHelper.Resolve(app);

        // Update UI rows
        foreach (var row in _rows)
            row.RefreshState();

        int installed   = _apps.Count(a => a.IsInstalled);
        int updates     = _apps.Count(a => a.Status == AppStatus.UpdateAvailable);
        int notInstalled = _apps.Count(a => a.Status == AppStatus.NotInstalled);

        Log($"Done. {installed} installed, {updates} update(s) available, {notInstalled} not installed.");
        SetBusy(false, updates > 0
            ? $"{updates} update(s) available"
            : "All apps up to date");

        UpdateActionButton();
    }

    private async Task InstallSelectedAsync()
    {
        var targets = _apps.Where(a => a.IsSelected && a.CanAct).ToList();
        if (targets.Count == 0)
        {
            Log("Nothing to install or update — select apps that are not installed or have updates.");
            return;
        }

        _cts = new CancellationTokenSource();
        SetBusy(true, $"Installing {targets.Count} app(s)…");
        _actionBtn.Enabled = false;

        foreach (var app in targets)
        {
            var row = _rows.First(r => r.App == app);
            _progressBar.Value = 0;
            _progressLabel.Text = app.Name;

            await InstallerService.InstallAsync(
                app,
                pct =>
                {
                    if (IsDisposed) return;
                    Invoke(() => _progressBar.Value = pct);
                },
                msg =>
                {
                    if (IsDisposed) return;
                    Invoke(() => Log(msg));
                },
                _cts.Token);

            Invoke(() =>
            {
                RegistryHelper.Resolve(app);
                row.RefreshState();
            });
        }

        SetBusy(false, "Done.");
        _actionBtn.Enabled = true;
        UpdateActionButton();
        _progressLabel.Text = "";
        Log("All selected installs complete.");
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private void SetAllSelected(bool value)
    {
        foreach (var row in _rows)
        {
            row.App.IsSelected = value;
            row.RefreshState();
        }
    }

    private void SetBusy(bool busy, string msg)
    {
        _refreshBtn.Enabled    = !busy;
        _progressLabel.Text    = msg;
        if (!busy) _progressBar.Value = 0;
    }

    private void UpdateActionButton()
    {
        int actionable = _apps.Count(a => a.IsSelected && a.CanAct);
        _actionBtn.Text    = actionable == 0
            ? "Nothing to Install"
            : $"Install / Update Selected ({actionable})";
        _actionBtn.Enabled = actionable > 0;
        if (actionable == 0)
        {
            _actionBtn.BackColor = AppTheme.SurfaceAlt;
            _actionBtn.ForeColor = AppTheme.TextMuted;
        }
        else
        {
            _actionBtn.BackColor = AppTheme.Accent;
            _actionBtn.ForeColor = Color.White;
        }
    }

    private void Log(string message)
    {
        _logBox.AppendText($"[{DateTime.Now:HH:mm:ss}] {message}\n");
        _logBox.ScrollToCaret();
    }

    protected override void OnFormClosed(FormClosedEventArgs e)
    {
        _cts?.Cancel();
        base.OnFormClosed(e);
    }
}
