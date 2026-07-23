import assert from "node:assert/strict";
import test from "node:test";

async function loadWorker(suffix) {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${suffix}`);
  const { default: worker } = await import(workerUrl.href);
  return worker;
}

const environment = {
  ASSETS: {
    fetch: async () => new Response("Not found", { status: 404 }),
  },
};
const context = {
  waitUntil() {},
  passThroughOnException() {},
};

test("server-renders the CloudBoard dashboard", async () => {
  const worker = await loadWorker("page");
  const response = await worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    environment,
    context,
  );

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>CloudBoard<\/title>/i);
  assert.match(html, /RI &amp; Savings Plans Coverage/i);
  assert.match(html, /Development/);
  assert.match(html, /Production/);
  assert.match(html, /AWS credentials stay server-side/);
  assert.doesNotMatch(html, /codex-preview/i);
});

test("returns an unconfigured report without exposing credentials", async () => {
  const worker = await loadWorker("api");
  const response = await worker.fetch(
    new Request("http://localhost/api/coverage?environment=dev"),
    environment,
    context,
  );

  assert.equal(response.status, 200);
  const report = await response.json();
  assert.equal(report.status, "unconfigured");
  assert.equal(report.accountId, null);
  assert.equal(JSON.stringify(report).includes("secretAccessKey"), false);
});
