// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Record-builder tests.
 *
 * These concentrate on the shapes a real WHOOP account actually produces —
 * unscored nights, an open cycle, a strap with no blood-oxygen sensor — rather
 * than on the fully-populated shape that is easiest to imagine. Every one of
 * these would have passed trivially against a hand-made "ideal" record, which
 * is exactly the class of test that lets a real account break a connector on
 * its first run.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
	buildCoverageRecord,
	buildCycleRecord,
	buildRecoveryRecord,
	buildRespiratoryRateRecord,
	buildSleepRecord,
} from "./parsers.ts";
import type { WhoopCycle, WhoopRecovery, WhoopSleep } from "./types.ts";

const COLLECTED_AT = "2026-09-19T06:00:00.000Z";

const SCORED_SLEEP: WhoopSleep = {
	id: "ecfc6a15-4661-442f-a9a4-f160dd7afae8",
	cycle_id: 93_845,
	user_id: 10_129,
	created_at: "2026-09-19T06:25:00.000Z",
	updated_at: "2026-09-19T06:40:00.000Z",
	start: "2026-09-18T22:41:00.000Z",
	end: "2026-09-19T06:22:00.000Z",
	timezone_offset: "+10:00",
	nap: false,
	score_state: "SCORED",
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
			need_from_sleep_debt_milli: 1_200_000,
			need_from_recent_strain_milli: 600_000,
			need_from_recent_nap_milli: 0,
		},
		respiratory_rate: 14.7,
		sleep_performance_percentage: 92.5,
		sleep_consistency_percentage: 71,
		sleep_efficiency_percentage: 95.2,
	},
};

/** Last night, before WHOOP has scored it. `score` is absent entirely. */
const PENDING_SLEEP: WhoopSleep = {
	id: "b2f1a7c4-1111-4c2e-9d3a-6f8e2b4c1d55",
	cycle_id: 93_846,
	user_id: 10_129,
	created_at: "2026-09-19T06:30:00.000Z",
	updated_at: "2026-09-19T06:30:00.000Z",
	start: "2026-09-19T22:55:00.000Z",
	end: "2026-09-20T06:05:00.000Z",
	timezone_offset: "+10:00",
	nap: false,
	score_state: "PENDING_SCORE",
};

test("an unscored sleep yields nulls, never zeroes", () => {
	const record = buildSleepRecord(PENDING_SLEEP, COLLECTED_AT);
	// Zero would be a measurement. Null is the absence of one, and a reader
	// charting "0 minutes of REM" for every recent night would be reading a
	// fabrication.
	assert.equal(record.total_rem_sleep_time_milli, null);
	assert.equal(record.total_in_bed_time_milli, null);
	assert.equal(record.disturbance_count, null);
	assert.equal(record.sleep_performance_percentage, null);
	assert.equal(record.score_state, "PENDING_SCORE");
});

test("a real zero survives as a zero", () => {
	// The other half of the same rule: total_no_data_time_milli is genuinely 0
	// on a well-recorded night and must not be flattened to null.
	const record = buildSleepRecord(SCORED_SLEEP, COLLECTED_AT);
	assert.equal(record.total_no_data_time_milli, 0);
	assert.equal(record.sleep_needed_from_recent_nap_milli, 0);
});

test("the sleep record carries no respiratory rate and no user id", () => {
	const record = buildSleepRecord(SCORED_SLEEP, COLLECTED_AT);
	assert.equal("respiratory_rate" in record, false);
	assert.equal("user_id" in record, false);
	assert.equal("v1_id" in record, false);
});

test("provenance separates WHOOP's update time from the collection time", () => {
	const record = buildSleepRecord(SCORED_SLEEP, COLLECTED_AT);
	assert.equal(record.collected_at, COLLECTED_AT);
	assert.equal(record.updated_at, "2026-09-19T06:40:00.000Z");
	assert.equal(record.source, "whoop_api_v2");
});

test("a sleep with no measured breathing rate yields NO respiratory record", () => {
	// Not a record with a null rate: this stream exists so a reader can ask for
	// breathing alone, and a row of nulls would be indistinguishable from a
	// strap that never measures it.
	assert.equal(buildRespiratoryRateRecord(PENDING_SLEEP, COLLECTED_AT), null);
});

test("a measured breathing rate yields a record joinable back to the sleep", () => {
	const record = buildRespiratoryRateRecord(SCORED_SLEEP, COLLECTED_AT);
	assert.ok(record);
	assert.equal(record.respiratory_rate, 14.7);
	assert.equal(record.sleep_id, SCORED_SLEEP.id);
	assert.equal(record.cycle_id, SCORED_SLEEP.cycle_id);
});

test("an unknown score_state passes through untouched", () => {
	// Vocabulary drift is the runtime's to classify, not ours to erase.
	const drifted = {
		...PENDING_SLEEP,
		score_state: "RESCORING",
	} as unknown as WhoopSleep;
	assert.equal(
		buildSleepRecord(drifted, COLLECTED_AT).score_state,
		"RESCORING",
	);
});

