// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * End-to-end collection tests: a fake WHOOP serving canned pages, driving the
 * real `collectWhoop`.
 *
 * The cases chosen are the ones where a plausible implementation is wrong in a
 * way that only shows up on the SECOND run or against a REAL account: the
 * cursor after a capped walk, the rewind that lets a rescored night be
 * collected again, and the coverage reason that distinguishes "still being
 * scored" from "never will be".
 */

import assert from "node:assert/strict";
import test from "node:test";
import type {
	CollectContext,
	EmittedMessage,
	RecordData,
	StreamScope,
} from "../../src/connector-runtime.ts";
import type { WhoopHttpGovernor } from "./api.ts";
import { collectWhoop } from "./index.ts";

const NOW = new Date("2026-09-19T06:00:00.000Z");

/** Unpaced: a test must not wait out the real one-second ceiling. */
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

const ENV = {
	WHOOP_OAUTH_CLIENT_ID: "client-abc",
	WHOOP_OAUTH_CLIENT_SECRET: "secret-xyz",
	WHOOP_REFRESH_TOKEN: "refresh-1",
	WHOOP_ACCESS_TOKEN: "access-live",
	// Far future, so the common path reuses the token and sends no refresh.
	WHOOP_ACCESS_TOKEN_EXPIRES_AT: "4102444800000",
};

function sleep(
	id: string,
	start: string,
	options: {
		scored?: boolean;
		respiratoryRate?: number | null;
		state?: string;
	} = {},
) {
	const scored = options.scored ?? true;
	const base = {
		id,
		cycle_id: Number.parseInt(id.slice(0, 4), 16),
		user_id: 10_129,
		created_at: start,
		updated_at: start,
		start,
		end: start,
		timezone_offset: "+10:00",
		nap: false,
		score_state: options.state ?? (scored ? "SCORED" : "PENDING_SCORE"),
	};
	if (!scored) {
		return base;
	}
	return {
		...base,
		score: {
			stage_summary: {
				total_in_bed_time_milli: 27_660_000,
				total_awake_time_milli: 1_320_000,
				total_no_data_time_milli: 0,
				total_light_sleep_time_milli: 13_500_000,
				total_slow_wave_sleep_time_milli: 6_600_000,
				total_rem_sleep_time_milli: 6_240_000,
				sleep_cycle_count: 5,
				disturbance_count: 7,
			},
			sleep_needed: {
				baseline_milli: 27_000_000,
				need_from_sleep_debt_milli: 0,
				need_from_recent_strain_milli: 0,
				need_from_recent_nap_milli: 0,
			},
			respiratory_rate:
				options.respiratoryRate === undefined ? 14.7 : options.respiratoryRate,
			sleep_performance_percentage: 92.5,
			sleep_consistency_percentage: 71,
			sleep_efficiency_percentage: 95.2,
		},
	};
}

interface FakeWhoopOptions {
	/** Pages per path, in order. Last page should carry an empty next_token. */
	pages: Record<string, Array<{ records: unknown[]; next_token?: string }>>;
	/** Paths that should fail, and with what status. */
	fail?: Record<string, number>;
}

function fakeWhoop(options: FakeWhoopOptions): {
	fetchImpl: typeof fetch;
	requests: string[];
} {
	const requests: string[] = [];
	const cursors: Record<string, number> = {};
	const fetchImpl = (async (url: string) => {
		requests.push(url);
		const path = new URL(url).pathname.replace("/developer", "");
		const failure = options.fail?.[path];
		if (failure) {
			return new Response(JSON.stringify({ error: "nope" }), {
				status: failure,
			});
		}
		const queue = options.pages[path] ?? [{ records: [] }];
		const index = cursors[path] ?? 0;
		cursors[path] = index + 1;
		const page = queue[Math.min(index, queue.length - 1)];
		return new Response(JSON.stringify(page), { status: 200 });
	}) as unknown as typeof fetch;
	return { fetchImpl, requests };
}

