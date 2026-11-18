"""Generate src/styles/dark.css from the page stylesheets.
Every colour-bearing declaration gets a dark twin under html[data-theme="dark"].
Run: python3 -I tools/gen_dark.py omni-frontend/src"""
import re, sys, os, colorsys, tinycss2
SRC = sys.argv[1]
FILES = ["styles/tokens.css", "components/CommandPalette.css", "components/ClassicFrame.css",
         "pages/Home/Home.css", "pages/AgentChannels/AgentChannels.css", "pages/Campaigns/Campaigns.css",
         "pages/LeadSources/LeadSources.css", "pages/Inbox/Inbox.css"]
PROPS = re.compile(r"^(color|background|background-color|background-image|border|border-(top|right|bottom|left)(-color)?|border-color|outline|outline-color|box-shadow|fill|stroke|caret-color|text-decoration-color|accent-color|column-rule)$")
NAMED = {"white": "#ffffff", "black": "#000000"}
COL = re.compile(r"#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|\bwhite\b|\bblack\b")

def parse(c):
    c = NAMED.get(c, c)
    if c.startswith("#"):
        h = c[1:]
        if len(h) in (3, 4): h = "".join(x * 2 for x in h)
        r, g, b = (int(h[i:i+2], 16) / 255 for i in (0, 2, 4))
        a = int(h[6:8], 16) / 255 if len(h) == 8 else 1
        return r, g, b, a
    n = [float(x.strip().rstrip("%")) for x in re.split(r"[,/ ]+", c[c.index("(")+1:-1].strip()) if x.strip()]
    return n[0] / 255, n[1] / 255, n[2] / 255, (n[3] if len(n) > 3 else 1)

def fmt(r, g, b, a):
    if a >= 0.999: return "#%02x%02x%02x" % tuple(round(max(0, min(1, x)) * 255) for x in (r, g, b))
    return "rgba(%d, %d, %d, %.3g)" % (round(r*255), round(g*255), round(b*255), a)

SLATE = 222 / 360

def role_of(prop):
    if prop in ("color", "fill", "stroke", "caret-color", "text-decoration-color", "accent-color"): return "fg"
    if prop.startswith("background"): return "bg"
    if prop == "box-shadow": return "shadow"
    return "line"

def remap(c, role):
    r, g, b, a = parse(c)
    h, l, s = colorsys.rgb_to_hls(r, g, b)
    grey = s < 0.18 or l > 0.97
    if role == "shadow":
        if l < 0.2: return fmt(0, 0, 0, min(1, a * 2.2))   # deeper shadows read on dark
        return fmt(*colorsys.hls_to_rgb(h, 0.28, min(s, .4)), a) if l > .8 else c
    if a < 0.35 and role != "fg":
        # translucent tints: white veils stay, dark veils become light veils
        if l < 0.3: return fmt(1, 1, 1, a * 0.9)
        return c
    if role == "bg":
        if grey:
            if l >= 0.9: nl = 0.075 + (l - 0.9) * 0.6     # white card .135, page ~.10
            elif l >= 0.6: nl = 0.15 + (0.9 - l) * 0.35
            else: return c
            return fmt(*colorsys.hls_to_rgb(SLATE, nl, 0.2), a)
        if l > 0.85: return fmt(*colorsys.hls_to_rgb(h, 0.17, min(s, 0.45)), a)
        if l > 0.7: return fmt(*colorsys.hls_to_rgb(h, 0.26, min(s, 0.5)), a)
        return c
    if role == "line":
        if grey:
            if l >= 0.6: return fmt(*colorsys.hls_to_rgb(SLATE, 0.2 + (1 - l) * 0.45, 0.14), a)
            if l < 0.3: return fmt(*colorsys.hls_to_rgb(h, 0.75, s), a)
            return c
        if l > 0.8: return fmt(*colorsys.hls_to_rgb(h, 0.3, min(s, .5)), a)
        if l < 0.3: return fmt(*colorsys.hls_to_rgb(h, 0.62, min(s, .7)), a)
        return c
    # fg
    if l < 0.2: return fmt(*colorsys.hls_to_rgb(SLATE, 0.92 - l * 0.4, 0.12), a)
    if grey:
        if l < 0.6: return fmt(*colorsys.hls_to_rgb(h, 0.93 - l * 0.55, s), a)
        if l < 0.85: return fmt(*colorsys.hls_to_rgb(h, max(0.55, l - 0.08), s), a)
        return c
    if l < 0.45: return fmt(*colorsys.hls_to_rgb(h, 0.74, min(s, 0.85)), a)
    return c