test("a missing score_state falls back to UNSCORABLE", () => {
	const broken = { ...PENDING_SLEEP, score_state: undefined } as never;
	assert.equal(
		buildSleepRecord(broken, COLLECTED_AT).score_state,
		"UNSCORABLE",
	);
});

test("a non-finite measurement becomes null rather than reaching a reader", () => {
	const odd = {
		...SCORED_SLEEP,
		score: {
			...SCORED_SLEEP.score,
			sleep_performance_percentage: Number.NaN,
		},
	} as WhoopSleep;
	assert.equal(
		buildSleepRecord(odd, COLLECTED_AT).sleep_performance_percentage,
		null,
	);
});

test("the open cycle keeps a null end rather than inventing one", () => {
	const open: WhoopCycle = {
		id: 93_846,
		user_id: 10_129,
		created_at: "2026-09-19T06:22:00.000Z",
		updated_at: "2026-09-19T06:22:00.000Z",
		start: "2026-09-19T06:22:00.000Z",
		timezone_offset: "+10:00",
		score_state: "PENDING_SCORE",
	};
	const record = buildCycleRecord(open, COLLECTED_AT);
	assert.equal(record.end, null);
	assert.equal(record.strain, null);
});

test("an empty-string end is treated as absent", () => {
	const odd = {
		id: 1,
		user_id: 1,
		created_at: "2026-09-19T06:22:00.000Z",
		updated_at: "2026-09-19T06:22:00.000Z",
		start: "2026-09-19T06:22:00.000Z",
		end: "",
		timezone_offset: "+10:00",
		score_state: "SCORED",
		score: {
			strain: 11.2,
			kilojoule: 9_400,
			average_heart_rate: 68,
			max_heart_rate: 151,
		},
	} as WhoopCycle;
	assert.equal(buildCycleRecord(odd, COLLECTED_AT).end, null);
});

test("a strap without the optional sensors yields nulls for them", () => {
	const recovery: WhoopRecovery = {
		cycle_id: 93_845,
		sleep_id: SCORED_SLEEP.id,
		user_id: 10_129,
		created_at: "2026-09-19T06:22:00.000Z",
		updated_at: "2026-09-19T06:40:00.000Z",
		score_state: "SCORED",
		score: {
			user_calibrating: false,
			recovery_score: 67,
			resting_heart_rate: 51,
			hrv_rmssd_milli: 64.3,
		},
	};
	const record = buildRecoveryRecord(recovery, COLLECTED_AT);
	assert.equal(record.spo2_percentage, null);
	assert.equal(record.skin_temp_celsius, null);
	assert.equal(record.recovery_score, 67);
	assert.equal(record.user_calibrating, false);
});

test("a calibrating recovery keeps the flag rather than dropping the scores", () => {
	const recovery: WhoopRecovery = {
		cycle_id: 1,
		sleep_id: SCORED_SLEEP.id,
		user_id: 1,
		created_at: "2026-09-19T06:22:00.000Z",
		updated_at: "2026-09-19T06:22:00.000Z",
		score_state: "SCORED",
		score: {
			user_calibrating: true,
			recovery_score: 44,
			resting_heart_rate: 58,
			hrv_rmssd_milli: 31.2,
		},
	};
	const record = buildRecoveryRecord(recovery, COLLECTED_AT);
	assert.equal(record.user_calibrating, true);
	assert.equal(record.recovery_score, 44);
});

test("an unscored recovery has a null calibrating flag, not false", () => {
	// `false` would assert that WHOOP has finished calibrating this owner, which
	// is a claim no unscored record supports.
	const recovery: WhoopRecovery = {
		cycle_id: 2,
		sleep_id: SCORED_SLEEP.id,
		user_id: 1,
		created_at: "2026-09-19T06:22:00.000Z",
		updated_at: "2026-09-19T06:22:00.000Z",
		score_state: "PENDING_SCORE",
	};
	assert.equal(
		buildRecoveryRecord(recovery, COLLECTED_AT).user_calibrating,
		null,
	);
});

test("a coverage receipt is keyed per stream per run and sorts its gaps", () => {
	const record = buildCoverageRecord({
		stream: "recovery",
		status: "partial",
		reason: "awaiting_score",
		recordCount: 31,
		recordsPendingScore: 1,
		recordsUnscorable: 2,
		fieldsUnavailable: ["skin_temp_celsius", "spo2_percentage"],
		windowRequestedFrom: "2026-08-12T00:00:00.000Z",
		windowRequestedTo: null,
		windowCoveredFrom: "2026-08-12T22:10:00.000Z",
		windowCoveredTo: "2026-09-18T22:41:00.000Z",
		collectedAt: COLLECTED_AT,
	});
	assert.equal(record.id, `recovery:${COLLECTED_AT}`);
	assert.deepEqual(record.fields_unavailable, [
		"skin_temp_celsius",
		"spo2_percentage",
	]);
	assert.equal(record.records_pending_score, 1);
	assert.equal(record.records_unscorable, 2);
});
