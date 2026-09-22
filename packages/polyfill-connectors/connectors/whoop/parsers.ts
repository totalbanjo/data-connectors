// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure record builders: WHOOP v2 API shapes in, emitted PDPP records out.
 *
 * No I/O, no clock and no cursor logic here — `collected_at` is passed in so a
 * test can pin it and so every record from one run carries the same stamp.
 *
 * The single rule that governs all of these: **a missing measurement becomes
 * `null`, never `0`.** WHOOP omits the whole `score` object unless
 * `score_state` is `SCORED`, which happens routinely for the most recent night
 * and for any night the strap was off. A zero would claim a resting heart rate
 * of nothing and a day strain that a genuinely restful day can legitimately
 * produce, so the two must stay distinguishable.
 */

import type {
	WhoopCycle,
	WhoopRecovery,
	WhoopScoreState,
	WhoopSleep,
} from "./types.ts";

/** What every record carries about where it came from and when. */
export interface Provenance {
	source: "whoop_api_v2";
	freshness: "live";
	collected_at: string;
	updated_at: string;
}

function provenanceFor(updatedAt: string, collectedAt: string): Provenance {
	return {
		source: "whoop_api_v2",
		freshness: "live",
		collected_at: collectedAt,
		updated_at: updatedAt,
	};
}

/**
 * Narrow an optional upstream number to `number | null`.
 *
 * `undefined` and `null` both mean "WHOOP did not report this" and collapse to
 * `null`. A non-finite value (NaN, Infinity) is treated the same way rather
 * than emitted: it would pass a bare `typeof x === "number"` check and then
 * serialise to JSON as `null` anyway, so catching it here keeps the record and
 * its schema honest about which fields were actually measured.
 */
function metric(value: number | null | undefined): number | null {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return null;
	}
	return value;
}

/** As `metric`, for fields WHOOP documents as integers. */
function metricInt(value: number | null | undefined): number | null {
	const narrowed = metric(value);
	if (narrowed === null) {
		return null;
	}
	return Math.trunc(narrowed);
}

/**
 * `score_state` passes through exactly as WHOOP sent it, including a value
 * this connector has never heard of.
 *
 * That is deliberate. The runtime's record validator treats an unrecognised
 * enum value
 * as vocabulary drift rather than a fault: it keeps the record, preserves the
 * unknown value verbatim, and reports a shape anomaly an operator can act on.
 * Folding an unknown state into `UNSCORABLE` here would defeat all of that —
 * it would discard the only evidence that WHOOP changed its vocabulary, and it
 * would tell the owner "nothing further will arrive" about a record that might
 * simply be in a new intermediate state.
 *
 * A non-string is a different case: there is no source value to preserve, so
 * `UNSCORABLE` is the honest floor. It never claims a score is on its way.
 */
function scoreState(value: unknown): WhoopScoreState {
	if (typeof value === "string" && value) {
		return value as WhoopScoreState;
	}
	return "UNSCORABLE";
}

/** One emitted `sleep` record. Carries no respiratory rate: see schemas.ts. */
export function buildSleepRecord(
	sleep: WhoopSleep,
	collectedAt: string,
): Record<string, unknown> {
	const score = sleep.score ?? null;
	const stages = score?.stage_summary ?? null;
	const needed = score?.sleep_needed ?? null;
	return {
		id: sleep.id,
		cycle_id: sleep.cycle_id,
		start: sleep.start,
		end: sleep.end,
		timezone_offset: sleep.timezone_offset,
		nap: sleep.nap,
		score_state: scoreState(sleep.score_state),
		total_in_bed_time_milli: metricInt(stages?.total_in_bed_time_milli),
		total_awake_time_milli: metricInt(stages?.total_awake_time_milli),
		total_no_data_time_milli: metricInt(stages?.total_no_data_time_milli),
		total_light_sleep_time_milli: metricInt(
			stages?.total_light_sleep_time_milli,
		),
		total_slow_wave_sleep_time_milli: metricInt(
			stages?.total_slow_wave_sleep_time_milli,
		),
		total_rem_sleep_time_milli: metricInt(stages?.total_rem_sleep_time_milli),
		sleep_cycle_count: metricInt(stages?.sleep_cycle_count),
		disturbance_count: metricInt(stages?.disturbance_count),
		sleep_needed_baseline_milli: metricInt(needed?.baseline_milli),
		sleep_needed_from_sleep_debt_milli: metricInt(
			needed?.need_from_sleep_debt_milli,
		),
		sleep_needed_from_recent_strain_milli: metricInt(
			needed?.need_from_recent_strain_milli,
		),
		sleep_needed_from_recent_nap_milli: metricInt(
			needed?.need_from_recent_nap_milli,
		),
		sleep_performance_percentage: metric(score?.sleep_performance_percentage),
		sleep_consistency_percentage: metric(score?.sleep_consistency_percentage),
		sleep_efficiency_percentage: metric(score?.sleep_efficiency_percentage),
		...provenanceFor(sleep.updated_at, collectedAt),
	};
}

