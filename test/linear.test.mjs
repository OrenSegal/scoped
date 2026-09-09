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
        notify("ENG-123", "claim", ["/repo/a.js", "/repo/b.js"], "session-a");
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
    assert.match(payload.variables.body, /`\/repo\/a\.js`/);
    assert.match(payload.variables.body, /`\/repo\/b\.js`/);
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