function makeContext({
	state = {},
	streams = [
		{ name: "sleep" },
		{ name: "respiratory_rate" },
		{ name: "recovery" },
		{ name: "cycles" },
		{ name: "coverage_diagnostics" },
	],
}: {
	readonly state?: Record<string, unknown>;
	readonly streams?: readonly StreamScope[];
} = {}): {
	readonly ctx: CollectContext;
	readonly messages: EmittedMessage[];
	readonly records: Array<{ data: RecordData; stream: string }>;
	readonly failures: Array<{ stream: string; message: string }>;
} {
	const messages: EmittedMessage[] = [];
	const records: Array<{ data: RecordData; stream: string }> = [];
	const failures: Array<{ stream: string; message: string }> = [];
	return {
		messages,
		records,
		failures,
		ctx: {
			assist: () => Promise.resolve("asst_test"),
			capture: null,
			completeAssistance: () => Promise.resolve(),
			credentials: { ...ENV },
			detailGaps: [],
			emit: (msg: EmittedMessage) => {
				messages.push(msg);
				return Promise.resolve();
			},
			emitRecord: (stream: string, data: RecordData) => {
				records.push({ data, stream });
				return Promise.resolve();
			},
			emittedAt: NOW.toISOString(),
			progress: () => Promise.resolve(),
			reportStreamFailure: (stream: string, message: string) => {
				failures.push({ stream, message });
				return Promise.resolve();
			},
			requested: new Map(streams.map((stream) => [stream.name, stream])),
			requestDetailGapPage: () => Promise.resolve([]),
			scope: { streams },
			sendInteraction: () =>
				Promise.resolve({
					request_id: "int_test",
					status: "cancelled" as const,
					type: "INTERACTION_RESPONSE" as const,
				}),
			state,
		} as unknown as CollectContext,
	};
}

function recordsFor(
	records: ReadonlyArray<{ data: RecordData; stream: string }>,
	stream: string,
): RecordData[] {
	return records.filter((row) => row.stream === stream).map((row) => row.data);
}

function coverageFor(
	records: ReadonlyArray<{ data: RecordData; stream: string }>,
	stream: string,
): RecordData | undefined {
	return recordsFor(records, "coverage_diagnostics").find(
		(row) => row.stream === stream,
	);
}

function cursorFor(
	messages: readonly EmittedMessage[],
	stream: string,
): unknown {
	const found = [...messages]
		.reverse()
		.find((msg) => msg.type === "STATE" && msg.stream === stream);
	return found && found.type === "STATE" ? found.cursor : undefined;
}

const ONLY_SLEEP = {
	"/v2/activity/sleep": [
		{
			records: [
				sleep(
					"aaaa1111-1111-4111-8111-111111111111",
					"2026-09-17T22:00:00.000Z",
				),
				sleep(
					"bbbb2222-2222-4222-8222-222222222222",
					"2026-09-18T22:00:00.000Z",
				),
			],
			next_token: "",
		},
	],
};

test("one sleep walk feeds both the sleep and respiratory_rate streams", async () => {
	const { ctx, records } = makeContext();
	const { fetchImpl, requests } = fakeWhoop({ pages: ONLY_SLEEP });
	await collectWhoop(ctx, {
		httpGovernor: governor,
		fetchImpl,
		now: () => NOW,
	});
	assert.equal(recordsFor(records, "sleep").length, 2);
	assert.equal(recordsFor(records, "respiratory_rate").length, 2);
	// The efficiency claim in the module note: asking for both costs one walk.
	const sleepRequests = requests.filter((url) =>
		url.includes("/v2/activity/sleep"),
	);
	assert.equal(sleepRequests.length, 1);
});

test("a night with no measured breathing rate emits sleep but not a rate", async () => {
	const { ctx, records } = makeContext();
	const { fetchImpl } = fakeWhoop({
		pages: {
			"/v2/activity/sleep": [
				{
					records: [
						sleep(
							"cccc3333-3333-4333-8333-333333333333",
							"2026-09-18T22:00:00.000Z",
							{
								respiratoryRate: null,
							},
						),
					],
					next_token: "",
				},
			],
		},
	});
	await collectWhoop(ctx, {
		httpGovernor: governor,
		fetchImpl,
		now: () => NOW,
	});
	assert.equal(recordsFor(records, "sleep").length, 1);
	assert.equal(recordsFor(records, "respiratory_rate").length, 0);
	// Both streams get their own receipt, and the gap is reported on the stream
	// that is actually empty. Reporting it only on `sleep` would leave a reader
	// of respiratory_rate unable to tell "WHOOP measured none" from "collection
	// never ran" — the exact confusion this stream exists to prevent.
	assert.equal(coverageFor(records, "sleep")?.record_count, 1);
	const rate = coverageFor(records, "respiratory_rate");
	assert.ok(rate, "respiratory_rate must get its own receipt");
	assert.equal(rate.record_count, 0);
	assert.deepEqual(rate.fields_unavailable, ["respiratory_rate"]);
});

