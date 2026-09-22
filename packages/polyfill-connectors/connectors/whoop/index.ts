#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * PDPP WHOOP Collection Profile.
 *
 * Collects from WHOOP's **public developer API** (v2) over an OAuth 2.0
 * authorization-code grant. Streams: `sleep`, `respiratory_rate`, `recovery`,
 * `cycles`, plus a `coverage_diagnostics` receipt.
 *
 * ---------------------------------------------------------------------------
 * Why this connector was rewritten rather than extended
 * ---------------------------------------------------------------------------
 * The previous implementation drove `app.whoop.com` in a browser profile and
 * called WHOOP's internal endpoints with a bearer token read out of the
 * `whoop-auth-token` cookie. That is replaced because WHOOP's API Terms of
 * Use §1 require that "Company will only access (or attempt to access) any API
 * by the means described in the documentation of that API", and §4 separately
 * prohibits scraping. A lifted session token against an undocumented endpoint
 * is neither.
 *
 * See `api.ts` for the trap that follows from this: WHOOP's official OAuth
 * endpoints live on the SAME host as its internal API. The path discriminates;
 * the hostname does not.
 *
 * ---------------------------------------------------------------------------
 * Two source behaviours that decide the design
 * ---------------------------------------------------------------------------
 *
 * **Records are rescored after they are first written.** Every WHOOP record
 * carries `score_state`, and the newest night is routinely `PENDING_SCORE`
 * with no `score` object at all. Hours later the same record becomes `SCORED`.
 * WHOOP's collections filter on *occurrence* time, not update time, so a
 * forward-only cursor would never see the second version — the record does not
 * move in time when it is scored. Every walk therefore rewinds
 * `REWIND_DAYS` behind the cursor, which is what lets an unscored record be
 * collected again once it has a score. Primary keys are WHOOP's own ids, so
 * the re-read collapses onto the same record rather than duplicating it.
 *
 * **Sleep is fetched once and feeds two streams.** `respiratory_rate` is a
 * projection of the sleep collection, split out so that a reading application
 * can obtain breathing measurements without also obtaining sleep staging,
 * disturbance counts and sleep-debt figures — PDPP stream names are consent
 * scopes, so the split is what makes that possible. One walk serves both, so
 * asking for both costs no extra requests and cannot produce two views that
 * disagree.
 */

import { isMainModule, passesTimeRange } from "@pdpp/connector-protocol";
import {
	type ConnectorHttpGovernor,
	createConnectorHttpGovernor,
} from "../../src/connector-http-governor.ts";
import {
	type CollectContext,
	type RecordData,
	runConnector,
} from "../../src/connector-runtime.ts";
import { whoopPacingProfile } from "../../src/provider-profile.ts";
import {
	acquireAccessToken,
	resolveWhoopCredentials,
	WhoopAuthorizationExpiredError,
	type WhoopHttpGovernor,
	walkWhoopCollection,
} from "./api.ts";
import {
	buildCoverageRecord,
	buildCycleRecord,
	buildRecoveryRecord,
	buildRespiratoryRateRecord,
	buildSleepRecord,
} from "./parsers.ts";
import { validateRecord } from "./schemas.ts";
import type { WhoopCycle, WhoopRecovery, WhoopSleep } from "./types.ts";

/**
 * 200 pages × 25 records is 5,000 records per collection per run — several
 * years of daily data, so an ordinary backfill finishes inside one run while a
 * pathological account still terminates and discloses the remainder.
 */
const MAX_PAGES = 200;

/**
 * How far behind the cursor each walk restarts, so records that were unscored
 * when first collected are collected again once WHOOP scores them. WHOOP
 * normally scores within hours; seven days is deliberately generous, and costs
 * one extra page per stream per run at the default page size.
 */
const REWIND_DAYS = 7;
const MS_PER_DAY = 86_400_000;

// §3 ProviderProfile: whoop declares its own pacing ceiling, derived from
// WHOOP's two documented limits (100 req/min and 10,000 req/day) rather than
// borrowed from another provider. See src/provider-profile.ts →
// whoopPacingProfile for the derivation. `maxAttempts: 1` keeps a 429 throwing
// `whoop_rate_limited` immediately, so the runtime's cross-run source-pressure
// deferral contract stays in force.
const httpGovernor = createConnectorHttpGovernor({
	name: "whoop",
	maxAttempts: 1,
	profile: whoopPacingProfile(),
});

