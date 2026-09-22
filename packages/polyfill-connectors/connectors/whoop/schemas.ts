// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Zod schemas for WHOOP stream records, collected from WHOOP's **public
 * developer API** (v2). Shape-check-before-emit: the runtime runs
 * `validateRecord` on every `emitRecord`.
 *
 * Ground truth for the emitted shape is the record builder in parsers.ts, and
 * these schemas mirror it field for field. They must also reconcile with the
 * hand-written JSON Schema in manifests/whoop.json — nothing keeps the two in
 * sync automatically, so schemas.test.ts asserts the parity.
 *
 * ---------------------------------------------------------------------------
 * What is deliberately ABSENT, and why absence is the enforcement
 * ---------------------------------------------------------------------------
 *
 *   - **The owner's name and email.** WHOOP exposes them at
 *     `/v2/user/profile/basic`, and this connector requests the `read:profile`
 *     scope — but it emits no profile record and no stream carries either
 *     field. The scope is held for ONE setup-time purpose: the platform's
 *     generic OAuth adapter resolves a provider account by calling a manifest-
 *     declared `userinfo_url` and reading `id` or `email` from it, and
 *     `/v2/user/profile/basic` is the only WHOOP endpoint that returns either.
 *     Identity is established once, at connect time, by the host. It is never
 *     collected. This is why the requested scope list is wider than the
 *     stream list.
 *
 *   - **Workouts.** The `read:workout` scope is not requested at all, so the
 *     data is not merely unmapped, it is unreachable with this connector's
 *     token. A workout record carries sport type, start time and duration, and
 *     several months of them describe a routine rather than an activity: which
 *     evenings the owner is out, which mornings they are not home. This
 *     connector collects sleep, respiratory rate, recovery and strain, and
 *     a workout is none of those.
 *
 *   - **Body measurements.** `read:body_measurement` is likewise not
 *     requested. Height, weight and max heart rate are facts about a body
 *     rather than about a night's sleep, and nothing here needs them.
 *
 *   - **WHOOP's numeric `user_id`.** It is on every upstream record and is on
 *     none of ours. It is constant across every record of one account, so it
 *     adds no per-record information, and it is a stable cross-service
 *     correlator if a record ever travels beyond the owner's own server. The
 *     Personal Server already knows which connection a record arrived on.
 *
 *   - **`v1_id`.** A legacy identifier from the retired v1 API. No reader can
 *     do anything with it.
 *
 * `timezone_offset` is KEPT, and that is a decision rather than an oversight.
 * WHOOP timestamps every record in UTC, so without the offset "you fell asleep
 * at 23:10" cannot be recovered from the data at all — and for sleep, the
 * clock time IS the content. The residual is real and worth stating: a run of
 * offsets reveals when the owner changed timezone, and therefore roughly when
 * they travelled. It does not localise them within a band of longitudes, which
 * is the distinction from a coordinate.
 *
 * Respiratory rate is split into its OWN stream rather than carried on the
 * sleep record. Because PDPP stream names are consent scopes, that split is
 * what lets a reading application obtain respiratory rate without also
 * obtaining sleep staging, disturbance counts and sleep-debt figures. It also
 * makes breathing independently obtainable, rather than reachable only by
 * taking a whole sleep record. A consumer that asks for `sleep` does not
 * receive respiratory rate, by construction.
 */

import { z } from "zod";
import { makeValidateRecord } from "../../src/schema-registry.ts";

// Module-scoped regexes (Biome useTopLevelRegex).
const ISO_DT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
/** WHOOP renders the offset as "+01:00" / "-05:00" / "+00:00". */
const TZ_OFFSET_RE = /^[+-]\d{2}:\d{2}$/;
const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isoDateTime = z.string().regex(ISO_DT_RE, "must be an ISO-8601 datetime");

/**
 * Every score field is nullable, and that is load-bearing rather than
 * defensive. WHOOP returns `score_state` on each record and omits the whole
 * `score` object unless it is `SCORED` — the most recent night is routinely
 * `PENDING_SCORE`, and any night the strap was off is `UNSCORABLE`. A schema
 * that required these would reject real data on the first run against a real
 * account: a schema built around the shape a source is assumed to return
 * rejects every record when the assumption is wrong.
 *
 * Absent is mapped to null and never to 0: a resting heart rate of 0 is not a
 * measurement, and a strain of 0 is a real value that a genuinely restful day
 * can produce.
 */