test("each requested stream of one walk gets its own receipt", () => {
	// The manifest promises "one record per stream per run". One walk serving
	// two streams must still produce two receipts, with their own counts.
	const { ctx, records } = makeContext();
	const { fetchImpl } = fakeWhoop({ pages: ONLY_SLEEP });
	return collectWhoop(ctx, {
		httpGovernor: governor,
		fetchImpl,
		now: () => NOW,
	}).then(() => {
		assert.equal(coverageFor(records, "sleep")?.record_count, 2);
		assert.equal(coverageFor(records, "respiratory_rate")?.record_count, 2);
	});
});

test("requesting respiratory_rate alone does not emit sleep records", async () => {
	// The consent split is only real if asking for one does not deliver the
	// other.
	const { ctx, records } = makeContext({
		streams: [{ name: "respiratory_rate" }, { name: "coverage_diagnostics" }],
	});
	const { fetchImpl } = fakeWhoop({ pages: ONLY_SLEEP });
	await collectWhoop(ctx, {
		httpGovernor: governor,
		fetchImpl,
		now: () => NOW,
	});
	assert.equal(recordsFor(records, "sleep").length, 0);
	assert.equal(recordsFor(records, "respiratory_rate").length, 2);
});

test("the cursor advances to the newest record collected", async () => {
	const { ctx, messages } = makeContext();
	const { fetchImpl } = fakeWhoop({ pages: ONLY_SLEEP });
	await collectWhoop(ctx, {
		httpGovernor: governor,
		fetchImpl,
		now: () => NOW,
	});
	assert.deepEqual(cursorFor(messages, "sleep"), {
		through: "2026-09-18T22:00:00.000Z",
	});
});

test("a capped walk HOLDS its cursor and discloses the deferred tail", async () => {
	// Advancing past pages this run never read would skip them permanently: the
	// next run would start beyond data that was never collected.
	const { ctx, messages, records } = makeContext({
		state: { sleep: { through: "2026-09-10T00:00:00.000Z" } },
	});
	const { fetchImpl } = fakeWhoop({
		pages: {
			"/v2/activity/sleep": [
				{
					records: [
						sleep(
							"dddd4444-4444-4444-8444-444444444444",
							"2026-09-18T22:00:00.000Z",
						),
					],
					next_token: "always-more",
				},
			],
		},
	});
	await collectWhoop(ctx, {
		httpGovernor: governor,
		fetchImpl,
		maxPages: 2,
		now: () => NOW,
	});
	const held = cursorFor(messages, "sleep") as {
		through?: string;
		resume_token?: string;
	};
	assert.equal(
		held.through,
		"2026-09-10T00:00:00.000Z",
		"a truncated walk must hold the cursor it started from",
	);
	assert.equal(
		held.resume_token,
		"always-more",
		"and must carry the page it stopped on, or the tail is unreachable",
	);
	const skip = messages.find((msg) => msg.type === "SKIP_RESULT");
	assert.ok(skip, "a capped walk must disclose the deferred pages");
	assert.equal(coverageFor(records, "sleep")?.reason, "page_budget_reached");
});

test("the next run rewinds behind its cursor so rescored nights come back", async () => {
	// WHOOP filters on occurrence time, and scoring does not move a record in
	// time. Without the rewind, a night collected while PENDING_SCORE would
	// never be collected again and would stay blank forever.
	const { ctx } = makeContext({
		state: {
			sleep: { through: "2026-09-18T00:00:00.000Z" },
			respiratory_rate: { through: "2026-09-18T00:00:00.000Z" },
		},
	});
	const { fetchImpl, requests } = fakeWhoop({ pages: ONLY_SLEEP });
	await collectWhoop(ctx, {
		httpGovernor: governor,
		fetchImpl,
		now: () => NOW,
	});
	const start = new URL(
		requests.find((url) => url.includes("/v2/activity/sleep")) ?? "",
	).searchParams.get("start");
	assert.equal(start, "2026-09-11T00:00:00.000Z");
});