interface WhoopStreamState {
	through?: string;
	/**
	 * The pagination token a previous run's page ceiling stopped on, and the
	 * window start it belongs to. WHOOP's continuation token encodes the query it
	 * was issued for, so replaying it against a different window is meaningless —
	 * the pair is stored and checked together, and a mismatch discards the token
	 * and walks fresh rather than resuming into the wrong place.
	 */
	resume_token?: string;
	resume_from?: string;
}

/** Outcome of one stream's walk, before it becomes a coverage receipt. */
interface StreamOutcome {
	recordCount: number;
	pendingScore: number;
	unscorable: number;
	fieldsUnavailable: string[];
	coveredFrom: string | null;
	coveredTo: string | null;
	truncated: boolean;
	failure: "authorization_expired" | "rate_limited" | "interrupted" | null;
	/** Non-null only when the page ceiling stopped this walk mid-collection. */
	resumeToken: string | null;
	/** The window start `resumeToken` was issued against. */
	resumeFrom: string | null;
}

/**
 * Outcomes keyed by the stream they describe. A walk that serves two streams —
 * sleep and its respiratory-rate projection — returns one entry per REQUESTED
 * stream, because the manifest promises one receipt per stream per run, and a
 * reader of respiratory_rate needs to tell "WHOOP measured no breathing" from
 * "collection never ran".
 */
type StreamOutcomes = Record<string, StreamOutcome>;

function emptyOutcome(): StreamOutcome {
	return {
		recordCount: 0,
		pendingScore: 0,
		unscorable: 0,
		fieldsUnavailable: [],
		coveredFrom: null,
		coveredTo: null,
		truncated: false,
		failure: null,
		resumeToken: null,
		resumeFrom: null,
	};
}

/**
 * The window this run asks WHOOP for.
 *
 * `full_refresh` is an explicit operator bypass and must ignore the cursor
 * entirely — for a source whose records are edited in place rather than moved
 * in time, it is the only way a correction from further back than the rewind
 * window ever reaches a reader.
 */
function windowStartFor(
	state: Record<string, unknown>,
	requested: Map<string, { time_range?: { since?: string } }>,
	stream: string,
	collectionMode: "full_refresh" | "incremental" | undefined,
): string | undefined {
	const scopeSince = requested.get(stream)?.time_range?.since;
	if (collectionMode === "full_refresh") {
		return scopeSince ?? undefined;
	}
	const through = (state[stream] as WhoopStreamState | undefined)?.through;
	if (through) {
		const rewound = Date.parse(through) - REWIND_DAYS * MS_PER_DAY;
		if (Number.isFinite(rewound)) {
			return new Date(rewound).toISOString();
		}
	}
	return scopeSince ?? undefined;
}

/**
 * The window for a walk that serves several streams at once.
 *
 * It starts at the EARLIEST of their cursors, and at the beginning if any of
 * them has none yet. Taking the latest, or just the first stream's, would
 * silently skip everything between the two — which is exactly what happens the
 * first time an owner adds `respiratory_rate` to a connection that has been
 * collecting `sleep` for months.
 */
function groupWindowStart(
	ctx: CollectContext,
	streams: readonly string[],
): string | undefined {
	const starts = streams.map((stream) =>
		windowStartFor(ctx.state, ctx.requested, stream, ctx.collectionMode),
	);
	if (starts.some((start) => start === undefined)) {
		return undefined;
	}
	return starts.reduce((earliest, start) =>
		earliest && start && start < earliest ? start : earliest,
	);
}

/**
 * Classify a thrown error into the coverage vocabulary. Anything unrecognised
 * is `interrupted` — the reason whose owner-facing sentence promises a retry,
 * which is the safe direction for an unknown fault.
 */
function classifyFailure(error: unknown): StreamOutcome["failure"] {
	if (error instanceof WhoopAuthorizationExpiredError) {
		return "authorization_expired";
	}
	if (error instanceof Error && /rate_limited|429/i.test(error.message)) {
		return "rate_limited";
	}
	return "interrupted";
}

/**
 * Turn a walk's outcome into the one reason that best describes it.
 *
 * Order matters and encodes precedence: a failure outranks truncation, which
 * outranks a wait, which outranks a permanent gap. Each successive case is a
 * weaker claim about the same window, and reporting the weaker one would
 * understate what happened.
 */
