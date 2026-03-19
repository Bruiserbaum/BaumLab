using System.Drawing;
using System.Drawing.Drawing2D;
using System.Windows.Forms;

namespace BaumLabSuite;

/// <summary>
/// A single row in the app list — checkbox, icon tile, name/description,
/// version info, and status badge. Redraws itself when the app's state changes.
/// </summary>
internal class AppRow : Panel
{
    private readonly AppDefinition _app;
    private readonly CheckBox      _check  = new();
    private readonly Label         _name   = new();
    private readonly Label         _desc   = new();
    private readonly Label         _status = new();
    private readonly Label         _ver    = new();

    private const int TileSize  = 44;
    private const int TileLeft  = 46;
    private const int TextLeft  = TileLeft + TileSize + 14;

    public AppDefinition App => _app;

    public AppRow(AppDefinition app)
    {
        _app = app;

        Height    = 68;
        Dock      = DockStyle.Top;
        BackColor = AppTheme.Surface;
        Padding   = new Padding(0);
        Margin    = new Padding(0);
        Cursor    = Cursors.Default;

        // Divider line at bottom
        Paint += (_, e) =>
        {
            using var pen = new Pen(AppTheme.Border, 1);
            e.Graphics.DrawLine(pen, 0, Height - 1, Width, Height - 1);

            DrawTile(e.Graphics);
        };

        // Checkbox
        _check.Checked   = app.IsSelected;
        _check.BackColor = Color.Transparent;
        _check.ForeColor = AppTheme.TextPrimary;
        _check.Size      = new Size(22, 22);
        _check.Location  = new Point(14, (Height - 22) / 2);
        _check.CheckedChanged += (_, _) => _app.IsSelected = _check.Checked;
        Controls.Add(_check);

        // Name
        _name.AutoSize  = false;
        _name.Font      = AppTheme.FontAppName;
        _name.ForeColor = AppTheme.TextPrimary;
        _name.BackColor = Color.Transparent;
        _name.Text      = app.Name;
        _name.Location  = new Point(TextLeft, 12);
        _name.Size      = new Size(260, 22);
        Controls.Add(_name);

        // Description
        _desc.AutoSize  = false;
        _desc.Font      = AppTheme.FontSmall;
        _desc.ForeColor = AppTheme.TextSecondary;
        _desc.BackColor = Color.Transparent;
        _desc.Text      = app.Description;
        _desc.Location  = new Point(TextLeft, 34);
        _desc.Size      = new Size(400, 18);
        Controls.Add(_desc);

        // Status badge (right side)
        _status.AutoSize  = false;
        _status.Font      = AppTheme.FontSmall;
        _status.BackColor = Color.Transparent;
        _status.TextAlign = ContentAlignment.MiddleRight;
        _status.Size      = new Size(260, 18);
        Controls.Add(_status);

        // Version hint
        _ver.AutoSize  = false;
        _ver.Font      = AppTheme.FontSmall;
        _ver.ForeColor = AppTheme.TextMuted;
        _ver.BackColor = Color.Transparent;
        _ver.TextAlign = ContentAlignment.MiddleRight;
        _ver.Size      = new Size(260, 18);
        Controls.Add(_ver);

        Resize += (_, _) => RepositionRight();
        RepositionRight();
        Refresh();
    }

    private void RepositionRight()
    {
        int rx = Width - 16;
        _status.Location = new Point(rx - _status.Width, 14);
        _ver.Location    = new Point(rx - _ver.Width,    34);
    }

    private void DrawTile(Graphics g)
    {
        g.SmoothingMode = SmoothingMode.AntiAlias;

        var rect = new RectangleF(TileLeft, (Height - TileSize) / 2f, TileSize, TileSize);
        float r  = TileSize * 0.20f;

        // Rounded rect background
        using var path = RoundRect(rect, r);
        using var bg   = new SolidBrush(AppTheme.Accent);
        g.FillPath(bg, path);

        // Initials
        string text = _app.Initials;
        using var font = new Font("Segoe UI", TileSize * 0.30f, FontStyle.Bold, GraphicsUnit.Pixel);
        using var sf   = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center };
        g.DrawString(text, font, Brushes.White, rect, sf);
    }

    private static GraphicsPath RoundRect(RectangleF rc, float r)
    {
        var p = new GraphicsPath();
        p.AddArc(rc.X,            rc.Y,            r*2, r*2, 180, 90);
        p.AddArc(rc.Right - r*2,  rc.Y,            r*2, r*2, 270, 90);
        p.AddArc(rc.Right - r*2,  rc.Bottom - r*2, r*2, r*2,   0, 90);
        p.AddArc(rc.X,            rc.Bottom - r*2, r*2, r*2,  90, 90);
        p.CloseFigure();
        return p;
    }

    /// <summary>Call on the UI thread after app state changes.</summary>
    public void RefreshState()
    {
        _status.Text      = _app.StatusText;
        _status.ForeColor = _app.StatusColor;

        _ver.Text = _app.LatestVersion != null
            ? $"Latest: v{_app.LatestVersion}"
            : "";

        // Disable checkbox while installing or done
        _check.Enabled = _app.Status is not (AppStatus.Installing or AppStatus.Done or AppStatus.Checking);
        _check.Checked = _app.IsSelected;

        // Highlight row if update available
        BackColor = _app.Status == AppStatus.UpdateAvailable
            ? Color.FromArgb(40, 234, 179, 8)
            : AppTheme.Surface;

        RepositionRight();
    }
}
