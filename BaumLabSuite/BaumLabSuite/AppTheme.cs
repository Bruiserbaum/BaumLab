using System.Drawing;

namespace BaumLabSuite;

internal static class AppTheme
{
    public static readonly Color Background    = Color.FromArgb(18, 18, 24);
    public static readonly Color Surface       = Color.FromArgb(26, 26, 36);
    public static readonly Color SurfaceAlt    = Color.FromArgb(34, 34, 48);
    public static readonly Color SurfaceHover  = Color.FromArgb(42, 42, 60);
    public static readonly Color Border        = Color.FromArgb(55, 55, 75);

    public static readonly Color Accent        = Color.FromArgb(99, 102, 241);
    public static readonly Color AccentHover   = Color.FromArgb(129, 132, 255);
    public static readonly Color AccentPressed = Color.FromArgb(79,  82, 210);
    public static readonly Color Success       = Color.FromArgb(34,  197,  94);
    public static readonly Color Warning       = Color.FromArgb(234, 179,   8);
    public static readonly Color Danger        = Color.FromArgb(239,  68,  68);
    public static readonly Color Muted         = Color.FromArgb(90,   90, 120);

    public static readonly Color TextPrimary   = Color.FromArgb(230, 230, 245);
    public static readonly Color TextSecondary = Color.FromArgb(148, 148, 175);
    public static readonly Color TextMuted     = Color.FromArgb(90,   90, 120);

    public static readonly Font FontBase       = new("Segoe UI",  10f, FontStyle.Regular);
    public static readonly Font FontSmall      = new("Segoe UI",   9f, FontStyle.Regular);
    public static readonly Font FontLabel      = new("Segoe UI",   9f, FontStyle.Bold);
    public static readonly Font FontTitle      = new("Segoe UI",  14f, FontStyle.Bold);
    public static readonly Font FontSubtitle   = new("Segoe UI",  10f, FontStyle.Regular);
    public static readonly Font FontAppName    = new("Segoe UI",  11f, FontStyle.Bold);

    public static void ApplyToForm(Form f)
    {
        f.BackColor = Background;
        f.ForeColor = TextPrimary;
        f.Font      = FontBase;
    }

    public static void StylePrimary(Button b)
    {
        b.BackColor   = Accent;
        b.ForeColor   = Color.White;
        b.FlatStyle   = FlatStyle.Flat;
        b.FlatAppearance.BorderSize = 0;
        b.Font        = FontBase;
        b.Cursor      = Cursors.Hand;
        b.MouseEnter += (_, _) => b.BackColor = AccentHover;
        b.MouseLeave += (_, _) => b.BackColor = Accent;
        b.MouseDown  += (_, _) => b.BackColor = AccentPressed;
        b.MouseUp    += (_, _) => b.BackColor = Accent;
    }

    public static void StyleSecondary(Button b)
    {
        b.BackColor   = SurfaceAlt;
        b.ForeColor   = TextPrimary;
        b.FlatStyle   = FlatStyle.Flat;
        b.FlatAppearance.BorderSize  = 1;
        b.FlatAppearance.BorderColor = Border;
        b.Font        = FontBase;
        b.Cursor      = Cursors.Hand;
        b.MouseEnter += (_, _) => b.BackColor = SurfaceHover;
        b.MouseLeave += (_, _) => b.BackColor = SurfaceAlt;
    }
}
