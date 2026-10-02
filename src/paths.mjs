import fs from "node:fs";
import path from "node:path";

// The one function that turns "a path somebody typed" into "the key a claim is stored under".
// The hook, the MCP server and the CLI all go through it; if any of them derived keys
// differently, a claim made one way would be invisible to a check made another way and the
// lock would silently stop working.
//
// 1. Resolve against cwd and collapse `.`/`..`, for absolute paths too
//    (`/repo/x/../a.js` is `/repo/a.js`).
// 2. realpath the deepest ancestor that exists and keep the not-yet-existing tail, so a
//    Write to a new file through a symlinked directory (or macOS's /tmp -> /private/tmp)
//    lands on the same key as the real path. The native realpath also returns the on-disk
//    spelling on case-insensitive volumes, so `README.MD` and `README.md` are one key on
//    macOS when the file exists.
// 3. win32: upper-case the drive letter and fold case, since NTFS is case-insensitive by
//    default and realpath can't canonicalize a tail that doesn't exist yet.
//
// Known gap: two different-case spellings of a file that doesn't exist yet, on a
// case-insensitive macOS volume, are two keys until the file is created.
export function canonicalPath(filePath, cwd, { pathLib = path, realpath = fs.realpathSync.native } = {}) {
  if (typeof filePath !== "string" || filePath === "" || filePath.includes("\0")) {
    throw new TypeError("file path must be a non-empty string without NUL bytes");
  }
  const win = pathLib === path.win32 || (pathLib === path && process.platform === "win32");
  let abs = pathLib.resolve(cwd ?? process.cwd(), filePath);

  const tail = [];
  let cur = abs;
  for (;;) {
    try {
      const real = realpath(cur);
      abs = tail.length ? pathLib.join(real, ...tail.reverse()) : real;
      break;
    } catch {
      const parent = pathLib.dirname(cur);
      if (parent === cur) break; // nothing on this path exists (or no fs): lexical result stands
      tail.push(pathLib.basename(cur));
      cur = parent;
    }
  }

  if (win) {
    abs = abs.toLowerCase().replace(/^([a-z]):/, (_, d) => `${d.toUpperCase()}:`);
  }
  return abs;
}