/**
 * One emitted `respiratory_rate` record, or `null` when WHOOP measured none.
 *
 * Returning `null` rather than a record with a null rate is deliberate. This
 * stream exists so a reader can ask for breathing without asking for sleep, and
 * a row of nulls in it would be indistinguishable from "this owner's strap
 * never measures breathing" — which is a different fact with a different
 * remedy. Nights without a measurement are counted in the coverage receipt
 * instead, where they can be explained.
 */
export function buildRespiratoryRateRecord(
	sleep: WhoopSleep,
	collectedAt: string,
): Record<string, unknown> | null {
	const rate = metric(sleep.score?.respiratory_rate);
	if (rate === null) {
		return null;
	}
	return {
		sleep_id: sleep.id,
		cycle_id: sleep.cycle_id,
		start: sleep.start,
		end: sleep.end,
		timezone_offset: sleep.timezone_offset,
		nap: sleep.nap,
		respiratory_rate: rate,
		score_state: scoreState(sleep.score_state),
		...provenanceFor(sleep.updated_at, collectedAt),
	};
}

/** One emitted `recovery` record. Keyed by `cycle_id` — see schemas.ts. */
export function buildRecoveryRecord(
	recovery: WhoopRecovery,
	collectedAt: string,
): Record<string, unknown> {
	const score = recovery.score ?? null;
	return {
		cycle_id: recovery.cycle_id,
		sleep_id: recovery.sleep_id,
		created_at: recovery.created_at,
		score_state: scoreState(recovery.score_state),
		user_calibrating:
			typeof score?.user_calibrating === "boolean"
				? score.user_calibrating
				: null,
		recovery_score: metric(score?.recovery_score),
		resting_heart_rate: metric(score?.resting_heart_rate),
		hrv_rmssd_milli: metric(score?.hrv_rmssd_milli),
		spo2_percentage: metric(score?.spo2_percentage),
		skin_temp_celsius: metric(score?.skin_temp_celsius),
		...provenanceFor(recovery.updated_at, collectedAt),
	};
}

/**
 * One emitted `cycles` record: a physiological day, carrying day strain.
 *
 * `end` stays null for the cycle the owner is still living; WHOOP omits it
 * until the day closes.
 */
export function buildCycleRecord(
	cycle: WhoopCycle,
	collectedAt: string,
): Record<string, unknown> {
	const score = cycle.score ?? null;
	return {
		id: cycle.id,
		start: cycle.start,
		end: typeof cycle.end === "string" && cycle.end ? cycle.end : null,
		timezone_offset: cycle.timezone_offset,
		score_state: scoreState(cycle.score_state),
		strain: metric(score?.strain),
		kilojoule: metric(score?.kilojoule),
		average_heart_rate: metricInt(score?.average_heart_rate),
		max_heart_rate: metricInt(score?.max_heart_rate),
		...provenanceFor(cycle.updated_at, collectedAt),
	};
}

/** Everything a coverage receipt needs that the accumulator does not compute. */
export interface CoverageInput {
	stream: string;
	status: "complete" | "partial" | "empty";
	reason: string;
	recordCount: number;
	recordsPendingScore: number;
	recordsUnscorable: number;
	fieldsUnavailable: string[];
	windowRequestedFrom: string | null;
	windowRequestedTo: string | null;
	windowCoveredFrom: string | null;
	windowCoveredTo: string | null;
	collectedAt: string;
}

/**
 * One coverage receipt. `id` is stream-scoped and run-scoped so two streams in
 * one run, and the same stream across runs, never collide on the primary key.
 */
export function buildCoverageRecord(
	input: CoverageInput,
): Record<string, unknown> {
	return {
		id: `${input.stream}:${input.collectedAt}`,
		stream: input.stream,
		status: input.status,
		reason: input.reason,
		record_count: input.recordCount,
		records_pending_score: input.recordsPendingScore,
		records_unscorable: input.recordsUnscorable,
		fields_unavailable: [...input.fieldsUnavailable].sort(),
		window_requested_from: input.windowRequestedFrom,
		window_requested_to: input.windowRequestedTo,
		window_covered_from: input.windowCoveredFrom,
		window_covered_to: input.windowCoveredTo,
		source: "whoop_api_v2",
		freshness: "live",
		collected_at: input.collectedAt,
	};
}
