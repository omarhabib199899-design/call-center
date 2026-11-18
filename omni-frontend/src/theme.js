// Light / dark theme for the new interface
const KEY = "omni.theme";

export function getTheme() {
  try {
    const t = localStorage.getItem(KEY);
    if (t === "dark" || t === "light") return t;
  } catch {}
  return "light";
}

export function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  try {
    localStorage.setItem(KEY, t);
  } catch {}
  window.dispatchEvent(new CustomEvent("omni-theme", { detail: t }));
}

// Set before the first paint so the page doesn't flash light
document.documentElement.dataset.theme = getTheme();
