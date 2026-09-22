// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Transport and token-lifecycle tests.
 *
 * The token half of this file is the part that earns its keep. WHOOP documents
 * its refresh tokens as rotating and a connector cannot persist a rotated one,
 * so the difference between "refreshed only when it had to" and "refreshed
 * every run" is the difference between a connection that keeps working and one
 * that dies after its first run. Several of these tests assert that NO request was
 * made, which is an easy assertion to leave out and the only one that catches a
 * regression into eager refreshing.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
	acquireAccessToken,
	fetchWhoopPage,
	resolveWhoopCredentials,
	WHOOP_MAX_PAGE_LIMIT,
	WhoopAuthorizationExpiredError,
	type WhoopHttpGovernor,
	walkWhoopCollection,
} from "./api.ts";

/** Unpaced governor: a test must not wait out the real one-second ceiling. */
const governor: WhoopHttpGovernor = {
	request: (async (
		send: () => unknown,
		classify: (raw: unknown) => { status: number; value: unknown },
	) => {
		const raw = await send();
		const classified = classify(raw);
		return { status: classified.status, value: classified.value };
	}) as WhoopHttpGovernor["request"],
};

const BASE_ENV = {
	WHOOP_OAUTH_CLIENT_ID: "client-abc",
	WHOOP_OAUTH_CLIENT_SECRET: "secret-xyz",
	WHOOP_REFRESH_TOKEN: "refresh-1",
};

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

// ─── Credential resolution ──────────────────────────────────────────────────

test("credentials resolve from the environment the host composes", () => {
	const credentials = resolveWhoopCredentials({
		...BASE_ENV,
		WHOOP_ACCESS_TOKEN: "access-1",
		WHOOP_ACCESS_TOKEN_EXPIRES_AT: "1789000000000",
	});
	assert.equal(credentials.clientId, "client-abc");
	assert.equal(credentials.accessToken, "access-1");
	assert.equal(credentials.accessTokenExpiresAt, 1_789_000_000_000);
});

test("each missing credential names itself", () => {
	// A connection that fails must say which of three values the operator has
	// not supplied; "auth failed" would send them looking in the wrong place.
	assert.throws(
		() => resolveWhoopCredentials({}),
		/whoop_oauth_client_id_missing/,
	);
	assert.throws(
		() => resolveWhoopCredentials({ WHOOP_OAUTH_CLIENT_ID: "a" }),
		/whoop_oauth_client_secret_missing/,
	);
	assert.throws(
		() =>
			resolveWhoopCredentials({
				WHOOP_OAUTH_CLIENT_ID: "a",
				WHOOP_OAUTH_CLIENT_SECRET: "b",
			}),
		/whoop_refresh_token_missing/,
	);
});

test("the optional access-token fields are genuinely optional", () => {
	// A credential bundle sealed before those fields were declared must still
	// yield a working connection; it simply always refreshes.
	const credentials = resolveWhoopCredentials(BASE_ENV);
	assert.equal(credentials.accessToken, null);
	assert.equal(credentials.accessTokenExpiresAt, null);
});

test("an ISO expiry is accepted as well as epoch milliseconds", () => {
	const credentials = resolveWhoopCredentials({
		...BASE_ENV,
		WHOOP_ACCESS_TOKEN: "access-1",
		WHOOP_ACCESS_TOKEN_EXPIRES_AT: "2026-09-19T07:00:00.000Z",
	});
	assert.equal(
		credentials.accessTokenExpiresAt,
		Date.parse("2026-09-19T07:00:00.000Z"),
	);
});

// ─── Token acquisition ──────────────────────────────────────────────────────

test("a still-valid access token is reused and NO refresh is sent", async () => {
	// The behaviour that keeps a WHOOP connection alive. An unnecessary refresh
	// would consume the stored rotating refresh token for nothing and break the
	// following run.
	let calls = 0;
	const credentials = resolveWhoopCredentials({
		...BASE_ENV,
		WHOOP_ACCESS_TOKEN: "access-live",
		WHOOP_ACCESS_TOKEN_EXPIRES_AT: "2000000",
	});
	const token = await acquireAccessToken(credentials, {
		now: () => 1_000_000,
		fetchImpl: (async () => {
			calls += 1;
			return jsonResponse({});
		}) as typeof fetch,
	});
	assert.equal(calls, 0, "a live access token must cost no network call");
	assert.equal(token.accessToken, "access-live");
	assert.equal(token.refreshed, false);
	assert.equal(token.rotatedRefreshToken, null);
});

test("a token inside the safety margin is treated as expired", async () => {
	// Expiring mid-run would fail a backfill partway and lose the pages already
	// paid for, so the margin refreshes early rather than exactly on time.
	let calls = 0;
	const credentials = resolveWhoopCredentials({
		...BASE_ENV,
		WHOOP_ACCESS_TOKEN: "access-nearly-dead",
		// 60s ahead: inside the 120s margin.
		WHOOP_ACCESS_TOKEN_EXPIRES_AT: "1060000",
	});
	const token = await acquireAccessToken(credentials, {
		now: () => 1_000_000,
		fetchImpl: (async () => {
			calls += 1;
			return jsonResponse({ access_token: "access-2", expires_in: 3600 });
		}) as typeof fetch,
	});
	assert.equal(calls, 1);
	assert.equal(token.accessToken, "access-2");
	assert.equal(token.refreshed, true);
});

