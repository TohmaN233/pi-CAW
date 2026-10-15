import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile, mkdir, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const moduleURL = new URL("../core/workflow-store.mjs", import.meta.url);
const { WorkflowStore: FirstStore } = await import(`${moduleURL.href}?writer-queue-first`);
const { WorkflowStore: SecondStore } = await import(`${moduleURL.href}?writer-queue-second`);

function gate() {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  return { promise, release };
}

async function fixture(t) {
  const parent = resolve(tmpdir());
  const directory = await mkdtemp(join(parent, "pi-caw-writer-test-"));
  t.after(async () => {
    assert.equal(dirname(directory), parent);
    assert.match(basename(directory), /^pi-caw-writer-test-/);
    assert.equal((await lstat(directory)).isSymbolicLink(), false);
    assert.equal(dirname(await realpath(directory)), await realpath(parent));
    await rm(directory, { recursive: true });
  });
  const root = join(directory, "workflows");
  const first = await new FirstStore(root).initialize();
  const alias = process.platform === "win32" ? root.toUpperCase() : join(root, ".");
  const second = await new SecondStore(alias).initialize();
  assert.notEqual(FirstStore, SecondStore, "the test must use independently evaluated modules");
  return { root, directory, first, second };
}

test("WorkflowStore queues uncached modules and canonical root aliases on real disk", async t => {
  const { root, first, second } = await fixture(t);
  const counter = join(root, "counter.json");
  await writeFile(counter, "0");
  const entered = gate(), release = gate();
  const trace = [];
  const firstWrite = first.withWriter(async () => {
    trace.push("first-enter");
    const current = JSON.parse(await readFile(counter, "utf8"));
    entered.release();
    await release.promise;
    await writeFile(counter, JSON.stringify(current + 1));
    trace.push("first-exit");
    return current + 1;
  });
  await entered.promise;
  const secondWrite = second.withWriter(async () => {
    trace.push("second-enter");
    const current = JSON.parse(await readFile(counter, "utf8"));
    await writeFile(counter, JSON.stringify(current + 1));
    trace.push("second-exit");
    return current + 1;
  });
  const settled = Promise.allSettled([firstWrite, secondWrite]);
  try {
    await delay(40);
    assert.deepEqual(trace, ["first-enter"]);
    assert.equal((await first.inspectWriter()).pid, process.pid);
  } finally { release.release(); }
  assert.deepEqual(await settled, [{ status: "fulfilled", value: 1 }, { status: "fulfilled", value: 2 }]);
  assert.deepEqual(trace, ["first-enter", "first-exit", "second-enter", "second-exit"]);
  assert.equal(await readFile(counter, "utf8"), "2");
  assert.equal(await first.inspectWriter(), null);
});

test("WorkflowStore preserves a failed action while the queued writer proceeds", async t => {
  const { root, first, second } = await fixture(t);
  const entered = gate(), release = gate();
  const failure = Object.assign(new Error("injected transaction failure"), { code: "TEST_TRANSACTION" });
  const failed = first.withWriter(async () => { entered.release(); await release.promise; throw failure; });
  await entered.promise;
  let successorEntered = false;
  const succeeded = second.withWriter(async () => {
    successorEntered = true;
    await writeFile(join(root, "after-failure.json"), "committed");
    return "committed";
  });
  const settled = Promise.allSettled([failed, succeeded]);
  try {
    await delay(40);
    assert.equal(successorEntered, false, "the succeeding writer must wait for the failed action and lock cleanup");
  } finally { release.release(); }
  const results = await settled;
  assert.equal(results[0].status, "rejected");
  assert.equal(results[0].reason, failure);
  assert.deepEqual(results[1], { status: "fulfilled", value: "committed" });
  assert.equal(await readFile(join(root, "after-failure.json"), "utf8"), "committed");
  assert.equal(await first.inspectWriter(), null);
});

