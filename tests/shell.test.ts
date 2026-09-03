import { test } from "node:test";
import assert from "node:assert/strict";
import { tokenize, matchesPattern, isAllowed, platformWarnings } from "../src/tools/shell.js";

test("tokenize handles quotes", () => {
  assert.deepEqual(tokenize(`git commit -m "hello world"`), ["git", "commit", "-m", "hello world"]);
  assert.deepEqual(tokenize(`npm   test`), ["npm", "test"]);
});

test("tokenize rejects shell metacharacters", () => {
  for (const bad of ["npm test && rm -rf /", "git status | cat", "echo $HOME", "node -e x; ls", "a > b"]) {
    assert.throws(() => tokenize(bad), /metacharacters/);
  }
});

test("pattern matching", () => {
  assert.equal(matchesPattern(["git", "status"], "git *"), true);
  assert.equal(matchesPattern(["git"], "git *"), true);
  assert.equal(matchesPattern(["npm", "test"], "npm test"), true);
  assert.equal(matchesPattern(["npm", "test", "--watch"], "npm test"), false);
  assert.equal(matchesPattern(["npm", "run", "build"], "npm run *"), true);
  assert.equal(matchesPattern(["npm", "install"], "npm run *"), false);
  assert.equal(matchesPattern(["rm", "-rf", "."], "git *"), false);
  assert.equal(matchesPattern(["dotnet", "test", "x.csproj"], "dotnet * *"), true);
});

test("isAllowed returns matching pattern", () => {
  const allow = ["git *", "npm test"];
  assert.equal(isAllowed(["git", "log"], allow), "git *");
  assert.equal(isAllowed(["npm", "install"], allow), undefined);
});

test("platform warnings", () => {
  assert.equal(platformWarnings(["git *", "npm *"], "win32").length, 0);
  assert.match(platformWarnings(["ls *"], "win32")[0], /not available on Windows/);
  assert.match(platformWarnings(["dir *"], "darwin")[0], /not available on darwin/);
  assert.match(platformWarnings(["ls *"], "linux")[0], /OS-specific/);
});
