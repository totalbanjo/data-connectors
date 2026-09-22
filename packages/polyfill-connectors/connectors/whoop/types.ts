// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Upstream shapes returned by WHOOP's **public developer API**, v2.
 *
 * Source of truth: WHOOP's own OpenAPI document, served at
 * https://api.prod.whoop.com/developer/doc/openapi.json (read 2026-09-19).
 * Every field below is transcribed from that document, including which fields
 * it marks required and which it marks nullable. Where this file and the
 * document disagree, the document wins — re-read it rather than the field list
 * of whatever a live account happened to return.
 *
 * Two shapes here are load-bearing and easy to get wrong:
 *
 * 1. `score` is OPTIONAL on every record, and `score_state` says why. A record
 *    with `score_state: "PENDING_SCORE"` or `"UNSCORABLE"` carries no `score`
 *    at all. Treating `score` as present is the fail-closed trap that rejects
 *    real data — WHOOP emits unscored records routinely, for the most recent
 *    night and for any night the strap was off.
 * 2. Collection responses paginate with `next_token`, and the request spells
 *    the same value `nextToken`. The mismatch is WHOOP's, not a typo here.
 */

/** Present on every scorable resource. `score` is populated only for `SCORED`. */
export type WhoopScoreState = "SCORED" | "PENDING_SCORE" | "UNSCORABLE";

/** `GET /v2/recovery` — `records[]`. */
export interface WhoopRecovery {
	cycle_id: number;
	sleep_id: string;
	user_id: number;
	created_at: string;
	updated_at: string;
	score_state: WhoopScoreState;
	score?: WhoopRecoveryScore | null;
}

export interface WhoopRecoveryScore {
	user_calibrating: boolean;
	recovery_score: number;
	resting_heart_rate: number;
	hrv_rmssd_milli: number;
	/** Optional in the OpenAPI document; absent for straps without the sensor. */
	spo2_percentage?: number | null;
	skin_temp_celsius?: number | null;
}

/** `GET /v2/cycle` — `records[]`. A cycle is WHOOP's physiological day. */
export interface WhoopCycle {
	id: number;
	user_id: number;
	created_at: string;
	updated_at: string;
	start: string;
	/** Absent while the cycle is still open (i.e. the current day). */
	end?: string | null;
	timezone_offset: string;
	score_state: WhoopScoreState;
	score?: WhoopCycleScore | null;
}

export interface WhoopCycleScore {
	strain: number;
	kilojoule: number;
	average_heart_rate: number;
	max_heart_rate: number;
}

/** `GET /v2/activity/sleep` — `records[]`. */
export interface WhoopSleep {
	id: string;
	cycle_id: number;
	/** Present only for sleeps that also existed under the retired v1 API. */
	v1_id?: number | null;
	user_id: number;
	created_at: string;
	updated_at: string;
	start: string;
	end: string;
	timezone_offset: string;
	nap: boolean;
	score_state: WhoopScoreState;
	score?: WhoopSleepScore | null;
}

export interface WhoopSleepScore {
	stage_summary: WhoopSleepStageSummary;
	sleep_needed: WhoopSleepNeeded;
	/** Breaths per minute. Optional: WHOOP omits it when it could not measure. */
	respiratory_rate?: number | null;
	sleep_performance_percentage?: number | null;
	sleep_consistency_percentage?: number | null;
	sleep_efficiency_percentage?: number | null;
}

export interface WhoopSleepStageSummary {
	total_in_bed_time_milli: number;
	total_awake_time_milli: number;
	total_no_data_time_milli: number;
	total_light_sleep_time_milli: number;
	total_slow_wave_sleep_time_milli: number;
	total_rem_sleep_time_milli: number;
	sleep_cycle_count: number;
	disturbance_count: number;
}

export interface WhoopSleepNeeded {
	baseline_milli: number;
	need_from_sleep_debt_milli: number;
	need_from_recent_strain_milli: number;
	need_from_recent_nap_milli: number;
}

/**
 * Every collection endpoint returns this envelope. `next_token` is absent or
 * empty on the last page — WHOOP's pagination guide defines "done" as an empty
 * `next_token`, not a short page, so never infer the end from `records.length`.
 */
export interface WhoopPage<T> {
	records: T[];
	next_token?: string | null;
}