const metric = z.number().nullable();
const metricInt = z.number().int().nullable();

/** Why a record has no score, straight from WHOOP. */
export const SCORE_STATES = ["SCORED", "PENDING_SCORE", "UNSCORABLE"] as const;

/** How a reading was collected. An API read is always live. */
export const FRESHNESS_VALUES = ["live", "snapshot"] as const;

/**
 * Why a covered window ends where it does. Closed, and always populated —
 * including on success, via `covered_in_full`. A nullable reason would invite
 * `if (reason)` as the failure test, which would render "you didn't wear the
 * strap last week" as something going wrong.
 *
 * Next-action shaped rather than cause shaped: each value ends in a different
 * sentence to the owner, and each has a `reason_display_messages` entry in the
 * manifest carrying that sentence.
 *
 * The pair this source specifically needs is `awaiting_score` and
 * `unscorable_records_skipped`. Both mean "a record arrived without a score",
 * and their next actions are opposites: the first resolves itself within hours
 * and the record will be collected again once WHOOP scores it, the second
 * never will and there is nothing to wait for. Collapsing them into one
 * "incomplete" would tell an owner to wait for data that is never coming.
 */
export const COVERAGE_REASONS = [
	"covered_in_full",
	"nothing_in_range",
	"awaiting_score",
	"unscorable_records_skipped",
	"page_budget_reached",
	"rate_limited",
	"authorization_expired",
	"collection_interrupted",
	"window_unavailable",
] as const;

export const COVERAGE_STATUSES = ["complete", "partial", "empty"] as const;

/**
 * Provenance travels in the payload, not only in the manifest — a reading
 * application holds records, not a manifest. `collected_at` is when this run
 * read the record; `updated_at` is WHOOP's own last-modified stamp, and the
 * two differ whenever a record was rescored after it was first collected.
 */
const provenance = {
	source: z.literal("whoop_api_v2"),
	freshness: z.enum(FRESHNESS_VALUES),
	collected_at: isoDateTime,
	updated_at: isoDateTime,
};

/**
 * sleep stream: one record per sleep or nap.
 *
 * Cursor: `start`. Primary key: `id`, WHOOP's own sleep UUID, stable across
 * runs — which is what lets the deliberate re-read window (see index.ts)
 * collapse onto the same record instead of duplicating it.
 *
 * Carries no respiratory rate: see the module note.
 */
export const sleepSchema = z.object({
	id: z.string().regex(UUID_RE, "id must be a WHOOP sleep UUID"),
	cycle_id: z.number().int(),
	start: isoDateTime,
	end: isoDateTime,
	timezone_offset: z.string().regex(TZ_OFFSET_RE, "must be ±HH:MM"),
	nap: z.boolean(),
	score_state: z.enum(SCORE_STATES),
	total_in_bed_time_milli: metricInt,
	total_awake_time_milli: metricInt,
	total_no_data_time_milli: metricInt,
	total_light_sleep_time_milli: metricInt,
	total_slow_wave_sleep_time_milli: metricInt,
	total_rem_sleep_time_milli: metricInt,
	sleep_cycle_count: metricInt,
	disturbance_count: metricInt,
	sleep_needed_baseline_milli: metricInt,
	sleep_needed_from_sleep_debt_milli: metricInt,
	sleep_needed_from_recent_strain_milli: metricInt,
	sleep_needed_from_recent_nap_milli: metricInt,
	sleep_performance_percentage: metric,
	sleep_consistency_percentage: metric,
	sleep_efficiency_percentage: metric,
	...provenance,
});

/**
 * respiratory_rate stream: one record per sleep that WHOOP measured a
 * respiratory rate for.
 *
 * Deliberately narrow. It carries the measurement, the window it was measured
 * over, and the keys needed to join it back to a sleep — and nothing else, so
 * that asking for it is not a way of asking for sleep staging. Records whose
 * score is absent or whose `respiratory_rate` is null are not emitted here at
 * all: a row of nulls in this stream would be indistinguishable from "this
 * owner's strap never measures breathing".
 */
