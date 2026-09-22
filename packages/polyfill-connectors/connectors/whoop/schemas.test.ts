// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Schema tests for the WHOOP connector.
 *
 * Three jobs. First, assert the Zod schemas against records shaped exactly as
 * parsers.ts emits them — including the unscored shapes, which are the ones a
 * real account produces on its first run. Second, assert PARITY between the
 * Zod schemas and the hand-written JSON Schema in manifests/whoop.json:
 * nothing in the toolchain keeps those in sync, and the JSON Schema is the
 * published contract a reading application integrates against, so a field in
 * one and not the other is a promise broken on one side or a leak opened on
 * the other. Third, assert the privacy exclusions, so that restoring one is a
 * red test rather than a quiet change.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { z } from "zod";
import { RUNTIME_GENERIC_REASON_CODES } from "../../src/reference-implementation-stand-in/runtime/recovery-reason-codes.ts";
import {
	COVERAGE_REASONS,
	coverageDiagnosticsSchema,
	cyclesSchema,
	recoverySchema,
	respiratoryRateSchema,
	SCHEMAS,
	sleepSchema,
	validateRecord,
} from "./schemas.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = join(HERE, "..", "..", "manifests", "whoop.json");

interface ManifestStream {
	name: string;
	required: boolean;
	cursor_field?: string;
	schema: {
		properties: Record<string, { type?: unknown; enum?: string[] }>;
		required?: string[];
	};
}

interface Manifest {
	streams: ManifestStream[];
	reason_display_messages: Record<string, string>;
	capabilities: { auth: { scopes: string[] } };
}

function manifest(): Manifest {
	return JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as Manifest;
}

function stream(name: string): ManifestStream {
	const found = manifest().streams.find((entry) => entry.name === name);
	assert.ok(found, `manifest must declare the ${name} stream`);
	return found;
}

function zodKeys(schema: z.ZodTypeAny): string[] {
	const shape = (schema as unknown as { shape: Record<string, unknown> }).shape;
	return Object.keys(shape).sort();
}

function manifestKeys(name: string): string[] {
	return Object.keys(stream(name).schema.properties).sort();
}

// ─── Records shaped exactly as parsers.ts emits them ────────────────────────

const PROVENANCE = {
	source: "whoop_api_v2" as const,
	freshness: "live" as const,
	collected_at: "2026-09-19T06:00:00.000Z",
	updated_at: "2026-09-19T05:12:00.000Z",
};

const SLEEP_SCORED = {
	id: "ecfc6a15-4661-442f-a9a4-f160dd7afae8",
	cycle_id: 93845,
	start: "2026-09-18T22:41:00.000Z",
	end: "2026-09-19T06:22:00.000Z",
	timezone_offset: "+10:00",
	nap: false,
	score_state: "SCORED" as const,
	total_in_bed_time_milli: 27_660_000,
	total_awake_time_milli: 1_320_000,
	total_no_data_time_milli: 0,
	total_light_sleep_time_milli: 13_500_000,
	total_slow_wave_sleep_time_milli: 6_600_000,
	total_rem_sleep_time_milli: 6_240_000,
	sleep_cycle_count: 5,
	disturbance_count: 7,
	sleep_needed_baseline_milli: 27_000_000,
	sleep_needed_from_sleep_debt_milli: 1_200_000,
	sleep_needed_from_recent_strain_milli: 600_000,
	sleep_needed_from_recent_nap_milli: 0,
	sleep_performance_percentage: 92.5,
	sleep_consistency_percentage: 71,
	sleep_efficiency_percentage: 95.2,
	...PROVENANCE,
};

/** What WHOOP actually returns for last night, before it has scored it. */
const SLEEP_PENDING = {
	...SLEEP_SCORED,
	score_state: "PENDING_SCORE" as const,
	total_in_bed_time_milli: null,
	total_awake_time_milli: null,
	total_no_data_time_milli: null,
	total_light_sleep_time_milli: null,
	total_slow_wave_sleep_time_milli: null,
	total_rem_sleep_time_milli: null,
	sleep_cycle_count: null,
	disturbance_count: null,
	sleep_needed_baseline_milli: null,
	sleep_needed_from_sleep_debt_milli: null,
	sleep_needed_from_recent_strain_milli: null,
	sleep_needed_from_recent_nap_milli: null,
	sleep_performance_percentage: null,
	sleep_consistency_percentage: null,
	sleep_efficiency_percentage: null,
};

const RESPIRATORY_RATE = {
	sleep_id: "ecfc6a15-4661-442f-a9a4-f160dd7afae8",
	cycle_id: 93_845,
	start: "2026-09-18T22:41:00.000Z",
	end: "2026-09-19T06:22:00.000Z",
	timezone_offset: "+10:00",
	nap: false,
	respiratory_rate: 14.7,
	score_state: "SCORED" as const,
	...PROVENANCE,
};