test("one walk serving two streams starts at the EARLIER of their cursors", async () => {
	// Taking the later one would silently skip everything in between.
	const { ctx } = makeContext({
		state: {
			sleep: { through: "2026-09-18T00:00:00.000Z" },
			respiratory_rate: { through: "2026-09-12T00:00:00.000Z" },
		},
	});
	const { fetchImpl, requests } = fakeWhoop({ pages: ONLY_SLEEP });
	await collectWhoop(ctx, {
		httpGovernor: governor,
		fetchImpl,
		now: () => NOW,
	});
	const start = new URL(
		requests.find((url) => url.includes("/v2/activity/sleep")) ?? "",
	).searchParams.get("start");
	assert.equal(start, "2026-09-05T00:00:00.000Z");
});

test("adding a second stream to an established connection refetches from the start", async () => {
	// An owner who has collected `sleep` for months and now asks for
	// `respiratory_rate` must not receive breathing data that begins today.
	// Any stream in the group without a cursor means the walk starts at the
	// beginning.
	const { ctx } = makeContext({
		state: { sleep: { through: "2026-09-18T00:00:00.000Z" } },
	});
	const { fetchImpl, requests } = fakeWhoop({ pages: ONLY_SLEEP });
	await collectWhoop(ctx, {
		httpGovernor: governor,
		fetchImpl,
		now: () => NOW,
	});
	const start = new URL(
		requests.find((url) => url.includes("/v2/activity/sleep")) ?? "",
	).searchParams.get("start");
	assert.equal(start, null);
});

test("full_refresh ignores the cursor entirely", async () => {
	const { ctx } = makeContext({
		state: { sleep: { through: "2026-09-18T00:00:00.000Z" } },
	});
	(ctx as { collectionMode?: string }).collectionMode = "full_refresh";
	const { fetchImpl, requests } = fakeWhoop({ pages: ONLY_SLEEP });
	await collectWhoop(ctx, {
		httpGovernor: governor,
		fetchImpl,
		now: () => NOW,
	});
	const start = new URL(
		requests.find((url) => url.includes("/v2/activity/sleep")) ?? "",
	).searchParams.get("start");
	assert.equal(
		start,
		null,
		"full_refresh must not send a cursor-derived start",
	);
});

test("an unscored night reports awaiting_score, not a clean sweep", async () => {
	const { ctx, records } = makeContext();
	const { fetchImpl } = fakeWhoop({
		pages: {
			"/v2/activity/sleep": [
				{
					records: [
						sleep(
							"eeee5555-5555-4555-8555-555555555555",
							"2026-09-18T22:00:00.000Z",
							{
								scored: false,
							},
						),
					],
					next_token: "",
				},
			],
		},
	});
	await collectWhoop(ctx, {
		httpGovernor: governor,
		fetchImpl,
		now: () => NOW,
	});
	const receipt = coverageFor(records, "sleep");
	assert.equal(receipt?.reason, "awaiting_score");
	assert.equal(receipt?.records_pending_score, 1);
	assert.equal(receipt?.records_unscorable, 0);
	assert.equal(receipt?.status, "partial");
});

test("a night WHOOP will never score reports the reason that ends the wait", async () => {
	// The discriminating pair. Both produce a record with no measurements, and
	// telling an owner to wait for one that is never coming is the failure this
	// separation exists to prevent.
	const { ctx, records } = makeContext();
	const { fetchImpl } = fakeWhoop({
		pages: {
			"/v2/activity/sleep": [
				{
					records: [
						sleep(
							"ffff6666-6666-4666-8666-666666666666",
							"2026-09-18T22:00:00.000Z",
							{
								scored: false,
								state: "UNSCORABLE",
							},
						),
					],
					next_token: "",
				},
			],
		},
	});
	await collectWhoop(ctx, {
		httpGovernor: governor,
		fetchImpl,
		now: () => NOW,
	});
	const receipt = coverageFor(records, "sleep");
	assert.equal(receipt?.reason, "unscorable_records_skipped");
	assert.equal(receipt?.records_unscorable, 1);
});

test("an empty window reports nothing_in_range rather than a fault", async () => {
	const { ctx, records } = makeContext({
		streams: [{ name: "cycles" }, { name: "coverage_diagnostics" }],
	});
	const { fetchImpl } = fakeWhoop({
		pages: { "/v2/cycle": [{ records: [], next_token: "" }] },
	});
	await collectWhoop(ctx, {
		httpGovernor: governor,
		fetchImpl,
		now: () => NOW,
	});
	const receipt = coverageFor(records, "cycles");
	assert.equal(receipt?.reason, "nothing_in_range");
	assert.equal(receipt?.status, "empty");
});

