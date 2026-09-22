// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * WHOOP public developer API v2 — transport, pagination and token acquisition.
 *
 * Everything that touches a WHOOP credential lives in this one module, so the
 * token lifecycle has exactly one home. If the runtime later gains a way to
 * persist a rotated credential (see "Rotation" below), this is the only file
 * that changes.
 *
 * ---------------------------------------------------------------------------
 * Which WHOOP API this is
 * ---------------------------------------------------------------------------
 * The documented, public one, reached with an OAuth 2.0 authorization-code
 * grant. Both the OAuth endpoints and the REST base live on
 * `api.prod.whoop.com`, which is ALSO the host WHOOP's internal application
 * calls. **The hostname does not distinguish the two — the path does.**
 * Documented and used here:
 *
 *     https://api.prod.whoop.com/oauth/oauth2/auth     authorization
 *     https://api.prod.whoop.com/oauth/oauth2/token    token + refresh
 *     https://api.prod.whoop.com/developer/v2/...      REST collections
 *
 * Anything under a different path on that host — `/users-service/...`,
 * `/core-details-bff/...` — is WHOOP's internal API, is not covered by the
 * developer documentation, and is reached with a token lifted from a browser
 * session. This connector previously did exactly that. It no longer does:
 * WHOOP's API Terms of Use §1 require that "Company will only access (or
 * attempt to access) any API by the means described in the documentation of
 * that API", so the documented path is the only one available to it.
 *
 * Anyone auditing this file by grepping for the hostname will reach the wrong
 * conclusion in both directions. Grep the path.
 *
 * ---------------------------------------------------------------------------
 * Credentials
 * ---------------------------------------------------------------------------
 * The client id and secret are deployment configuration, declared in the
 * manifest's `setup.deployment_config` and supplied once by whoever runs the
 * deployment. A member authorising their WHOOP account supplies neither and
 * registers nothing.
 *
 * WHOOP documents no PKCE or public-client option — every documented flow,
 * including the refresh grant below, sends `client_secret`. A deployment with
 * nowhere safe to hold that secret therefore cannot run this connector, which
 * is a property of WHOOP's OAuth implementation rather than a choice made
 * here.
 *
 * ---------------------------------------------------------------------------
 * Rotation — read before changing `acquireAccessToken`
 * ---------------------------------------------------------------------------
 * WHOOP documents its refresh tokens as ROTATING: "the refresh token from the
 * refresh response is now the valid refresh token, and your app must use the
 * new refresh token on the subsequent refresh request." Each refresh consumes
 * the stored token and issues a replacement.
 *
 * A connector cannot persist that replacement: there is no protocol message
 * that writes a credential back, and the host's run-credential resolver is
 * read-only, with the interactive authorization routes the only code paths
 * that write a credential bundle. A refresh performed here therefore cannot
 * change what the next run is handed.
 *
 * Three things follow, and the first is what keeps a connection alive.
 *
 *  1. **A valid access token is used as-is and no refresh is attempted.** An
 *     unnecessary refresh would consume the stored refresh token for nothing
 *     and break the following run, so the manifest maps `access_token` and
 *     `expires_at` out of the credential bundle alongside `refresh_token` and
 *     the common case costs no refresh at all.
 *  2. **The replacement token is parsed out of the response and returned to
 *     the caller**, so a run can report that the stored credential has been
 *     superseded rather than failing silently on the run after.
 *  3. **An invalid grant is reported as a distinct, non-retryable condition**
 *     so the owner is told to reconnect rather than shown a generic failure.
 *
 * The code follows WHOOP's documented behaviour, which is strict rotation.
 * Some OAuth servers allow a grace period in which the previous refresh token
 * remains valid for a short time; where a provider does, the handling below
 * costs nothing and never triggers.
 */

import type { ConnectorHttpGovernor } from "../../src/connector-http-governor.ts";
import { walkPagesWithCeiling } from "../../src/page-ceiling.ts";
import type { WhoopPage } from "./types.ts";

/** Documented REST base. See the path/hostname note above. */
export const WHOOP_API_BASE = "https://api.prod.whoop.com/developer";
/** Documented token endpoint, used for the refresh grant only. */
export const WHOOP_TOKEN_URL = "https://api.prod.whoop.com/oauth/oauth2/token";

