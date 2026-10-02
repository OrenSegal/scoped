import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { canonicalPath } from "../src/paths.mjs";

// No real filesystem behind these: `realpath` always says ENOENT, so only lexical
// normalization runs. That is what lets the win32 rules be tested on any OS.
const noFs = () => {
  const err = new Error("ENOENT");
  err.code = "ENOENT";
  throw err;
};

test("posix: relative paths resolve against cwd and `..` collapses", () => {
  const opts = { pathLib: path.posix, realpath: noFs };
  assert.equal(canonicalPath("a.js", "/repo", opts), "/repo/a.js");
  assert.equal(canonicalPath("/repo/x/../a.js", "/elsewhere", opts), "/repo/a.js");
  assert.equal(canonicalPath("./sub/./a.js", "/repo", opts), "/repo/sub/a.js");
});

test("win32: drive-letter case and separators don't split one file into two claims", () => {
  const opts = { pathLib: path.win32, realpath: noFs };
  const a = canonicalPath("C:\\repo\\a.js", "C:\\", opts);
  assert.equal(canonicalPath("c:\\repo\\sub\\..\\a.js", "C:\\", opts), a);
  assert.equal(canonicalPath("c:/repo/a.js", "C:\\", opts), a);
  assert.equal(canonicalPath("a.js", "c:\\repo", opts), a);
});

test("win32: names are case-folded, since NTFS is case-insensitive by default", () => {
  const opts = { pathLib: path.win32, realpath: noFs };
  assert.equal(canonicalPath("C:\\Repo\\A.js", "C:\\", opts), canonicalPath("c:\\repo\\a.JS", "C:\\", opts));
});

test("the deepest existing ancestor is realpath'd and the missing tail kept", () => {
  const realpath = (p) => {
    if (p === "/link" || p === "/link/dir") return p.replace("/link", "/real");
    if (p === "/") return "/";
    const err = new Error("ENOENT");
    err.code = "ENOENT";
    throw err;
  };
  assert.equal(canonicalPath("/link/dir/new/file.js", "/", { pathLib: path.posix, realpath }), "/real/dir/new/file.js");
});

test("empty, non-string and NUL-containing paths are rejected", () => {
  assert.throws(() => canonicalPath("", "/"), TypeError);
  assert.throws(() => canonicalPath(undefined, "/"), TypeError);
  assert.throws(() => canonicalPath("/a\0b", "/"), TypeError);
});