function reasonFor(outcome: StreamOutcome): string {
	if (outcome.failure === "authorization_expired") {
		return "authorization_expired";
	}
	if (outcome.failure === "rate_limited") {
		return "rate_limited";
	}
	if (outcome.failure === "interrupted") {
		return "collection_interrupted";
	}
	if (outcome.truncated) {
		return "page_budget_reached";
	}
	if (outcome.pendingScore > 0) {
		return "awaiting_score";
	}
	if (outcome.unscorable > 0) {
		return "unscorable_records_skipped";
	}
	if (outcome.recordCount === 0) {
		return "nothing_in_range";
	}
	return "covered_in_full";
}

function statusFor(outcome: StreamOutcome): "complete" | "partial" | "empty" {
	if (outcome.failure || outcome.truncated) {
		return outcome.recordCount > 0 ? "partial" : "empty";
	}
	if (outcome.recordCount === 0) {
		return "empty";
	}
	if (outcome.pendingScore > 0 || outcome.unscorable > 0) {
		return "partial";
	}
	return "complete";
}

interface EmitCoverageArgs {
	ctx: CollectContext;
	stream: string;
	outcome: StreamOutcome;
	windowStart: string | undefined;
	collectedAt: string;
}

async function emitCoverage(args: EmitCoverageArgs): Promise<void> {
	const { ctx, stream, outcome, windowStart, collectedAt } = args;
	if (!ctx.requested.has("coverage_diagnostics")) {
		return;
	}
	await ctx.emitRecord(
		"coverage_diagnostics",
		buildCoverageRecord({
			stream,
			status: statusFor(outcome),
			reason: reasonFor(outcome),
			recordCount: outcome.recordCount,
			recordsPendingScore: outcome.pendingScore,
			recordsUnscorable: outcome.unscorable,
			fieldsUnavailable: outcome.fieldsUnavailable,
			windowRequestedFrom: windowStart ?? null,
			windowRequestedTo: null,
			windowCoveredFrom: outcome.coveredFrom,
			windowCoveredTo: outcome.coveredTo,
			collectedAt,
		}) as RecordData,
	);
}

/**
 * Record a covered-window bound and count a record towards coverage, but only
 * when the runtime would actually keep it.
 *
 * Counting before the runtime's own `time_range` filter would report records
 * that were then dropped — a receipt that lies, inside the stream built to
 * stop receipts lying.
 */
function noteWindow(outcome: StreamOutcome, at: string): void {
	if (!outcome.coveredFrom || at < outcome.coveredFrom) {
		outcome.coveredFrom = at;
	}
	if (!outcome.coveredTo || at > outcome.coveredTo) {
		outcome.coveredTo = at;
	}
}

function accountFor(
	outcome: StreamOutcome,
	timeRange: { since?: string; until?: string } | undefined,
	at: string,
): boolean {
	if (!passesTimeRange(at, timeRange)) {
		return false;
	}
	outcome.recordCount += 1;
	noteWindow(outcome, at);
	return true;
}

/**
 * The window a walk should ask WHOOP for, and the tail it should resume from.
 *
 * A stored token is only replayed against the window it was issued for. That
 * pairing is what makes the page ceiling a deferral rather than a stall: the
 * cursor is deliberately held when a walk truncates, so the next run computes
 * the same start, matches the stored `resume_from`, and continues from the
 * exact page the ceiling stopped on instead of re-reading from the first.
 */
function walkWindow(
	ctx: CollectContext,
	streams: readonly string[],
	start: string | undefined,
): { start?: string; resumeToken?: string } {
	const window: { start?: string; resumeToken?: string } = {};
	if (start) {
		window.start = start;
	}
	if (ctx.collectionMode === "full_refresh") {
		// An explicit operator bypass walks the source from its natural
		// beginning; resuming a previous tail would defeat the point.
		return window;
	}
	for (const stream of streams) {
		const state = ctx.state[stream] as WhoopStreamState | undefined;
		if (
			state?.resume_token &&
			(state.resume_from ?? null) === (start ?? null)
		) {
			window.resumeToken = state.resume_token;
			return window;
		}
	}
	return window;
}