/**
 * WHOOP caps `limit` at 25 on every collection endpoint and silently returns
 * 25 if asked for more. Asking for exactly the documented maximum keeps the
 * request count at its floor: a five-year backfill is roughly 220 requests per
 * stream at this page size, and roughly 5,500 at a page size of one.
 */
export const WHOOP_MAX_PAGE_LIMIT = 25;

/**
 * Refresh this far before the recorded expiry rather than at it. A token that
 * expires mid-run would fail partway through a backfill and lose the pages
 * already paid for; 120s comfortably covers clock skew between the host that
 * recorded `expires_at` and this process.
 */
const EXPIRY_SAFETY_MARGIN_MS = 120_000;

/** Non-retryable: the stored WHOOP authorization is no longer usable. */
export class WhoopAuthorizationExpiredError extends Error {
	constructor(detail: string) {
		super(`whoop_authorization_expired: ${detail}`);
		this.name = "WhoopAuthorizationExpiredError";
	}
}

/** Credentials as the host supplies them to the connector child process. */
export interface WhoopCredentials {
	readonly clientId: string;
	readonly clientSecret: string;
	readonly refreshToken: string;
	/** Present when the bundle still holds a token from authorization time. */
	readonly accessToken: string | null;
	/** Epoch ms, parsed from the bundle's `expires_at`; null when unknown. */
	readonly accessTokenExpiresAt: number | null;
}

export interface WhoopAccessToken {
	readonly accessToken: string;
	/** True when this run performed a refresh rather than reusing a token. */
	readonly refreshed: boolean;
	/**
	 * The replacement refresh token WHOOP issued, when it issued one. A
	 * connector cannot persist it, so it is surfaced for the run to report.
	 */
	readonly rotatedRefreshToken: string | null;
}

function requireNonEmpty(value: string | undefined, code: string): string {
	const trimmed = (value ?? "").trim();
	if (!trimmed) {
		throw new Error(code);
	}
	return trimmed;
}

function optionalNonEmpty(value: string | undefined): string | null {
	const trimmed = (value ?? "").trim();
	return trimmed ? trimmed : null;
}

/**
 * Parse the bundle's `expires_at`. The host seals whatever the adapter
 * recorded, which is an epoch-millisecond string in practice but is not
 * guaranteed to be — an unparseable value yields null, which simply means
 * "treat the access token as unusable and refresh", the safe direction.
 */
function parseExpiresAt(value: string | undefined): number | null {
	const trimmed = (value ?? "").trim();
	if (!trimmed) {
		return null;
	}
	const asNumber = Number(trimmed);
	if (Number.isFinite(asNumber) && asNumber > 0) {
		return asNumber;
	}
	const asDate = Date.parse(trimmed);
	return Number.isFinite(asDate) ? asDate : null;
}

/**
 * Read the connection's credentials out of the environment the host composed
 * from the manifest's `connection_config` and `setup.deployment_config`.
 *
 * `WHOOP_ACCESS_TOKEN` and `WHOOP_ACCESS_TOKEN_EXPIRES_AT` are optional by
 * design: a bundle sealed before those fields were declared still yields a
 * working connection, it just always refreshes.
 */
export function resolveWhoopCredentials(
	env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): WhoopCredentials {
	return {
		clientId: requireNonEmpty(
			env.WHOOP_OAUTH_CLIENT_ID,
			"whoop_oauth_client_id_missing",
		),
		clientSecret: requireNonEmpty(
			env.WHOOP_OAUTH_CLIENT_SECRET,
			"whoop_oauth_client_secret_missing",
		),
		refreshToken: requireNonEmpty(
			env.WHOOP_REFRESH_TOKEN,
			"whoop_refresh_token_missing",
		),
		accessToken: optionalNonEmpty(env.WHOOP_ACCESS_TOKEN),
		accessTokenExpiresAt: parseExpiresAt(env.WHOOP_ACCESS_TOKEN_EXPIRES_AT),
	};
}