test("WorkflowStore rejects retained external locks without running actions or deleting evidence", async t => {
  const { root, first, second } = await fixture(t);
  const lock = join(root, ".writer.lock");
  const evidence = JSON.stringify({ pid: process.pid, token: "foreign-owner", created_at: "retained" });
  await writeFile(lock, evidence, { flag: "wx" });
  let invoked = false;
  const results = await Promise.allSettled([first, second].map(store => store.withWriter(() => { invoked = true; })));
  for (const result of results) {
    assert.equal(result.status, "rejected");
    assert.equal(result.reason.code, "WORKFLOW_STORE_BUSY");
  }
  assert.equal(invoked, false);
  assert.equal(await readFile(lock, "utf8"), evidence);
});

test("WorkflowStore rejects recovery locks without deleting or bypassing them", async t => {
  const { root, first } = await fixture(t);
  const recovery = join(root, ".recovery.lock");
  await mkdir(recovery);
  let invoked = false;
  await assert.rejects(first.withWriter(() => { invoked = true; }), { code: "WORKFLOW_STORE_BUSY" });
  assert.equal(invoked, false);
  assert.equal((await lstat(recovery)).isDirectory(), true);
  assert.equal(await first.inspectWriter(), null);
});

test("WorkflowStore rejects same-root recursive writes promptly and allows distinct-root nesting", { timeout: 3000 }, async t => {
  const { directory, first, second } = await fixture(t);
  let nestedInvoked = false;
  await assert.rejects(first.withWriter(() => second.withWriter(() => { nestedInvoked = true; })), { code: "WORKFLOW_STORE_BUSY" });
  assert.equal(nestedInvoked, false);
  assert.equal(await first.inspectWriter(), null);
  const other = await new SecondStore(join(directory, "runs")).initialize();
  assert.equal(await first.withWriter(() => other.withWriter(() => "nested result")), "nested result");
  assert.equal(await other.inspectWriter(), null);
  assert.equal(await second.withWriter(() => "next result"), "next result");
});

test("WorkflowStore propagates even falsy thrown values and releases its writer", async t => {
  const { first, second } = await fixture(t);
  for (const reason of [null, undefined, false, 0, ""]) {
    const [result] = await Promise.allSettled([first.withWriter(() => { throw reason; })]);
    assert.deepEqual(result, { status: "rejected", reason });
    assert.equal(await first.inspectWriter(), null);
  }
  assert.equal(await second.withWriter(() => "after null"), "after null");
});

test("WorkflowStore rejects contested cross-root nesting instead of deadlocking opposite writers", { timeout: 3000 }, async t => {
  const { directory, first } = await fixture(t);
  const other = await new SecondStore(join(directory, "other")).initialize();
  const bothEntered = gate();
  let entered = 0;
  const nest = (outer, inner) => outer.withWriter(async () => {
    if (++entered === 2) bothEntered.release();
    await bothEntered.promise;
    return inner.withWriter(() => "nested");
  });
  const results = await Promise.allSettled([nest(first, other), nest(other, first)]);
  assert(results.some(result => result.status === "rejected"));
  for (const result of results) if (result.status === "rejected") assert.equal(result.reason.code, "WORKFLOW_STORE_BUSY");
  assert.equal(await first.inspectWriter(), null);
  assert.equal(await other.inspectWriter(), null);
  assert.equal(await first.withWriter(() => other.withWriter(() => "idle nesting")), "idle nesting");
});

test("WorkflowStore retains falsy action failure and changed lock evidence on cleanup failure", async t => {
  const { root, first } = await fixture(t);
  const changed = JSON.stringify({ pid: process.pid, token: "changed-owner" });
  const [result] = await Promise.allSettled([first.withWriter(async () => {
    await writeFile(join(root, ".writer.lock"), changed);
    throw null;
  })]);
  assert.equal(result.status, "rejected");
  assert(result.reason instanceof AggregateError);
  assert.equal(result.reason.errors[0], null);
  assert.equal(result.reason.errors[1].code, "LOCK_OWNERSHIP");
  assert.equal(await readFile(join(root, ".writer.lock"), "utf8"), changed);
});
