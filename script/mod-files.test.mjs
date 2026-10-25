/**
 * The install primitive: what it promises about the old copy when a copy fails.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import "./lib/load-extension.mjs";

/** POSIX permissions: chmod 000 does not make a file unreadable on Windows. */
const POSIX_ONLY =
  process.platform === "win32" ? "chmod 000 does not make a file unreadable on Windows" : false;

const { installFolder, restoreBackup, InstallError } = await import("../.pi/lib/mod-files.ts");

test("a missing backup is reported, not assumed restored", () => {
  const home = mkdtempSync(path.join(tmpdir(), "modfiles-"));
  const target = path.join(home, "target");
  mkdirSync(target, { recursive: true });
  assert.equal(restoreBackup(target, path.join(home, "nope")), false, "no backup means the restore failed");
});

test("installFolder keeps the old copy when the copy itself fails", { skip: POSIX_ONLY }, () => {
  const home = mkdtempSync(path.join(tmpdir(), "modfiles-"));
  const source = path.join(home, "source");
  const target = path.join(home, "target");
  mkdirSync(source, { recursive: true });
  mkdirSync(target, { recursive: true });
  writeFileSync(path.join(target, "old.txt"), "old");
  // Make the source unreadable so cpSync fails before the old copy is moved.
  writeFileSync(path.join(source, "x.txt"), "x");
  chmodSync(path.join(source, "x.txt"), 0o000);
  let threw = false;
  try {
    installFolder(source, target);
  } catch (error) {
    threw = true;
    assert.ok(error instanceof InstallError, "the failure carries its own fields");
    assert.equal(error.restored, true, "the old copy never moved, so it is still there");
    assert.ok(existsSync(path.join(target, "old.txt")), "and it is on disk");
  } finally {
    chmodSync(path.join(source, "x.txt"), 0o600);
  }
  assert.equal(threw, true, "an unreadable source must fail the install");
});

test("a first install that fails says there was no previous copy", { skip: POSIX_ONLY }, () => {
  const home = mkdtempSync(path.join(tmpdir(), "modfiles-"));
  const source = path.join(home, "source");
  mkdirSync(source, { recursive: true });
  writeFileSync(path.join(source, "x.txt"), "x");
  chmodSync(path.join(source, "x.txt"), 0o000);
  const target = path.join(home, "target");
  let caught = null;
  try {
    installFolder(source, target);
  } catch (error) {
    caught = error;
  } finally {
    chmodSync(path.join(source, "x.txt"), 0o600);
  }
  assert.ok(caught instanceof InstallError);
  assert.equal(caught.replaced, false, "there was no old copy");
  assert.equal(caught.restored, true, "and nothing needed putting back");
  assert.equal(existsSync(target), false);
});

test("an InstallError names the backup path when the restore fails", () => {
  const error = new InstallError(new Error("boom"), false, "/tmp/x.replaced-1", true);
  assert.equal(error.restored, false);
  assert.equal(error.backup, "/tmp/x.replaced-1");
  assert.match(error.message, /boom/);
});