function countScoreState(outcome: StreamOutcome, scoreState: unknown): void {
	if (scoreState === "PENDING_SCORE") {
		outcome.pendingScore += 1;
	} else if (scoreState === "UNSCORABLE") {
		outcome.unscorable += 1;
	}
}

/**
 * Advance a stream's cursor, or hold it.
 *
 * Held whenever the walk did not reach the end of what WHOOP had: advancing
 * past a page the run never read, or past a window a failure cut short, would
 * skip that data permanently — the next run would start beyond it.
 */
async function emitState(
	ctx: CollectContext,
	stream: string,
	outcome: StreamOutcome,
	prior: string | undefined,
): Promise<void> {
	const advance = !outcome.truncated && outcome.failure === null;
	const next = advance ? (outcome.coveredTo ?? prior ?? null) : (prior ?? null);
	const cursor: Record<string, unknown> = { through: next };
	if (outcome.resumeToken) {
		// Held cursor plus the page the walk stopped on. Without it the next run
		// would re-request the identical window from page one and stop at the
		// identical ceiling, so the deferred tail would never arrive.
		cursor.resume_token = outcome.resumeToken;
		// A walk with no start window is a legitimate case — the very first run
		// of a connection has no cursor to derive one from — so `resume_from`
		// is simply omitted rather than written as null, and reads back as
		// absent, which `walkWindow` treats as matching an absent start.
		if (outcome.resumeFrom !== null) {
			cursor.resume_from = outcome.resumeFrom;
		}
	}
	await ctx.emit({ type: "STATE", stream, cursor });
}

async function emitTruncationSkip(
	ctx: CollectContext,
	stream: string,
	seen: number,
	maxPages: number,
): Promise<void> {
	await ctx.emit({
		type: "SKIP_RESULT",
		stream,
		reason: "older_pages_deferred_page_budget",
		message: `WHOOP ${stream} stopped at the ${String(maxPages)}-page limit with more records still listed`,
		diagnostics: {
			page_limit: maxPages,
			total_seen: seen,
			unread_pages: 1,
		},
	});
}

interface WalkArgs {
	ctx: CollectContext;
	governor: WhoopHttpGovernor;
	accessToken: string;
	maxPages: number;
	collectedAt: string;
	fetchImpl: typeof fetch;
}

/**
 * Sleep, and the respiratory-rate projection of it. One walk, two streams —
 * see the module note.
 */
async function collectSleep(args: WalkArgs): Promise<StreamOutcomes> {
	const { ctx, governor, accessToken, maxPages, collectedAt, fetchImpl } = args;
	const wantsSleep = ctx.requested.has("sleep");
	const wantsRate = ctx.requested.has("respiratory_rate");
	const served = [
		...(wantsSleep ? ["sleep"] : []),
		...(wantsRate ? ["respiratory_rate"] : []),
	];
	const start = groupWindowStart(ctx, served);

	/**
	 * Each stream is filtered by ITS OWN consented range.
	 *
	 * One upstream walk serves both, but a row outside sleep's range may still
	 * fall inside respiratory_rate's. Gating both on sleep's range would drop
	 * that row AND still advance respiratory_rate's cursor past it, leaving a
	 * permanent hole in precisely the stream that asked for the wider window.
	 */
	const sleepRange = ctx.requested.get("sleep")?.time_range;
	const rateRange = ctx.requested.get("respiratory_rate")?.time_range;

	const sleepOutcome = emptyOutcome();
	const rateOutcome = emptyOutcome();

	const { rows, truncated, resumeToken } =
		await walkWhoopCollection<WhoopSleep>(
			governor,
			"/v2/activity/sleep",
			accessToken,
			walkWindow(ctx, served, start),
			maxPages,
			fetchImpl,
		);
	for (const outcome of [sleepOutcome, rateOutcome]) {
		outcome.truncated = truncated;
		outcome.resumeToken = resumeToken;
		outcome.resumeFrom = start ?? null;
	}

	let ratesConsidered = 0;
	for (const sleep of rows) {
		if (wantsSleep && accountFor(sleepOutcome, sleepRange, sleep.start)) {
			countScoreState(sleepOutcome, sleep.score_state);
			await ctx.emitRecord(
				"sleep",
				buildSleepRecord(sleep, collectedAt) as RecordData,
			);
		}
		if (wantsRate && passesTimeRange(sleep.start, rateRange)) {
			// Counted as considered whether or not a rate was measured: the
			// covered window is what this stream looked at, and the record count
			// is what it found.
			ratesConsidered += 1;
			noteWindow(rateOutcome, sleep.start);
			countScoreState(rateOutcome, sleep.score_state);
			const rate = buildRespiratoryRateRecord(sleep, collectedAt);
			if (rate) {
				rateOutcome.recordCount += 1;
				await ctx.emitRecord("respiratory_rate", rate as RecordData);
			}
		}
	}

	const outcomes: StreamOutcomes = {};
	if (wantsSleep) {
		outcomes.sleep = sleepOutcome;
	}
	if (wantsRate) {
		// Every sleep in THIS stream's own window came back without a breathing
		// measurement. Saying so is the difference between "your strap does not
		// report this" and "collection dropped it".
		if (ratesConsidered > 0 && rateOutcome.recordCount === 0) {
			rateOutcome.fieldsUnavailable.push("respiratory_rate");
		}
		outcomes.respiratory_rate = rateOutcome;
	}
	return outcomes;
}