test("an expired authorization stops the run instead of burning rate budget", async () => {
	// Every remaining stream would fail identically, and each attempt spends
	// budget the owner may need immediately after reconnecting.
	const { ctx, records, failures } = makeContext();
	const { fetchImpl, requests } = fakeWhoop({
		pages: ONLY_SLEEP,
		fail: { "/v2/activity/sleep": 401 },
	});
	await collectWhoop(ctx, {
		httpGovernor: governor,
		fetchImpl,
		now: () => NOW,
	});
	assert.equal(coverageFor(records, "sleep")?.reason, "authorization_expired");
	assert.equal(
		coverageFor(records, "recovery"),
		undefined,
		"later streams must not be attempted after an expired authorization",
	);
	assert.equal(
		requests.some((url) => url.includes("/v2/recovery")),
		false,
	);
	assert.equal(failures[0]?.stream, "sleep");
});

test("a stream failure is reported, not swallowed into a green run", async () => {
	const { ctx, records, failures } = makeContext({
		streams: [{ name: "cycles" }, { name: "coverage_diagnostics" }],
	});
	const { fetchImpl } = fakeWhoop({
		pages: {},
		fail: { "/v2/cycle": 502 },
	});
	await collectWhoop(ctx, {
		httpGovernor: governor,
		fetchImpl,
		now: () => NOW,
	});
	assert.equal(
		coverageFor(records, "cycles")?.reason,
		"collection_interrupted",
	);
	assert.equal(failures[0]?.stream, "cycles");
	assert.match(failures[0]?.message ?? "", /whoop_http_502/);
});

test("a recovery window with no blood-oxygen readings names the gap", async () => {
	const { ctx, records } = makeContext({
		streams: [{ name: "recovery" }, { name: "coverage_diagnostics" }],
	});
	const { fetchImpl } = fakeWhoop({
		pages: {
			"/v2/recovery": [
				{
					records: [
						{
							cycle_id: 1,
							sleep_id: "aaaa1111-1111-4111-8111-111111111111",
							user_id: 1,
							created_at: "2026-09-18T06:00:00.000Z",
							updated_at: "2026-09-18T06:00:00.000Z",
							score_state: "SCORED",
							score: {
								user_calibrating: false,
								recovery_score: 67,
								resting_heart_rate: 51,
								hrv_rmssd_milli: 64.3,
							},
						},
					],
					next_token: "",
				},
			],
		},
	});
	await collectWhoop(ctx, {
		httpGovernor: governor,
		fetchImpl,
		now: () => NOW,
	});
	assert.deepEqual(coverageFor(records, "recovery")?.fields_unavailable, [
		"skin_temp_celsius",
		"spo2_percentage",
	]);
});

test("a capped walk resumes from its token on the NEXT run", async () => {
	// The test that distinguishes a deferral from a stall. Without the token the
	// second run re-requests the identical window from page one, hits the
	// identical ceiling, and record C never arrives however often it runs.
	const pages: Record<string, { records: unknown[]; next_token: string }> = {
		"": {
			records: [
				sleep(
					"aaaa1111-1111-4111-8111-111111111111",
					"2026-09-16T22:00:00.000Z",
				),
			],
			next_token: "t1",
		},
		t1: {
			records: [
				sleep(
					"bbbb2222-2222-4222-8222-222222222222",
					"2026-09-17T22:00:00.000Z",
				),
			],
			next_token: "t2",
		},
		t2: {
			records: [
				sleep(
					"cccc3333-3333-4333-8333-333333333333",
					"2026-09-18T22:00:00.000Z",
				),
			],
			next_token: "",
		},
	};
	const sent: (string | null)[] = [];
	const fetchImpl = (async (url: string) => {
		const token = new URL(url).searchParams.get("nextToken");
		sent.push(token);
		return new Response(JSON.stringify(pages[token ?? ""]), { status: 200 });
	}) as unknown as typeof fetch;

	const first = makeContext({ streams: [{ name: "sleep" }] });
	await collectWhoop(first.ctx, {
		httpGovernor: governor,
		fetchImpl,
		maxPages: 2,
		now: () => NOW,
	});
	assert.equal(recordsFor(first.records, "sleep").length, 2);
	const carried = cursorFor(first.messages, "sleep") as {
		resume_token?: string;
	};
	assert.equal(
		carried.resume_token,
		"t2",
		"a truncated walk must persist the page it stopped on",
	);

	// Second run, seeded with exactly what the first run emitted as STATE.
	const second = makeContext({
		streams: [{ name: "sleep" }],
		state: { sleep: carried },
	});
	await collectWhoop(second.ctx, {
		httpGovernor: governor,
		fetchImpl,
		maxPages: 2,
		now: () => NOW,
	});
	assert.deepEqual(
		recordsFor(second.records, "sleep").map((row) => row.id),
		["cccc3333-3333-4333-8333-333333333333"],
		"the second run must collect the deferred tail, not re-read the head",
	);
	assert.equal(sent[2], "t2", "the stored token must be sent, not discarded");
	const done = cursorFor(second.messages, "sleep") as {
		resume_token?: string;
	};
	assert.equal(
		done.resume_token,
		undefined,
		"a completed walk must clear the tail so the third run starts clean",
	);
});

