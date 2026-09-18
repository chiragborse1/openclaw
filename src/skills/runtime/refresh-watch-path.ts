import fs from "node:fs";
import path from "node:path";

export function toWatchRoot(raw: string): string {
  const normalized = raw.replaceAll("\\", "/");
  const root = path.parse(normalized).root;
  const trimmed = normalized.replace(/\/+$/, "");
  // A missing path can anchor at a drive root; C: would watch the drive's cwd.
  return trimmed.length < root.length ? root : trimmed;
}

export function resolveSkillsWatchPath(raw: string): string {
  if (process.platform !== "win32") {
    return raw;
  }
  const absolute = path.resolve(raw);
  const root = path.parse(absolute).root;
  const parts = absolute.slice(root.length).split(path.sep);
  let cursor = root;
  let index = 0;
  // libuv cannot watch 8.3 directory aliases safely. Expand only the ordinary
  // existing prefix: following a symlink here would bypass followSymlinks:false
  // and the refresh owner's separate trusted skill-target resolution.
  for (const part of parts) {
    const next = path.join(cursor, part);
    try {
      if (fs.lstatSync(next).isSymbolicLink()) {
        break;
      }
    } catch {
      break;
    }
    cursor = next;
    index += 1;
  }
  try {
    return path.join(fs.realpathSync.native(cursor), ...parts.slice(index));
  } catch {
    return raw;
  }
}

export const DEFAULT_SKILLS_WATCH_IGNORED: RegExp[] = [
  /(^|[\\/])\.git([\\/]|$)/,
  /(^|[\\/])node_modules([\\/]|$)/,
  /(^|[\\/])dist([\\/]|$)/,
  // Python virtual environments and caches
  /(^|[\\/])\.venv([\\/]|$)/,
  /(^|[\\/])venv([\\/]|$)/,
  /(^|[\\/])__pycache__([\\/]|$)/,
  /(^|[\\/])\.mypy_cache([\\/]|$)/,
  /(^|[\\/])\.pytest_cache([\\/]|$)/,
  // Build artifacts and caches
  /(^|[\\/])build([\\/]|$)/,
  /(^|[\\/])\.cache([\\/]|$)/,
];

export function shouldIgnoreSkillsWatchPath(
  watchPath: string,
  stats?: { isDirectory?: () => boolean; isSymbolicLink?: () => boolean },
  usePolling = false,
): boolean {
  if (DEFAULT_SKILLS_WATCH_IGNORED.some((re) => re.test(watchPath))) {
    return true;
  }
  if (stats?.isDirectory?.() || stats?.isSymbolicLink?.()) {
    return false;
  }
  if (!stats) {
    return false;
  }
  if (usePolling && isSkillFileWatchPath(watchPath)) {
    return false;
  }
  // Regular files are surfaced through raw directory events below. Letting
  // chokidar include SKILL.md here registers per-file watchers and leaks FDs.
  return true;
}

export function isSkillFileWatchPath(watchPath: string): boolean {
  const normalized = watchPath.replaceAll("\\", "/");
  return (
    path.posix.basename(normalized) === "SKILL.md" &&
    !DEFAULT_SKILLS_WATCH_IGNORED.some((re) => re.test(watchPath))
  );
}

export function getRawWatchedPath(details: unknown): string | undefined {
  return typeof details === "object" &&
    details !== null &&
    "watchedPath" in details &&
    typeof details.watchedPath === "string"
    ? details.watchedPath
    : undefined;
}

export function rawPathToString(rawPath: unknown): string | undefined {
  if (typeof rawPath === "string") {
    return rawPath || undefined;
  }
  if (Buffer.isBuffer(rawPath)) {
    const decoded = rawPath.toString();
    return decoded || undefined;
  }
  return undefined;
}

export function resolveRawSkillsWatchPath(rawPath: string, details: unknown): string | undefined {
  if (path.isAbsolute(rawPath)) {
    return rawPath;
  }
  const watchedPath = getRawWatchedPath(details);
  return watchedPath ? path.join(watchedPath, rawPath) : undefined;
}