/** True when the bundle's access token can still carry this run. */
function accessTokenIsUsable(
	credentials: WhoopCredentials,
	nowMs: number,
): boolean {
	if (!credentials.accessToken) {
		return false;
	}
	if (credentials.accessTokenExpiresAt === null) {
		// A token with no recorded expiry cannot be shown to be valid. Refreshing
		// is the safe direction: using a dead token fails the whole run, whereas
		// an unnecessary refresh costs one rotation.
		return false;
	}
	return credentials.accessTokenExpiresAt - EXPIRY_SAFETY_MARGIN_MS > nowMs;
}

interface WhoopTokenResponse {
	access_token?: unknown;
	refresh_token?: unknown;
	expires_in?: unknown;
}

/**
 * Obtain an access token for this run, refreshing only if the stored token
 * cannot carry it. See the module note on rotation for why "only if".
 */
export async function acquireAccessToken(
	credentials: WhoopCredentials,
	options: {
		fetchImpl?: typeof fetch;
		now?: () => number;
	} = {},
): Promise<WhoopAccessToken> {
	const now = options.now ?? Date.now;
	const fetchImpl = options.fetchImpl ?? fetch;

	if (accessTokenIsUsable(credentials, now())) {
		// `accessTokenIsUsable` has already proved this is a non-empty string.
		return {
			accessToken: credentials.accessToken as string,
			refreshed: false,
			rotatedRefreshToken: null,
		};
	}

	// WHOOP documents the refresh grant as form-encoded, and requires `scope`
	// to name `offline` again — without it the response carries no replacement
	// refresh token and the connection becomes single-use.
	const body = new URLSearchParams({
		client_id: credentials.clientId,
		client_secret: credentials.clientSecret,
		grant_type: "refresh_token",
		refresh_token: credentials.refreshToken,
		scope: "offline",
	});

	const response = await fetchImpl(WHOOP_TOKEN_URL, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body,
	});
	const text = await response.text();

	if (!response.ok) {
		// 400 invalid_grant and 401 are both "this authorization is finished".
		// Everything else may be transient and is left retryable.
		if (response.status === 400 || response.status === 401) {
			throw new WhoopAuthorizationExpiredError(
				`token endpoint returned ${String(response.status)}`,
			);
		}
		throw new Error(
			`whoop_token_http_${String(response.status)}: ${text.slice(0, 200)}`,
		);
	}

	let parsed: WhoopTokenResponse;
	try {
		parsed = JSON.parse(text) as WhoopTokenResponse;
	} catch {
		throw new Error("whoop_token_invalid_json");
	}

	const accessToken =
		typeof parsed.access_token === "string" ? parsed.access_token.trim() : "";
	if (!accessToken) {
		throw new Error("whoop_token_access_token_missing");
	}

	// Surfaced for the run to report; see the module note on rotation.
	const rotated =
		typeof parsed.refresh_token === "string" ? parsed.refresh_token.trim() : "";

	return {
		accessToken,
		refreshed: true,
		rotatedRefreshToken:
			rotated && rotated !== credentials.refreshToken ? rotated : null,
	};
}

/** The governor surface this module uses; a test may pass an unpaced stand-in. */
export type WhoopHttpGovernor = Pick<ConnectorHttpGovernor, "request">;

interface RawWhoopResponse {
	body: string;
	retryAfter?: string;
	status: number;
}

/** Query parameters WHOOP's collection endpoints accept. */
export interface WhoopCollectionQuery {
	start?: string;
	end?: string;
	limit?: number;
	nextToken?: string;
}

/**
 * One GET against a WHOOP collection endpoint.
 *
 * Status mapping is deliberately narrow. A 429 throws `whoop_rate_limited`,
 * which the runtime's `retryablePattern` recognises for cross-run deferral; a
 * 401 is an expired authorization and is NOT retryable, because retrying an
 * authorization that WHOOP has finished with only burns rate budget.
 */