async function collectRecovery(args: WalkArgs): Promise<StreamOutcomes> {
	const { ctx, governor, accessToken, maxPages, collectedAt, fetchImpl } = args;
	const outcome = emptyOutcome();
	const start = windowStartFor(
		ctx.state,
		ctx.requested,
		"recovery",
		ctx.collectionMode,
	);
	const timeRange = ctx.requested.get("recovery")?.time_range;

	const { rows, truncated, resumeToken } =
		await walkWhoopCollection<WhoopRecovery>(
			governor,
			"/v2/recovery",
			accessToken,
			walkWindow(ctx, ["recovery"], start),
			maxPages,
			fetchImpl,
		);
	outcome.truncated = truncated;
	outcome.resumeToken = resumeToken;
	outcome.resumeFrom = start ?? null;

	let sawSpo2 = false;
	let sawSkinTemp = false;
	for (const recovery of rows) {
		if (!accountFor(outcome, timeRange, recovery.created_at)) {
			continue;
		}
		countScoreState(outcome, recovery.score_state);
		sawSpo2 ||= typeof recovery.score?.spo2_percentage === "number";
		sawSkinTemp ||= typeof recovery.score?.skin_temp_celsius === "number";
		await ctx.emitRecord(
			"recovery",
			buildRecoveryRecord(recovery, collectedAt) as RecordData,
		);
	}

	// Older WHOOP straps have neither sensor. A column of nulls would otherwise
	// be indistinguishable from a collection fault.
	if (outcome.recordCount > 0 && !sawSpo2) {
		outcome.fieldsUnavailable.push("spo2_percentage");
	}
	if (outcome.recordCount > 0 && !sawSkinTemp) {
		outcome.fieldsUnavailable.push("skin_temp_celsius");
	}
	return { recovery: outcome };
}

async function collectCycles(args: WalkArgs): Promise<StreamOutcomes> {
	const { ctx, governor, accessToken, maxPages, collectedAt, fetchImpl } = args;
	const outcome = emptyOutcome();
	const start = windowStartFor(
		ctx.state,
		ctx.requested,
		"cycles",
		ctx.collectionMode,
	);
	const timeRange = ctx.requested.get("cycles")?.time_range;

	const { rows, truncated, resumeToken } =
		await walkWhoopCollection<WhoopCycle>(
			governor,
			"/v2/cycle",
			accessToken,
			walkWindow(ctx, ["cycles"], start),
			maxPages,
			fetchImpl,
		);
	outcome.truncated = truncated;
	outcome.resumeToken = resumeToken;
	outcome.resumeFrom = start ?? null;

	for (const cycle of rows) {
		if (!accountFor(outcome, timeRange, cycle.start)) {
			continue;
		}
		countScoreState(outcome, cycle.score_state);
		await ctx.emitRecord(
			"cycles",
			buildCycleRecord(cycle, collectedAt) as RecordData,
		);
	}
	return { cycles: outcome };
}

export interface WhoopCollectOptions {
	/** Injectable so a test may substitute an unpaced governor. */
	readonly httpGovernor?: WhoopHttpGovernor;
	/** Injectable so a test can reach the capped exit with a two-page fixture. */
	readonly maxPages?: number;
	/** Injectable so a test can pin `collected_at`. */
	readonly now?: () => Date;
	/** Injectable so a test can serve canned WHOOP pages without a network. */
	readonly fetchImpl?: typeof fetch;
}

