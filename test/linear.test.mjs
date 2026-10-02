import { test } from "node:test";
import assert from "node:assert/strict";
import { notify } from "../src/linear.mjs";

function withEnv(key, value, fn) {
  const prev = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  return fn().finally(() => {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  });
}

function withFetch(impl, fn) {
  const prev = global.fetch;
  global.fetch = impl;
  return fn().finally(() => {
    global.fetch = prev;
  });
}

// Flush the microtask queue so notify()'s fire-and-forget graphql() call has a chance to run.
function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

test("notify() is a no-op when LINEAR_API_KEY is unset", async () => {
  await withEnv("LINEAR_API_KEY", undefined, async () => {
    let called = false;
    await withFetch(
      async () => {
        called = true;
        return { ok: true, json: async () => ({ data: {} }) };
      },
      async () => {
        notify("ENG-123", "claim", ["/repo/a.js"], "session-a");
        await flush();
      }
    );
    assert.equal(called, false);
  });
});

test("notify() posts commentCreate with the raw issue identifier, not a resolved UUID", async () => {
  await withEnv("LINEAR_API_KEY", "lin_api_test_key", async () => {
    let capturedUrl, capturedInit;
    await withFetch(
      async (url, init) => {
        capturedUrl = url;
        capturedInit = init;
        return { ok: true, json: async () => ({ data: { commentCreate: { success: true } } }) };
      },
      async () => {
        notify("ENG-123", "claim", ["/repo/a.js", "/repo/src/b.js"], "session-a", "/repo");
        await flush();
      }
    );

    assert.equal(capturedUrl, "https://api.linear.app/graphql");
    assert.equal(capturedInit.method, "POST");
    assert.equal(capturedInit.headers.Authorization, "lin_api_test_key");
    assert.equal(capturedInit.headers["Content-Type"], "application/json");

    const payload = JSON.parse(capturedInit.body);
    assert.match(payload.query, /commentCreate/);
    assert.match(payload.query, /issueId: \$issueId/);
    // Confirms the human-readable identifier is passed through untouched — Linear's
    // CommentCreateInput.issueId accepts either a UUID or an issue identifier like "ENG-123".
    assert.equal(payload.variables.issueId, "ENG-123");
    assert.match(payload.variables.body, /claimed 2 file\(s\)/);
    // Paths are shown relative to the session's working directory, not as absolute paths.
    assert.match(payload.variables.body, /`a\.js`/);
    assert.match(payload.variables.body, /`src\/b\.js`/);
  });
});

test("notify() uses 'released' verb for the release action", async () => {
  await withEnv("LINEAR_API_KEY", "lin_api_test_key", async () => {
    let capturedBody;
    await withFetch(
      async (url, init) => {
        capturedBody = JSON.parse(init.body).variables.body;
        return { ok: true, json: async () => ({ data: { commentCreate: { success: true } } }) };
      },
      async () => {
        notify("ENG-123", "release", ["/repo/a.js"], "session-a");
        await flush();
      }
    );
    assert.match(capturedBody, /released 1 file\(s\)/);
  });
});

test("notify() swallows a non-ok HTTP response without throwing", async () => {
  await withEnv("LINEAR_API_KEY", "lin_api_test_key", async () => {
    await withFetch(
      async () => ({ ok: false, status: 500, json: async () => ({}) }),
      async () => {
        assert.doesNotThrow(() => notify("ENG-123", "claim", ["/repo/a.js"], "session-a"));
        await flush();
      }
    );
  });
});

test("notify() swallows a GraphQL errors payload without throwing", async () => {
  await withEnv("LINEAR_API_KEY", "lin_api_test_key", async () => {
    await withFetch(
      async () => ({ ok: true, json: async () => ({ errors: [{ message: "boom" }] }) }),
      async () => {
        assert.doesNotThrow(() => notify("ENG-123", "claim", ["/repo/a.js"], "session-a"));
        await flush();
      }
    );
  });
});

function capture(fn) {
  const calls = [];
  return withEnv("LINEAR_API_KEY", "lin_api_test_key", () =>
    withFetch(
      async (url, init) => {
        calls.push({ url, init });
        return { ok: true, json: async () => ({ data: { commentCreate: { success: true } } }) };
      },
      async () => {
        fn();
        await flush();
      }
    )
  ).then(() => calls);
}

test("notify() sends only the comment: no absolute paths, no full session id, no extra fields", async () => {
  const session = "0f3c9a7e-1111-2222-3333-444455556666";
  const calls = await capture(() =>
    notify("ENG-9", "claim", ["/repo/src/a.js", "/Users/alice/secrets/notes.md"], session, "/repo")
  );
  assert.equal(calls.length, 1);
  const { init } = calls[0];
  assert.deepEqual(Object.keys(init.headers).sort(), ["Authorization", "Content-Type"]);
  const payload = JSON.parse(init.body);
  assert.deepEqual(Object.keys(payload).sort(), ["query", "variables"]);
  assert.deepEqual(Object.keys(payload.variables).sort(), ["body", "issueId"]);
  const body = payload.variables.body;
  assert.doesNotMatch(body, /\/Users\/alice/);
  assert.doesNotMatch(body, /\/repo\//);
  assert.match(body, /`src\/a\.js`/);
  assert.match(body, /`…\/notes\.md`/);
  assert.doesNotMatch(body, new RegExp(session));
  assert.match(body, /`0f3c9a7e`/);
});

test("notify() cannot be made to break out of its code spans", async () => {
  const calls = await capture(() => notify("ENG-9", "claim", ["/repo/a`b\n# heading.js"], "session-a", "/repo"));
  const body = JSON.parse(calls[0].init.body).variables.body;
  assert.equal(body.split("\n").length, 2);
  assert.doesNotMatch(body, /a`b/);
});

test("notify() has a request timeout", async () => {
  const calls = await capture(() => notify("ENG-9", "claim", ["/repo/a.js"], "session-a", "/repo"));
  assert.ok(calls[0].init.signal instanceof AbortSignal);
});

test("notify() does not contact Linear for ids that are not Linear issues", async () => {
  const calls = await capture(() => {
    notify("adhoc:0f3c9a7e", "claim", ["/repo/a.js"], "session-a", "/repo");
    notify("whatever", "claim", ["/repo/a.js"], "session-a", "/repo");
  });
  assert.equal(calls.length, 0);
  const uuid = await capture(() => notify("2a1b3c4d-1111-2222-3333-444455556666", "claim", ["/repo/a.js"], "session-a", "/repo"));
  assert.equal(uuid.length, 1);
});