export const respiratoryRateSchema = z.object({
	sleep_id: z.string().regex(UUID_RE, "sleep_id must be a WHOOP sleep UUID"),
	cycle_id: z.number().int(),
	start: isoDateTime,
	end: isoDateTime,
	timezone_offset: z.string().regex(TZ_OFFSET_RE, "must be ±HH:MM"),
	nap: z.boolean(),
	/** Breaths per minute, as WHOOP reports it. */
	respiratory_rate: z.number(),
	score_state: z.enum(SCORE_STATES),
	...provenance,
});

/**
 * recovery stream: one record per physiological cycle WHOOP produced a
 * recovery for.
 *
 * Primary key is `cycle_id`: a recovery has no id of its own upstream, and
 * there is exactly one per cycle. Cursor: `created_at`, which is the only
 * date-time WHOOP's recovery collection orders and filters on.
 */
export const recoverySchema = z.object({
	cycle_id: z.number().int(),
	sleep_id: z.string().regex(UUID_RE, "sleep_id must be a WHOOP sleep UUID"),
	created_at: isoDateTime,
	score_state: z.enum(SCORE_STATES),
	/**
	 * True while WHOOP is still establishing this owner's baseline. The scores
	 * on a calibrating record are real numbers that do not yet mean what they
	 * will later, so a reader that charts them without this flag will show a
	 * trend that is an artefact of calibration.
	 */
	user_calibrating: z.boolean().nullable(),
	recovery_score: metric,
	resting_heart_rate: metric,
	hrv_rmssd_milli: metric,
	spo2_percentage: metric,
	skin_temp_celsius: metric,
	...provenance,
});

/**
 * cycles stream: one record per physiological cycle — WHOOP's "day", which
 * begins when the owner wakes rather than at midnight.
 *
 * Day strain is the headline figure on a cycle. This stream is named for the
 * resource rather than for that one field because the
 * record also carries energy expenditure and heart rate, and naming a record
 * after one of its four measures would misdescribe what a consumer receives.
 *
 * `end` is nullable because the current cycle is still open — WHOOP omits the
 * end of a day the owner is still living.
 */
export const cyclesSchema = z.object({
	id: z.number().int(),
	start: isoDateTime,
	end: isoDateTime.nullable(),
	timezone_offset: z.string().regex(TZ_OFFSET_RE, "must be ±HH:MM"),
	score_state: z.enum(SCORE_STATES),
	strain: metric,
	kilojoule: metric,
	average_heart_rate: metricInt,
	max_heart_rate: metricInt,
	...provenance,
});

/**
 * coverage_diagnostics stream: one record per stream per run, stating what was
 * covered and why it stops there.
 *
 * A separate stream rather than fields on each record, and the reason decides
 * it on correctness rather than taste: when nothing is collected there are no
 * records, so there would be nowhere for the diagnostic to live — and that is
 * exactly the case where "WHOOP had nothing in this period" and "collection
 * broke partway" must be told apart, because their next actions are opposite.
 *
 * `records_pending_score` and `records_unscorable` are counted separately for
 * the same reason the reasons are separate: one resolves itself, the other
 * never does.
 */
export const coverageDiagnosticsSchema = z.object({
	id: z.string().min(1).max(200),
	stream: z.string().min(1).max(64),
	status: z.enum(COVERAGE_STATUSES),
	reason: z.enum(COVERAGE_REASONS),
	record_count: z.number().int().min(0),
	records_pending_score: z.number().int().min(0),
	records_unscorable: z.number().int().min(0),
	/**
	 * Optional measurements this owner's hardware never reported in the covered
	 * window — `spo2_percentage` and `skin_temp_celsius` are absent on older
	 * straps. Without this, a column of nulls is indistinguishable from a
	 * collection fault.
	 */
	fields_unavailable: z.array(z.string().min(1).max(64)).max(32),
	window_requested_from: isoDateTime.nullable(),
	window_requested_to: isoDateTime.nullable(),
	window_covered_from: isoDateTime.nullable(),
	window_covered_to: isoDateTime.nullable(),
	source: z.literal("whoop_api_v2"),
	freshness: z.enum(FRESHNESS_VALUES),
	collected_at: isoDateTime,
});

/** Stream → schema registry. Single source of truth for emitted streams. */
export const SCHEMAS: Record<string, z.ZodTypeAny> = {
	sleep: sleepSchema,
	respiratory_rate: respiratoryRateSchema,
	recovery: recoverySchema,
	cycles: cyclesSchema,
	coverage_diagnostics: coverageDiagnosticsSchema,
};

export const validateRecord = makeValidateRecord(SCHEMAS);