export async function fetchWhoopPage<T>(
	governor: WhoopHttpGovernor,
	path: string,
	accessToken: string,
	query: WhoopCollectionQuery,
	fetchImpl: typeof fetch = fetch,
): Promise<WhoopPage<T>> {
	const url = new URL(`${WHOOP_API_BASE}${path}`);
	if (query.start) {
		url.searchParams.set("start", query.start);
	}
	if (query.end) {
		url.searchParams.set("end", query.end);
	}
	if (typeof query.limit === "number") {
		url.searchParams.set("limit", String(query.limit));
	}
	if (query.nextToken) {
		// WHOOP returns `next_token` and accepts `nextToken`. The asymmetry is
		// WHOOP's, not a typo.
		url.searchParams.set("nextToken", query.nextToken);
	}

	const result = await governor.request<RawWhoopResponse, RawWhoopResponse>(
		async (): Promise<RawWhoopResponse> => {
			const res = await fetchImpl(url.toString(), {
				headers: { Authorization: `Bearer ${accessToken}` },
			});
			const retryAfter = res.headers.get("retry-after");
			return {
				body: await res.text(),
				...(retryAfter === null ? {} : { retryAfter }),
				status: res.status,
			};
		},
		(raw) => ({
			status: raw.status,
			headers: { "retry-after": raw.retryAfter },
			value: raw,
		}),
	);

	const raw = result.value;
	if (raw.status === 401 || raw.status === 403) {
		throw new WhoopAuthorizationExpiredError(
			`collection request returned ${String(raw.status)}`,
		);
	}
	if (raw.status < 200 || raw.status >= 300) {
		throw new Error(
			`whoop_http_${String(raw.status)}: ${raw.body.slice(0, 200)}`,
		);
	}
	try {
		return JSON.parse(raw.body) as WhoopPage<T>;
	} catch {
		throw new Error("whoop_invalid_json");
	}
}

export interface WhoopWalkResult<T> {
	rows: T[];
	/** True when the page ceiling stopped the walk with pages still to read. */
	truncated: boolean;
	/**
	 * The continuation token the ceiling stopped on, or null when the walk
	 * reached the end of the collection.
	 *
	 * The caller MUST persist this when it is non-null. Discarding it turns the
	 * page ceiling from a deferral into a permanent stall: the next run would
	 * re-request the identical window from the first page, collect the identical
	 * records, and stop at the identical ceiling, so the deferred tail would
	 * never arrive no matter how many times collection ran.
	 */
	resumeToken: string | null;
}

/**
 * Page one WHOOP collection to exhaustion or to the ceiling.
 *
 * `truncated` is the distinction the caller needs in order to withhold its
 * cursor and disclose the deferred tail: a capped walk and a finished one
 * otherwise return the same rows and would be indistinguishable.
 *
 * The end of a collection is an empty `next_token`, per WHOOP's pagination
 * guide — never a short page. A full-looking page can still be the last one.
 */
export async function walkWhoopCollection<T>(
	governor: WhoopHttpGovernor,
	path: string,
	accessToken: string,
	window: { start?: string; end?: string; resumeToken?: string },
	maxPages: number,
	fetchImpl: typeof fetch = fetch,
): Promise<WhoopWalkResult<T>> {
	const rows: T[] = [];
	// Resuming picks up exactly where the previous run's ceiling stopped. WHOOP's
	// continuation token encodes the query it belongs to, so the caller must pass
	// back the same window alongside it.
	let nextToken: string | undefined = window.resumeToken;

	const walk = await walkPagesWithCeiling({
		maxPages,
		fetchPage: async () => {
			const query: WhoopCollectionQuery = { limit: WHOOP_MAX_PAGE_LIMIT };
			if (window.start) {
				query.start = window.start;
			}
			if (window.end) {
				query.end = window.end;
			}
			if (nextToken) {
				query.nextToken = nextToken;
			}
			const page = await fetchWhoopPage<T>(
				governor,
				path,
				accessToken,
				query,
				fetchImpl,
			);
			if (Array.isArray(page.records)) {
				rows.push(...page.records);
			}
			nextToken = page.next_token || undefined;
			return Boolean(nextToken);
		},
	});

	return {
		rows,
		truncated: walk.truncated,
		// Only meaningful when truncated: a finished walk has no tail to resume.
		resumeToken: walk.truncated ? (nextToken ?? null) : null,
	};
}