/** One walk, and every stream it produces a receipt and a cursor for. */
interface StreamPlan {
	streams: string[];
	walk: (args: WalkArgs) => Promise<StreamOutcomes>;
}

export async function collectWhoop(
	ctx: CollectContext,
	options: WhoopCollectOptions = {},
): Promise<void> {
	const maxPages = options.maxPages ?? MAX_PAGES;
	const governor = options.httpGovernor ?? httpGovernor;
	const collectedAt = (options.now?.() ?? new Date()).toISOString();
	const fetchImpl = options.fetchImpl ?? fetch;

	const credentials = resolveWhoopCredentials(
		ctx.credentials as Record<string, string | undefined>,
	);
	const token = await acquireAccessToken(credentials, { fetchImpl });

	if (token.rotatedRefreshToken) {
		// WHOOP rotated the refresh token and a connector cannot store the
		// replacement; see the rotation note in api.ts. Reporting it turns a
		// silent second-run failure into an explicable one.
		await ctx.progress(
			"WHOOP issued a replacement refresh token. PDPP cannot persist it yet, " +
				"so the next run may need the WHOOP account reconnected.",
		);
	}

	const plans: StreamPlan[] = [];
	const sleepGroup = ["sleep", "respiratory_rate"].filter((stream) =>
		ctx.requested.has(stream),
	);
	if (sleepGroup.length > 0) {
		plans.push({ streams: sleepGroup, walk: collectSleep });
	}
	if (ctx.requested.has("recovery")) {
		plans.push({ streams: ["recovery"], walk: collectRecovery });
	}
	if (ctx.requested.has("cycles")) {
		plans.push({ streams: ["cycles"], walk: collectCycles });
	}

	const walkArgs: WalkArgs = {
		ctx,
		governor,
		accessToken: token.accessToken,
		maxPages,
		collectedAt,
		fetchImpl,
	};

	let stopped = false;
	for (const plan of plans) {
		const windowStart = groupWindowStart(ctx, plan.streams);
		const primary = plan.streams[0] as string;
		await ctx.progress(`Collecting WHOOP ${plan.streams.join(" + ")}`, {
			stream: primary,
		});

		let outcomes: StreamOutcomes;
		try {
			outcomes = await plan.walk(walkArgs);
		} catch (error) {
			const failure = classifyFailure(error);
			outcomes = {};
			for (const stream of plan.streams) {
				outcomes[stream] = { ...emptyOutcome(), failure };
			}
			await ctx.reportStreamFailure?.(
				primary,
				error instanceof Error ? error.message : String(error),
				{ retryable: failure !== "authorization_expired" },
			);
		}

		for (const [stream, outcome] of Object.entries(outcomes)) {
			const prior = (ctx.state[stream] as WhoopStreamState | undefined)
				?.through;
			if (outcome.truncated) {
				await emitTruncationSkip(ctx, stream, outcome.recordCount, maxPages);
			}
			await emitState(ctx, stream, outcome, prior);
			await emitCoverage({ ctx, stream, outcome, windowStart, collectedAt });
			if (outcome.failure === "authorization_expired") {
				// Every remaining stream would fail identically and each attempt
				// spends rate budget the owner may need after reconnecting.
				stopped = true;
			}
		}
		if (stopped) {
			break;
		}
	}
}

if (isMainModule(import.meta.url)) {
	runConnector({
		name: "whoop",
		validateRecord,
		// The runtime's scope time_range filter defaults to a field literally
		// named `date`, which no WHOOP record has — leaving it unset would make
		// every record look out of range. Each stream filters on the same field
		// it is cursored and consented by.
		timeRangeField: (stream) =>
			stream === "recovery" ? "created_at" : "start",
		retryablePattern:
			/rate_limited|ECONN|ETIMEDOUT|timeout|fetch failed|whoop_http_5\d\d/i,
		auth: {
			kind: "env",
			required: [
				"WHOOP_OAUTH_CLIENT_ID",
				"WHOOP_OAUTH_CLIENT_SECRET",
				"WHOOP_REFRESH_TOKEN",
			],
		},
		collect: (ctx) => collectWhoop(ctx),
	});
}

export type { ConnectorHttpGovernor };
