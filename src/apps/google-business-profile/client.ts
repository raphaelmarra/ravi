import { resolveCredentialSecret } from "../../credentials/broker.js";
import { getCredentialConnection } from "../../credentials/store.js";

export interface GoogleBusinessProfileCredential {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export type GbpJson = Record<string, unknown>;

type CredentialResolver = (connection: string) => Promise<GoogleBusinessProfileCredential>;
type ConnectionInspector = (connection: string) => { status?: string } | null;

export interface GoogleBusinessProfileClientOptions {
  connection?: string;
  fetch?: typeof globalThis.fetch;
  /** In-process injection for isolated tests and controlled migrations. */
  credential?: GoogleBusinessProfileCredential;
  /** Test seam proving missing credentials fail before network access. */
  credentialResolver?: CredentialResolver;
  /** Read-only metadata seam used by health(); it never resolves a secret. */
  connectionInspector?: ConnectionInspector;
  /** Protected promotion seam. Phase 1 keeps all provider writes disabled. */
  writesEnabled?: boolean;
}

const ACCOUNT_MANAGEMENT = "https://mybusinessaccountmanagement.googleapis.com/v1";
const BUSINESS_INFORMATION = "https://mybusinessbusinessinformation.googleapis.com/v1";
const PERFORMANCE = "https://businessprofileperformance.googleapis.com/v1";
const VERIFICATIONS = "https://mybusinessverifications.googleapis.com/v1";
const MY_BUSINESS_V4 = "https://mybusiness.googleapis.com/v4";

export class GoogleBusinessProfileClient {
  readonly #connection: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #credential?: GoogleBusinessProfileCredential;
  readonly #credentialResolver: CredentialResolver;
  readonly #connectionInspector: ConnectionInspector;
  readonly #writesEnabled: boolean;
  #accessToken: string | null = null;

  constructor(options: GoogleBusinessProfileClientOptions = {}) {
    this.#connection = options.connection ?? "default";
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#credential = options.credential;
    this.#credentialResolver =
      options.credentialResolver ??
      (async (connection) =>
        parseCredential(
          (
            await resolveCredentialSecret({
              provider: "google-business-profile",
              connection,
              action: "auth.check",
            })
          ).secret,
        ));
    this.#connectionInspector =
      options.connectionInspector ?? ((connection) => getCredentialConnection("google-business-profile", connection));
    this.#writesEnabled = options.writesEnabled === true;
  }

  health() {
    const connection = this.#connectionInspector(this.#connection);
    const credentialConfigured = connection !== null;
    const credentialStatus = connection?.status ?? "missing";
    const ready = credentialConfigured && credentialStatus === "active";
    return {
      ok: true,
      app: "google-business-profile",
      connection: this.#connection,
      ready,
      credentialConfigured,
      credentialStatus,
      authenticated: false,
      externalCheckPerformed: false,
      writesEnabled: this.#writesEnabled,
      message: ready
        ? "Credential metadata is active; authentication was not exercised in source-ready Phase 1."
        : 'No active Google Business Profile credential connection. Configure provider "google-business-profile" before a later authenticated read-only proof.',
    };
  }

  listAccounts(pageSize = 50, pageToken?: string): Promise<GbpJson> {
    return this.request(ACCOUNT_MANAGEMENT, "/accounts", { query: { pageSize, pageToken } });
  }

  getAccount(account: string): Promise<GbpJson> {
    return this.request(ACCOUNT_MANAGEMENT, `/${accountName(account)}`);
  }

  listLocations(account: string, readMask: string, pageSize = 50, pageToken?: string): Promise<GbpJson> {
    return this.request(BUSINESS_INFORMATION, `/${accountName(account)}/locations`, {
      query: { readMask, pageSize, pageToken },
    });
  }

  getLocation(location: string, readMask: string): Promise<GbpJson> {
    return this.request(BUSINESS_INFORMATION, `/${locationName(location)}`, { query: { readMask } });
  }