def vars_of(rules):
    v = {}
    for r in rules:
        if r.type != "qualified-rule": continue
        for d in tinycss2.parse_blocks_contents(r.content, skip_whitespace=True, skip_comments=True):
            if d.type == "declaration" and d.name.startswith("--"):
                v[d.name] = tinycss2.serialize(d.value).strip()
    return v

def resolve(val, V, depth=0):
    if depth > 5: return val
    def sub(m):
        name, fb = m.group(1), m.group(2)
        return resolve(V.get(name, fb.strip() if fb else ""), V, depth + 1)
    return re.sub(r"var\((--[\w-]+)\s*(?:,\s*([^)]*))?\)", sub, val)

def scope(sel):
    out = []
    for part in sel.split(","):
        p = part.strip()
        if not p: continue
        if p in (":root", "html"): out.append('html[data-theme="dark"]')
        elif p.startswith("html"): out.append('html[data-theme="dark"]' + p[4:])
        else: out.append('html[data-theme="dark"] ' + p)
    return ", ".join(out)

def walk(rules, V, out, file):
    for r in rules:
        if r.type == "at-rule" and r.lower_at_keyword == "media" and r.content:
            inner = []
            walk(tinycss2.parse_rule_list(r.content, skip_whitespace=True, skip_comments=True), V, inner, file)
            if inner: out.append("@media " + tinycss2.serialize(r.prelude).strip() + " {\n" + "\n".join("  " + x for x in inner) + "\n}")
            continue
        if r.type != "qualified-rule": continue
        sel = tinycss2.serialize(r.prelude).strip()
        if file.endswith("tokens.css") and sel not in ("body",): continue
        ds = [d for d in tinycss2.parse_blocks_contents(r.content, skip_whitespace=True, skip_comments=True) if d.type == "declaration"]
        keep_fg = False
        for d in ds:
            if d.name in ("background", "background-color"):
                v = resolve(tinycss2.serialize(d.value).strip(), V)
                m = COL.search(v)
                if m and remap(m.group(0), "bg") == m.group(0) and parse(m.group(0))[3] > 0.5: keep_fg = True
        decls = []
        for d in tinycss2.parse_blocks_contents(r.content, skip_whitespace=True, skip_comments=True):
            if d.type != "declaration" or d.name.startswith("--") or not PROPS.match(d.name): continue
            raw = tinycss2.serialize(d.value).strip()
            val = resolve(raw, V)
            if not COL.search(val): continue
            role = role_of(d.name)
            new = val if (role == "fg" and keep_fg) else COL.sub(lambda m: remap(m.group(0), role), val)
            # unchanged colours are emitted too, so the light cascade order still holds in dark
            if True:
                decls.append(f"{d.name}: {new}{' !important' if d.important else ''};")
        if decls: out.append(scope(sel) + " { " + " ".join(decls) + " }")

out = ["/* GENERATED by tools/gen_dark.py from the page stylesheets — do not edit by hand. */",
       'html[data-theme="dark"] { color-scheme: dark; }']
for f in FILES:
    rules = tinycss2.parse_stylesheet(open(os.path.join(SRC, f)).read(), skip_whitespace=True, skip_comments=True)
    V = vars_of(rules)
    block = []
    walk(rules, V, block, f)
    out.append(f"\n/* ---- {f} ---- */")
    out += block
out.append("\n/* ---- hand-tuned ---- */")
out.append(open(os.path.join(SRC, "styles/dark-extra.css")).read())
open(os.path.join(SRC, "styles/dark.css"), "w").write("\n".join(out) + "\n")
print(len(out), "rules")
