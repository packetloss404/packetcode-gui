// Project selection: path helpers plus a small localStorage-backed MRU of
// recently opened project directories. Paths are stored exactly as the OS
// dialog (or the engine's session summaries) reported them; normalization is
// only used for comparisons and display.

const RECENT_KEY = "packetcode.recentProjects";
const ACTIVE_KEY = "packetcode.activeProject";
const MAX_RECENT = 8;

/** Last path segment of a directory, used as the human-facing project name. */
export function projectName(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** Comparison key: forward slashes, no trailing slash, and case-folded for
 * Windows-style (drive-lettered or UNC) paths where the filesystem is
 * case-insensitive. POSIX paths keep their case. */
export function pathKey(path: string): string {
  let p = path.replace(/\\/g, "/");
  while (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  return /^([a-zA-Z]:|\/\/)/.test(p) ? p.toLowerCase() : p;
}

export function samePath(a: string, b: string): boolean {
  return pathKey(a) === pathKey(b);
}

function readStringArray(key: string): string[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === "string" && v.length > 0);
  } catch {
    return [];
  }
}

export function loadRecentProjects(): string[] {
  return readStringArray(RECENT_KEY).slice(0, MAX_RECENT);
}

export function loadActiveProject(): string | null {
  try {
    const raw = localStorage.getItem(ACTIVE_KEY);
    return raw && raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

/** Marks `path` as the active project and moves it to the front of the MRU.
 * Returns the updated recent list. Storage failures are non-fatal: the
 * in-memory list still updates, persistence just skips a beat. */
export function rememberProject(path: string, recent: string[]): string[] {
  const next = [path, ...recent.filter((p) => !samePath(p, path))].slice(
    0,
    MAX_RECENT,
  );
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
    localStorage.setItem(ACTIVE_KEY, path);
  } catch {
    // Quota/privacy-mode failures leave persistence stale; session state wins.
  }
  return next;
}