  updateLocation(location: string, body: GbpJson, updateMask: string): Promise<GbpJson> {
    return this.request(BUSINESS_INFORMATION, `/${locationName(location)}`, {
      method: "PATCH",
      query: { updateMask },
      body,
      mutating: true,
    });
  }

  deleteLocation(location: string): Promise<GbpJson> {
    return this.request(BUSINESS_INFORMATION, `/${locationName(location)}`, { method: "DELETE", mutating: true });
  }

  listReviews(account: string, location: string, pageSize = 50, pageToken?: string): Promise<GbpJson> {
    return this.request(MY_BUSINESS_V4, `/${scopedLocation(account, location)}/reviews`, {
      query: { pageSize, pageToken, orderBy: "updateTime desc" },
    });
  }

  getReview(account: string, location: string, review: string): Promise<GbpJson> {
    return this.request(MY_BUSINESS_V4, `/${childName(scopedLocation(account, location), "reviews", review)}`);
  }

  updateReviewReply(account: string, location: string, review: string, comment: string): Promise<GbpJson> {
    return this.request(MY_BUSINESS_V4, `/${childName(scopedLocation(account, location), "reviews", review)}/reply`, {
      method: "PUT",
      body: { comment },
      mutating: true,
    });
  }

  deleteReviewReply(account: string, location: string, review: string): Promise<GbpJson> {
    return this.request(MY_BUSINESS_V4, `/${childName(scopedLocation(account, location), "reviews", review)}/reply`, {
      method: "DELETE",
      mutating: true,
    });
  }

  listPosts(account: string, location: string, pageSize = 50, pageToken?: string): Promise<GbpJson> {
    return this.request(MY_BUSINESS_V4, `/${scopedLocation(account, location)}/localPosts`, {
      query: { pageSize, pageToken },
    });
  }

  getPost(account: string, location: string, post: string): Promise<GbpJson> {
    return this.request(MY_BUSINESS_V4, `/${childName(scopedLocation(account, location), "localPosts", post)}`);
  }

  createPost(account: string, location: string, body: GbpJson): Promise<GbpJson> {
    return this.request(MY_BUSINESS_V4, `/${scopedLocation(account, location)}/localPosts`, {
      method: "POST",
      body,
      mutating: true,
    });
  }

  updatePost(account: string, location: string, post: string, body: GbpJson, updateMask: string): Promise<GbpJson> {
    return this.request(MY_BUSINESS_V4, `/${childName(scopedLocation(account, location), "localPosts", post)}`, {
      method: "PATCH",
      query: { updateMask },
      body,
      mutating: true,
    });
  }

  deletePost(account: string, location: string, post: string): Promise<GbpJson> {
    return this.request(MY_BUSINESS_V4, `/${childName(scopedLocation(account, location), "localPosts", post)}`, {
      method: "DELETE",
      mutating: true,
    });
  }

  listMedia(account: string, location: string, pageSize = 50, pageToken?: string): Promise<GbpJson> {
    return this.request(MY_BUSINESS_V4, `/${scopedLocation(account, location)}/media`, {
      query: { pageSize, pageToken },
    });
  }

  getMedia(account: string, location: string, media: string): Promise<GbpJson> {
    return this.request(MY_BUSINESS_V4, `/${childName(scopedLocation(account, location), "media", media)}`);
  }

  createMedia(account: string, location: string, body: GbpJson): Promise<GbpJson> {
    return this.request(MY_BUSINESS_V4, `/${scopedLocation(account, location)}/media`, {
      method: "POST",
      body,
      mutating: true,
    });
  }

  updateMedia(account: string, location: string, media: string, body: GbpJson, updateMask: string): Promise<GbpJson> {
    return this.request(MY_BUSINESS_V4, `/${childName(scopedLocation(account, location), "media", media)}`, {
      method: "PATCH",
      query: { updateMask },
      body,
      mutating: true,
    });
  }