const RECOVERY = {
	cycle_id: 93_845,
	sleep_id: "ecfc6a15-4661-442f-a9a4-f160dd7afae8",
	created_at: "2026-09-19T06:22:00.000Z",
	score_state: "SCORED" as const,
	user_calibrating: false,
	recovery_score: 67,
	resting_heart_rate: 51,
	hrv_rmssd_milli: 64.3,
	spo2_percentage: 96.1,
	skin_temp_celsius: 33.4,
	...PROVENANCE,
};

const CYCLE = {
	id: 93_845,
	start: "2026-09-19T06:22:00.000Z",
	end: null,
	timezone_offset: "+10:00",
	score_state: "PENDING_SCORE" as const,
	strain: null,
	kilojoule: null,
	average_heart_rate: null,
	max_heart_rate: null,
	...PROVENANCE,
};

const DIAGNOSTIC = {
	id: "sleep:2026-09-19T06:00:00.000Z",
	stream: "sleep",
	status: "partial" as const,
	reason: "awaiting_score" as const,
	record_count: 31,
	records_pending_score: 1,
	records_unscorable: 2,
	fields_unavailable: ["spo2_percentage"],
	window_requested_from: "2026-08-12T00:00:00.000Z",
	window_requested_to: null,
	window_covered_from: "2026-08-12T22:10:00.000Z",
	window_covered_to: "2026-09-18T22:41:00.000Z",
	source: "whoop_api_v2" as const,
	freshness: "live" as const,
	collected_at: "2026-09-19T06:00:00.000Z",
};

// ─── Shape checks ───────────────────────────────────────────────────────────

test("a fully scored sleep validates", () => {
	assert.equal(sleepSchema.safeParse(SLEEP_SCORED).success, true);
});

test("an UNSCORED sleep validates with every measurement null", () => {
	// The case that matters: WHOOP returns this for last night on every real
	// account. A schema that required the measurements would reject the most
	// recent record on the very first run against a live account.
	const result = sleepSchema.safeParse(SLEEP_PENDING);
	assert.equal(
		result.success,
		true,
		`a PENDING_SCORE sleep must validate: ${JSON.stringify(result.error?.issues)}`,
	);
});

test("an unscored cycle validates with a null end and null strain", () => {
	// The day in progress: WHOOP has neither closed nor scored it.
	assert.equal(cyclesSchema.safeParse(CYCLE).success, true);
});

test("respiratory rate and recovery validate", () => {
	assert.equal(respiratoryRateSchema.safeParse(RESPIRATORY_RATE).success, true);
	assert.equal(recoverySchema.safeParse(RECOVERY).success, true);
});

test("a diagnostic validates", () => {
	assert.equal(coverageDiagnosticsSchema.safeParse(DIAGNOSTIC).success, true);
});

test("validateRecord rejects a respiratory rate with no measurement", () => {
	// Guards the design decision in parsers.ts: a night WHOOP measured no
	// breathing rate for produces NO record, never a record with a null rate.
	// A null here would be indistinguishable from "this strap never measures
	// breathing", which is a different fact with a different remedy.
	const result = validateRecord("respiratory_rate", {
		...RESPIRATORY_RATE,
		respiratory_rate: null,
	});
	assert.equal(result.ok, false);
});

test("validateRecord rejects a timezone offset that is not ±HH:MM", () => {
	const result = validateRecord("sleep", {
		...SLEEP_SCORED,
		timezone_offset: "AEST",
	});
	assert.equal(result.ok, false);
});

test("an unknown score_state is RETAINED as vocabulary drift, not dropped", () => {
	// The runtime distinguishes a malformed record from a source that has added
	// an unrecognised value: enum drift keeps the record, preserves the
	// unknown value verbatim, and reports an anomaly. This is why parsers.ts
	// passes score_state through instead of folding it to UNSCORABLE — doing so
	// would destroy the evidence that WHOOP changed its vocabulary.
	const result = validateRecord("sleep", {
		...SLEEP_SCORED,
		score_state: "PARTIALLY_SCORED",
	});
	assert.equal(result.ok, true, "drift must not drop the record");
	assert.equal(
		(result as unknown as { data: Record<string, unknown> }).data.score_state,
		"PARTIALLY_SCORED",
		"the unrecognised value must survive exactly as WHOOP sent it",
	);
	const anomalies = (
		result as unknown as { anomalies?: readonly { path: string }[] }
	).anomalies;
	assert.deepEqual(
		anomalies?.map((entry: { path: string }) => entry.path),
		["score_state"],
		"drift must be reported as an anomaly an operator can act on",
	);
});

test("a genuinely malformed record is still rejected alongside drift", () => {
	// The guard that stops drift-retention becoming a way to smuggle bad data:
	// one real fault alongside the drift must still fail the record.
	const result = validateRecord("sleep", {
		...SLEEP_SCORED,
		score_state: "PARTIALLY_SCORED",
		timezone_offset: "AEST",
	});
	assert.equal(result.ok, false);
});

