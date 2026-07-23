import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const testDirectory = mkdtempSync(join(tmpdir(), "cloudboard-store-"));
const bootstrapPath = join(testDirectory, "environments.json");
process.env.CLOUDBOARD_DATABASE_PATH = join(testDirectory, "cloudboard.db");
process.env.CLOUDBOARD_ENVIRONMENTS_BOOTSTRAP_FILE = bootstrapPath;

writeFileSync(
  bootstrapPath,
  JSON.stringify({
    environments: [
      {
        id: "dev",
        name: "Development",
        group: "Default",
        regions: ["ap-northeast-2"],
        credentialRef: "dev",
      },
    ],
  }),
);

const store = await import("../lib/environment-store");

test.after(() => {
  store.closeEnvironmentStore();
});

test("bootstraps the environment registry once", () => {
  assert.deepEqual(store.listEnvironments(), [
    {
      id: "dev",
      name: "Development",
      group: "Default",
      regions: ["ap-northeast-2"],
      credentialRef: "dev",
    },
  ]);
});

test("creates and deletes an environment", () => {
  const created = store.createEnvironment({
    id: "b2b-dev",
    name: "B2B Development",
    group: "B2B",
    regions: ["ap-northeast-2", "us-east-1"],
    credentialRef: "b2b-dev",
  });

  assert.equal(created.id, "b2b-dev");
  assert.equal(store.findEnvironment("b2b-dev")?.group, "B2B");

  store.deleteEnvironment("b2b-dev");
  assert.equal(store.findEnvironment("b2b-dev"), null);
});

test("rejects duplicate and invalid environments", () => {
  assert.throws(
    () =>
      store.createEnvironment({
        id: "dev",
        name: "Duplicate",
        group: "Default",
        regions: ["ap-northeast-2"],
        credentialRef: "duplicate",
      }),
    store.EnvironmentAlreadyExistsError,
  );

  assert.throws(
    () =>
      store.createEnvironment({
        id: "../prd",
        name: "Invalid",
        group: "Default",
        regions: ["ap-northeast-2"],
        credentialRef: "../prd",
      }),
    store.InvalidEnvironmentError,
  );
});