  deleteMedia(account: string, location: string, media: string): Promise<GbpJson> {
    return this.request(MY_BUSINESS_V4, `/${childName(scopedLocation(account, location), "media", media)}`, {
      method: "DELETE",
      mutating: true,
    });
  }

  performance(location: string, metrics: string[], startDate: string, endDate: string): Promise<GbpJson> {
    return this.request(PERFORMANCE, `/${locationName(location)}:fetchMultiDailyMetricsTimeSeries`, {
      query: {
        dailyMetrics: metrics,
        "dailyRange.startDate.year": startDate.slice(0, 4),
        "dailyRange.startDate.month": Number(startDate.slice(5, 7)),
        "dailyRange.startDate.day": Number(startDate.slice(8, 10)),
        "dailyRange.endDate.year": endDate.slice(0, 4),
        "dailyRange.endDate.month": Number(endDate.slice(5, 7)),
        "dailyRange.endDate.day": Number(endDate.slice(8, 10)),
      },
    });
  }

  searchKeywords(location: string, startMonth: string, endMonth: string, pageSize = 50, pageToken?: string) {
    return this.request(PERFORMANCE, `/${locationName(location)}/searchkeywords/impressions/monthly`, {
      query: {
        "monthlyRange.startMonth.year": startMonth.slice(0, 4),
        "monthlyRange.startMonth.month": Number(startMonth.slice(5, 7)),
        "monthlyRange.endMonth.year": endMonth.slice(0, 4),
        "monthlyRange.endMonth.month": Number(endMonth.slice(5, 7)),
        pageSize,
        pageToken,
      },
    });
  }

  listCategories(regionCode = "BR", languageCode = "pt-BR", filter?: string, pageSize = 50, pageToken?: string) {
    return this.request(BUSINESS_INFORMATION, "/categories", {
      query: {
        regionCode,
        languageCode,
        filter: filter ? `displayName=${filter}` : undefined,
        view: "FULL",
        pageSize,
        pageToken,
      },
    });
  }

  getAttributes(location: string): Promise<GbpJson> {
    return this.request(BUSINESS_INFORMATION, `/${locationName(location)}/attributes`);
  }

  listVerifications(location: string): Promise<GbpJson> {
    return this.request(VERIFICATIONS, `/${locationName(location)}/verifications`);
  }

  fetchVerificationOptions(location: string, languageCode = "pt-BR"): Promise<GbpJson> {
    return this.request(VERIFICATIONS, `/${locationName(location)}:fetchVerificationOptions`, {
      method: "POST",
      body: { languageCode },
    });
  }

  verify(location: string, method: string, body: GbpJson = {}, languageCode = "pt-BR"): Promise<GbpJson> {
    return this.request(VERIFICATIONS, `/${locationName(location)}:verify`, {
      method: "POST",
      body: { method, languageCode, ...body },
      mutating: true,
    });
  }

  completeVerification(verification: string, pin: string): Promise<GbpJson> {
    return this.request(VERIFICATIONS, `/${verificationName(verification)}:complete`, {
      method: "POST",
      body: { pin },
      mutating: true,
    });
  }

  listAdmins(parent: string): Promise<GbpJson> {
    return this.request(ACCOUNT_MANAGEMENT, `/${parentName(parent)}/admins`);
  }

  createAdmin(parent: string, email: string, role: string): Promise<GbpJson> {
    return this.request(ACCOUNT_MANAGEMENT, `/${parentName(parent)}/admins`, {
      method: "POST",
      body: { admin: email, role },
      mutating: true,
    });
  }

  updateAdmin(admin: string, role: string): Promise<GbpJson> {
    return this.request(ACCOUNT_MANAGEMENT, `/${adminName(admin)}`, {
      method: "PATCH",
      query: { updateMask: "role" },
      body: { name: adminName(admin), role },
      mutating: true,
    });
  }

  deleteAdmin(admin: string): Promise<GbpJson> {
    return this.request(ACCOUNT_MANAGEMENT, `/${adminName(admin)}`, { method: "DELETE", mutating: true });
  }