test("each grouped stream is filtered by its OWN consented range", async () => {
	// sleep is consented from the 18th; respiratory_rate from the 10th. A row on
	// the 12th belongs to respiratory_rate only. Gating both on sleep's range
	// would drop it AND advance respiratory_rate's cursor past it, leaving a
	// permanent hole in the stream that asked for the wider window.
	const { ctx, records } = makeContext({
		streams: [
			{ name: "sleep", time_range: { since: "2026-09-18T00:00:00.000Z" } },
			{
				name: "respiratory_rate",
				time_range: { since: "2026-09-10T00:00:00.000Z" },
			},
			{ name: "coverage_diagnostics" },
		],
	});
	const { fetchImpl } = fakeWhoop({
		pages: {
			"/v2/activity/sleep": [
				{
					records: [
						sleep(
							"dddd4444-4444-4444-8444-444444444444",
							"2026-09-12T22:00:00.000Z",
						),
						sleep(
							"eeee5555-5555-4555-8555-555555555555",
							"2026-09-19T22:00:00.000Z",
						),
					],
					next_token: "",
				},
			],
		},
	});
	await collectWhoop(ctx, {
		httpGovernor: governor,
		fetchImpl,
		now: () => NOW,
	});

	assert.deepEqual(
		recordsFor(records, "sleep").map((row) => row.start),
		["2026-09-19T22:00:00.000Z"],
		"sleep must see only its own consented window",
	);
	assert.deepEqual(
		recordsFor(records, "respiratory_rate").map((row) => row.start),
		["2026-09-12T22:00:00.000Z", "2026-09-19T22:00:00.000Z"],
		"respiratory_rate asked for the wider window and must receive it",
	);
	assert.equal(coverageFor(records, "sleep")?.record_count, 1);
	assert.equal(coverageFor(records, "respiratory_rate")?.record_count, 2);
	assert.equal(
		coverageFor(records, "respiratory_rate")?.window_covered_from,
		"2026-09-12T22:00:00.000Z",
		"the receipt must report the window this stream actually covered",
	);
});

test("a rotated refresh token is surfaced to the run log", async () => {
	// PDPP cannot persist it, so saying so is the only disclosure available and
	// is what turns a silent second-run failure into an explicable one.
	const progress: string[] = [];
	const { ctx } = makeContext();
	(ctx as { credentials: Record<string, string> }).credentials = {
		WHOOP_OAUTH_CLIENT_ID: "client-abc",
		WHOOP_OAUTH_CLIENT_SECRET: "secret-xyz",
		WHOOP_REFRESH_TOKEN: "refresh-1",
	};
	(ctx as { progress: (m: string) => Promise<void> }).progress = (message) => {
		progress.push(message);
		return Promise.resolve();
	};
	const fetchImpl = (async (url: string) => {
		if (url.includes("/oauth/oauth2/token")) {
			return new Response(
				JSON.stringify({
					access_token: "access-2",
					refresh_token: "refresh-2",
					expires_in: 3600,
				}),
				{ status: 200 },
			);
		}
		return new Response(JSON.stringify({ records: [], next_token: "" }), {
			status: 200,
		});
	}) as unknown as typeof fetch;

	await collectWhoop(ctx, {
		httpGovernor: governor,
		fetchImpl,
		now: () => NOW,
	});
	assert.ok(
		progress.some((line) => /replacement refresh token/i.test(line)),
		"the run must disclose that the stored credential is now stale",
	);
});