test("an access token with no recorded expiry is refreshed", async () => {
	// It cannot be shown to be valid, and using a dead token fails the whole run
	// whereas an unnecessary refresh costs one rotation. Refresh is the safe
	// direction.
	let calls = 0;
	const credentials = resolveWhoopCredentials({
		...BASE_ENV,
		WHOOP_ACCESS_TOKEN: "access-unknown-age",
	});
	const token = await acquireAccessToken(credentials, {
		fetchImpl: (async () => {
			calls += 1;
			return jsonResponse({ access_token: "access-2", expires_in: 3600 });
		}) as typeof fetch,
	});
	assert.equal(calls, 1);
	assert.equal(token.accessToken, "access-2");
});

test("the refresh request asks for the offline scope", async () => {
	// Without `offline` WHOOP returns no replacement refresh token, and the
	// connection becomes single-use. This is a one-word omission that would not
	// fail until the run after next.
	let body = "";
	const credentials = resolveWhoopCredentials(BASE_ENV);
	await acquireAccessToken(credentials, {
		fetchImpl: (async (_url: string, init: RequestInit) => {
			body = String(init.body);
			return jsonResponse({ access_token: "access-2", expires_in: 3600 });
		}) as unknown as typeof fetch,
	});
	const params = new URLSearchParams(body);
	assert.equal(params.get("scope"), "offline");
	assert.equal(params.get("grant_type"), "refresh_token");
	assert.equal(params.get("refresh_token"), "refresh-1");
	assert.equal(params.get("client_secret"), "secret-xyz");
});

test("a rotated refresh token is captured rather than discarded", async () => {
	// A connector cannot persist it, but reading it is what lets the run tell
	// the owner that the stored credential has been superseded.
	const credentials = resolveWhoopCredentials(BASE_ENV);
	const token = await acquireAccessToken(credentials, {
		fetchImpl: (async () =>
			jsonResponse({
				access_token: "access-2",
				refresh_token: "refresh-2",
				expires_in: 3600,
			})) as typeof fetch,
	});
	assert.equal(token.rotatedRefreshToken, "refresh-2");
});

test("an unchanged refresh token is not reported as a rotation", async () => {
	// If WHOOP echoes the same token back, nothing rotated and the owner must
	// not be warned about a reconnect that is not coming.
	const credentials = resolveWhoopCredentials(BASE_ENV);
	const token = await acquireAccessToken(credentials, {
		fetchImpl: (async () =>
			jsonResponse({
				access_token: "access-2",
				refresh_token: "refresh-1",
				expires_in: 3600,
			})) as typeof fetch,
	});
	assert.equal(token.rotatedRefreshToken, null);
});

test("an invalid grant is a reconnect, not a retry", async () => {
	const credentials = resolveWhoopCredentials(BASE_ENV);
	const rejectsWith = (status: number) =>
		assert.rejects(
			acquireAccessToken(credentials, {
				fetchImpl: (async () =>
					jsonResponse({ error: "invalid_grant" }, status)) as typeof fetch,
			}),
			WhoopAuthorizationExpiredError,
		);
	// 400 invalid_grant and 401 are both "this authorization is finished".
	await Promise.all([rejectsWith(400), rejectsWith(401)]);
});

test("a server fault stays retryable rather than demanding a reconnect", async () => {
	// Telling an owner to reconnect because WHOOP had a bad minute would make
	// them re-consent for nothing.
	const credentials = resolveWhoopCredentials(BASE_ENV);
	await assert.rejects(
		acquireAccessToken(credentials, {
			fetchImpl: (async () =>
				new Response("upstream boom", { status: 503 })) as typeof fetch,
		}),
		/whoop_token_http_503/,
	);
});

test("a token response with no access token fails loudly", async () => {
	const credentials = resolveWhoopCredentials(BASE_ENV);
	await assert.rejects(
		acquireAccessToken(credentials, {
			fetchImpl: (async () =>
				jsonResponse({ expires_in: 3600 })) as typeof fetch,
		}),
		/whoop_token_access_token_missing/,
	);
});

// ─── Collection transport ───────────────────────────────────────────────────

test("a page request sends the documented parameter spellings", async () => {
	// WHOOP RETURNS `next_token` and ACCEPTS `nextToken`. The asymmetry is
	// WHOOP's, and getting it wrong silently restarts pagination from page one
	// on every request — an infinite first page rather than an error.
	let seen = "";
	await fetchWhoopPage(
		governor,
		"/v2/activity/sleep",
		"access-1",
		{ start: "2026-09-01T00:00:00.000Z", limit: 25, nextToken: "tok-2" },
		(async (url: string) => {
			seen = url;
			return jsonResponse({ records: [], next_token: null });
		}) as unknown as typeof fetch,
	);
	const parsed = new URL(seen);
	assert.equal(
		parsed.origin + parsed.pathname,
		"https://api.prod.whoop.com/developer/v2/activity/sleep",
	);
	assert.equal(parsed.searchParams.get("nextToken"), "tok-2");
	assert.equal(parsed.searchParams.get("limit"), "25");
	assert.equal(parsed.searchParams.get("start"), "2026-09-01T00:00:00.000Z");
});