  private async request(
    base: string,
    path: string,
    options: {
      method?: string;
      query?: Record<string, string | number | string[] | undefined>;
      body?: GbpJson;
      mutating?: boolean;
    } = {},
  ): Promise<GbpJson> {
    if (options.mutating && !this.#writesEnabled) {
      throw new Error(
        "Google Business Profile mutating operations are disabled in source-ready Phase 1; promote writes through HITL before live execution.",
      );
    }
    const token = await this.accessToken();
    const url = new URL(`${base}${path}`);
    for (const [key, raw] of Object.entries(options.query ?? {})) {
      if (raw === undefined) continue;
      for (const value of Array.isArray(raw) ? raw : [raw]) url.searchParams.append(key, String(value));
    }
    const response = await this.#fetch(url, {
      method: options.method ?? "GET",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Google Business Profile request failed (${response.status}): ${redact(text)}`);
    return text ? (JSON.parse(text) as GbpJson) : {};
  }

  private async accessToken(): Promise<string> {
    if (this.#accessToken) return this.#accessToken;
    let credential: GoogleBusinessProfileCredential;
    try {
      credential = this.#credential ?? (await this.#credentialResolver(this.#connection));
    } catch {
      throw new Error(
        `Google Business Profile credential unavailable for connection "${this.#connection}". Configure provider "google-business-profile" before running read-only operations.`,
      );
    }
    const response = await this.#fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: credential.clientId,
        client_secret: credential.clientSecret,
        refresh_token: credential.refreshToken,
        grant_type: "refresh_token",
      }),
    });
    const payload = (await response.json()) as { access_token?: string; error?: string };
    if (!response.ok || !payload.access_token)
      throw new Error(`Google OAuth refresh failed: ${payload.error ?? response.status}`);
    this.#accessToken = payload.access_token;
    return payload.access_token;
  }
}

export function parseCredential(value: string): GoogleBusinessProfileCredential {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Google Business Profile credential must be JSON.");
  }
  if (!parsed || typeof parsed !== "object") throw new Error("Google Business Profile credential must be an object.");
  const record = parsed as Record<string, unknown>;
  for (const field of ["clientId", "clientSecret", "refreshToken"] as const) {
    if (typeof record[field] !== "string" || !record[field])
      throw new Error(`Google Business Profile credential misses ${field}.`);
  }
  return record as unknown as GoogleBusinessProfileCredential;
}

function accountName(value: string): string {
  return value.startsWith("accounts/") ? value : `accounts/${value}`;
}

function locationName(value: string): string {
  if (value.startsWith("locations/")) return value;
  const id = value.includes("/locations/") ? value.split("/locations/").at(-1) : value;
  return `locations/${id}`;
}

function scopedLocation(account: string, location: string): string {
  if (location.startsWith("accounts/")) return location;
  return `${accountName(account)}/locations/${location.replace(/^locations\//, "")}`;
}

function childName(parent: string, collection: string, value: string): string {
  return value.includes(`/${collection}/`) ? value : `${parent}/${collection}/${value}`;
}

function parentName(value: string): string {
  if (value.startsWith("accounts/") || value.startsWith("locations/")) return value;
  throw new Error("Admin parent must start with accounts/ or locations/.");
}

function adminName(value: string): string {
  if (/^(accounts|locations)\/.+\/admins\/.+/.test(value)) return value;
  throw new Error("Admin name must be a full accounts/.../admins/... or locations/.../admins/... resource name.");
}

function verificationName(value: string): string {
  if (/^locations\/.+\/verifications\/.+/.test(value)) return value;
  throw new Error("Verification name must be a full locations/.../verifications/... resource name.");
}

function redact(value: string): string {
  return value
    .replace(/("(?:access_token|refresh_token|client_secret)"\s*:\s*")[^"]+/gi, "$1[redacted]")
    .slice(0, 1000);
}
