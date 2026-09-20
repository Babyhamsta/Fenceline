import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = mkdtempSync(join(tmpdir(), "fenceline-compiler-updates-"));
function write(path, value) {
  const target = join(fixture, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, value);
}
function read(path) {
  return JSON.parse(readFileSync(join(fixture, path), "utf8"));
}
const cfg = {
  dnrTier: { maxRules: 1, domainsPerRule: 1, rulesPerChunk: 1, maxDomains: 1 },
  categories: [{ name: "adult", sources: [{ file: "fixture.txt", format: "domains" }] }]
};
function compile() {
  write("compiler/sources.json", JSON.stringify(cfg));
  execFileSync(process.execPath, [join(fixture, "compiler/compile.mjs")], { stdio: "pipe" });
  return read("dist/meta.json");
}

try {
  for (const file of ["compiler/compile.mjs", "extension/lib/hash.js"]) {
    mkdirSync(dirname(join(fixture, file)), { recursive: true });
    cpSync(join(root, file), join(fixture, file));
  }
  write("package.json", '{"type":"module"}');
  write("fixture.txt", "alpha.example\nbeta.example\n");
  write("data/tranco.csv", "1,alpha.example\n2,beta.example\n");
  const modelMeta = { version: "model-one", dims: 1, classes: ["clean"], intercept: [0] };
  write("extension/model/model.bin", Buffer.alloc(4));
  write("extension/model/model-meta.json", JSON.stringify(modelMeta));
  write("extension/model/fusion.json", '{"classes":["clean"],"trees":[]}');
  const first = compile();
  assert.equal(first.model.version, "model-one", "clean checkout publishes bundled model");
  assert.equal(read("dist/model-meta.json").version, "model-one");
  assert.deepEqual(read("dist/fusion.json").classes, ["clean"]);
  assert.equal(readFileSync(join(fixture, "dist/model.bin")).length, 4);
  // Replace the generated clock value to prove timestamps cannot affect identity.
  const compilerPath = join(fixture, "compiler/compile.mjs");
  writeFileSync(
    compilerPath,
    readFileSync(compilerPath, "utf8").replace(
      "new Date().toISOString()",
      '"2099-01-01T00:00:00.000Z"'
    )
  );
  const unchanged = compile();
  assert.notEqual(first.generated, unchanged.generated);
  assert.equal(first.version, unchanged.version);
  assert.equal(first.publicationVersion, unchanged.publicationVersion);

  write("data/tranco.csv", "1,beta.example\n2,alpha.example\n");
  const ranked = compile();
  assert.notDeepEqual(first.chunks, ranked.chunks);
  assert.notEqual(first.version, ranked.version, "DNR selection changes list identity");

  cfg.categories[0].name = "gambling";
  const renamed = compile();
  assert.notEqual(ranked.version, renamed.version, "category names change list identity");
  write("compiler/no-pin-hosts.txt", "shared.example\n");
  const noPin = compile();
  assert.equal(renamed.version, noPin.version, "no-pin updates avoid full list downloads");
  assert.notEqual(renamed.publicationVersion, noPin.publicationVersion);

  write("extension/model/model-meta.json", JSON.stringify({ ...modelMeta, intercept: [1] }));
  const metadata = compile();
  assert.equal(noPin.version, metadata.version);
  assert.notEqual(noPin.publicationVersion, metadata.publicationVersion);
  assert.notEqual(noPin.model.metaSha256, metadata.model.metaSha256);
  write("extension/model/model.bin", Buffer.from([1, 0, 0, 0]));
  const weights = compile();
  assert.equal(metadata.version, weights.version);
  assert.notEqual(metadata.publicationVersion, weights.publicationVersion);
  write("extension/model/fusion.json", '{"classes":["clean"],"trees":[[]]}');
  const fusion = compile();
  assert.notEqual(weights.publicationVersion, fusion.publicationVersion);

  write("classifier/dist/model.bin", Buffer.alloc(4));
  write("classifier/dist/model-meta.json", JSON.stringify({ ...modelMeta, version: "exported" }));
  const exported = compile();
  assert.equal(exported.model.version, "exported", "local export takes precedence over bundle");
  assert.equal(exported.model.fusionFile, undefined, "never mix fusion from a different source");
  console.log("Compiler update identity and bundled-model publication checks passed.");
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