test("the walk follows next_token to the end and asks for full pages", async () => {
	const limits: string[] = [];
	const pages = [
		{ records: [{ id: "a" }, { id: "b" }], next_token: "t1" },
		{ records: [{ id: "c" }], next_token: "" },
	];
	let index = 0;
	const result = await walkWhoopCollection<{ id: string }>(
		governor,
		"/v2/activity/sleep",
		"access-1",
		{},
		10,
		(async (url: string) => {
			limits.push(new URL(url).searchParams.get("limit") ?? "");
			const page = pages[index];
			index += 1;
			return jsonResponse(page);
		}) as unknown as typeof fetch,
	);
	assert.deepEqual(
		result.rows.map((row) => row.id),
		["a", "b", "c"],
	);
	assert.equal(result.truncated, false);
	assert.deepEqual(limits, [
		String(WHOOP_MAX_PAGE_LIMIT),
		String(WHOOP_MAX_PAGE_LIMIT),
	]);
});

test("a full page with an empty next_token ends the walk", async () => {
	// The end of a collection is an empty next_token, never a short page. A walk
	// that stopped on a short page would silently truncate whenever the last
	// page happened to be full.
	const result = await walkWhoopCollection<{ id: number }>(
		governor,
		"/v2/cycle",
		"access-1",
		{},
		10,
		(async () =>
			jsonResponse({
				records: Array.from({ length: WHOOP_MAX_PAGE_LIMIT }, (_v, i) => ({
					id: i,
				})),
				next_token: "",
			})) as unknown as typeof fetch,
	);
	assert.equal(result.rows.length, WHOOP_MAX_PAGE_LIMIT);
	assert.equal(result.truncated, false);
});

test("hitting the page ceiling reports truncation rather than completion", async () => {
	// A capped walk and a finished one otherwise return the same rows. Without
	// this flag the caller would advance its cursor past pages it never read.
	const result = await walkWhoopCollection<{ id: string }>(
		governor,
		"/v2/recovery",
		"access-1",
		{},
		2,
		(async () =>
			jsonResponse({
				records: [{ id: "x" }],
				next_token: "always-more",
			})) as unknown as typeof fetch,
	);
	assert.equal(result.truncated, true);
	assert.equal(result.rows.length, 2);
	// The token is the whole difference between a deferral and a stall. Without
	// it the next run re-requests the identical window from page one, hits the
	// identical ceiling, and the tail never arrives however often it runs.
	assert.equal(result.resumeToken, "always-more");
});

test("a finished walk reports no tail to resume", async () => {
	const result = await walkWhoopCollection<{ id: string }>(
		governor,
		"/v2/recovery",
		"access-1",
		{},
		10,
		(async () =>
			jsonResponse({
				records: [{ id: "x" }],
				next_token: "",
			})) as unknown as typeof fetch,
	);
	assert.equal(result.truncated, false);
	assert.equal(
		result.resumeToken,
		null,
		"a completed walk must not leave a token behind for the next run to replay",
	);
});

test("a resume token is sent on the FIRST request of the next walk", async () => {
	// Proves the tail is actually picked up rather than merely stored.
	const seen: (string | null)[] = [];
	await walkWhoopCollection<{ id: string }>(
		governor,
		"/v2/activity/sleep",
		"access-1",
		{ start: "2026-09-01T00:00:00.000Z", resumeToken: "page-201" },
		10,
		(async (url: string) => {
			seen.push(new URL(url).searchParams.get("nextToken"));
			return jsonResponse({ records: [], next_token: "" });
		}) as unknown as typeof fetch,
	);
	assert.deepEqual(seen, ["page-201"]);
});

test("a 401 during collection is an expired authorization", async () => {
	await assert.rejects(
		fetchWhoopPage(governor, "/v2/recovery", "stale", {}, (async () =>
			jsonResponse({ error: "unauthorized" }, 401)) as typeof fetch),
		WhoopAuthorizationExpiredError,
	);
});

test("an unparseable body is named as such", async () => {
	await assert.rejects(
		fetchWhoopPage(
			governor,
			"/v2/recovery",
			"access-1",
			{},
			(async () => new Response("<html>maintenance</html>")) as typeof fetch,
		),
		/whoop_invalid_json/,
	);
});

test("a server error keeps its status in the message", async () => {
	await assert.rejects(
		fetchWhoopPage(
			governor,
			"/v2/cycle",
			"access-1",
			{},
			(async () => new Response("boom", { status: 502 })) as typeof fetch,
		),
		/whoop_http_502/,
	);
});