// ─── Parity with the published JSON Schema ──────────────────────────────────

test("every Zod schema has exactly the manifest's properties", () => {
	const pairs: Array<[string, z.ZodTypeAny]> = [
		["sleep", sleepSchema],
		["respiratory_rate", respiratoryRateSchema],
		["recovery", recoverySchema],
		["cycles", cyclesSchema],
		["coverage_diagnostics", coverageDiagnosticsSchema],
	];
	for (const [name, schema] of pairs) {
		assert.deepEqual(
			zodKeys(schema),
			manifestKeys(name),
			`${name}: Zod fields and manifest schema properties must match exactly`,
		);
	}
});

test("SCHEMAS covers exactly the manifest's streams", () => {
	assert.deepEqual(
		Object.keys(SCHEMAS).sort(),
		manifest()
			.streams.map((entry) => entry.name)
			.sort(),
	);
});

test("each manifest cursor_field is a type the server can order on", () => {
	// A plain-string cursor passes every in-repo test and then fails at install
	// with a 400 from the reference server's records path. Strava shipped that
	// bug and had to move its cursor after merge.
	for (const entry of manifest().streams) {
		if (!entry.cursor_field) {
			continue;
		}
		const property = entry.schema.properties[entry.cursor_field] as
			| { type?: unknown; format?: unknown }
			| undefined;
		assert.ok(
			property,
			`${entry.name}: cursor_field ${entry.cursor_field} must exist in the schema`,
		);
		const types = Array.isArray(property.type)
			? (property.type as string[])
			: [property.type as string];
		const orderable =
			types.includes("integer") ||
			types.includes("number") ||
			(types.includes("string") &&
				(property.format === "date" || property.format === "date-time"));
		assert.ok(
			orderable,
			`${entry.name}: cursor_field ${entry.cursor_field} must be numeric or a date/date-time string`,
		);
	}
});

test("every coverage reason has an owner-facing message", () => {
	// A reason is covered either by this manifest or by the runtime's own small
	// closed set of generic recovery codes. Redeclaring one of those in a
	// manifest is a failure, not a belt-and-braces win — the runtime owns that
	// copy, and two sources of wording for one code drift apart.
	const messages = manifest().reason_display_messages;
	for (const reason of COVERAGE_REASONS) {
		const ours = Boolean(messages[reason]);
		const runtimes = RUNTIME_GENERIC_REASON_CODES.has(reason);
		assert.ok(
			ours || runtimes,
			`${reason} has no display copy in this manifest and is not an RI-generic code`,
		);
		assert.ok(
			!(ours && runtimes),
			`${reason} is an RI-generic code; this manifest must not redeclare it`,
		);
	}
});

test("awaiting_score and unscorable say different things to the owner", () => {
	// These two are the pair this source specifically needs to tell apart: one
	// resolves itself within hours, the other never resolves. Identical copy
	// would tell an owner to wait for data that is never coming.
	const messages = manifest().reason_display_messages;
	assert.notEqual(messages.awaiting_score, messages.unscorable_records_skipped);
});

test("the manifest's reason enum is exactly the code's vocabulary", () => {
	const declared = stream("coverage_diagnostics").schema.properties.reason
		?.enum;
	assert.deepEqual([...(declared ?? [])].sort(), [...COVERAGE_REASONS].sort());
});

// ─── Privacy exclusions, asserted rather than documented ────────────────────

test("no stream carries the owner's name, email or WHOOP user id", () => {
	// read:profile IS requested — the platform's OAuth adapter resolves account
	// identity by reading id or email from a userinfo endpoint, and WHOOP's
	// profile endpoint is the only one that returns either. That is a setup-time
	// use by the host. If a profile field ever reaches a record, this fails.
	const forbidden = [
		"email",
		"first_name",
		"last_name",
		"user_id",
		"name",
		"v1_id",
	];
	for (const entry of manifest().streams) {
		for (const field of forbidden) {
			assert.ok(
				!(field in entry.schema.properties),
				`${entry.name} must not carry ${field}`,
			);
		}
	}
});

test("the sleep stream does not carry respiratory rate", () => {
	// The split is what lets a reader ask for breathing without asking for sleep
	// staging. Folding it back into sleep would silently remove that choice.
	assert.ok(!("respiratory_rate" in stream("sleep").schema.properties));
	assert.ok("respiratory_rate" in stream("respiratory_rate").schema.properties);
});

test("only the scopes the streams need are requested", () => {
	// read:workout and read:body_measurement are absent by design: the data is
	// not merely unmapped, it is unreachable with this connector's token.
	const scopes = manifest().capabilities.auth.scopes;
	assert.deepEqual([...scopes].sort(), [
		"offline",
		"read:cycles",
		"read:profile",
		"read:recovery",
		"read:sleep",
	]);
});
