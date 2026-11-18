const KEYS = { owner: "wacrm_user", agent: "wacrm_agent" };

function read(key) {
  try {
    return localStorage.getItem(key) || "";
  } catch {
    return "";
  }
}

// Which session to use
export function detectRole() {
  const forced = new URLSearchParams(location.search).get("as");
  if (forced === "agent" && read(KEYS.agent)) return "agent";
  if (forced === "owner" && read(KEYS.owner)) return "owner";
  if (read(KEYS.owner)) return "owner";
  if (read(KEYS.agent)) return "agent";
  return null;
}

export function tokenFor(role) {
  return read(KEYS[role]);
}

export function loginUrl(role) {
  return role === "agent" ? "/agent/login" : "/user/login";
}

export async function api(path, role, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${tokenFor(role)}`,
      ...(options.headers || {}),
    },
  });
  if (res.status === 401) throw Object.assign(new Error("Signed out"), { signedOut: true });
  return res.json();
}

// { name, email, roleLabel } for the footer
export async function loadMe(role) {
  const path = role === "agent" ? "/api/agent/get_me" : "/api/user/get_me?userOnly=1";
  const res = await api(path, role);
  if (!res?.success || !res.data) {
    throw Object.assign(new Error(res?.msg || "Signed out"), { signedOut: true });
  }
  const d = res.data;
  return {
    name: d.name || d.email || "User",
    email: d.email || "",
    roleLabel: role === "agent" ? "Agent" : "Owner",
  };
}

export function logout(role) {
  try {
    localStorage.removeItem(KEYS[role]);
  } catch {}
  location.href = loginUrl(role);
}
