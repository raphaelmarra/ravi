import { resolveCredentialSecret } from "../../credentials/broker.js";

export interface Ga4Credential {
  accessToken: string;
}

export type Ga4CredentialAction =
  | "data.read"
  | "audience-exports.write"
  | "admin.read"
  | "admin.write"
  | "admin.destructive";
export type Ga4CredentialResolver = (connection: string, action: Ga4CredentialAction) => Promise<Ga4Credential>;

export interface Ga4ClientOptions {
  connection?: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  /** In-process injection reserved for tests and credential-free transport validation. */
  credential?: Ga4Credential;
  credentialResolver?: Ga4CredentialResolver;
}

export type Ga4AdminResource =
  | "accounts"
  | "properties"
  | "data-streams"
  | "key-events"
  | "custom-dimensions"
  | "custom-metrics"
  | "google-ads-links"
  | "firebase-links"
  | "measurement-protocol-secrets"
  | "audiences"
  | "bigquery-links"
  | "calculated-metrics"
  | "channel-groups"
  | "event-create-rules"
  | "event-edit-rules"
  | "access-bindings"
  | "annotations";

type AdminVersion = "v1beta" | "v1alpha";
type AdminCapability = "list" | "get" | "create" | "update" | "delete" | "archive";

interface AdminResourceContract {
  version: AdminVersion;
  segment: string;
  topLevel?: boolean;
  propertyList?: boolean;
  capabilities: readonly AdminCapability[];
}

const ADMIN_RESOURCES: Record<Ga4AdminResource, AdminResourceContract> = {
  accounts: {
    version: "v1beta",
    segment: "accounts",
    topLevel: true,
    capabilities: ["list", "get", "update", "delete"],
  },
  properties: {
    version: "v1beta",
    segment: "properties",
    topLevel: true,
    propertyList: true,
    capabilities: ["list", "get", "create", "update", "delete"],
  },
  "data-streams": {
    version: "v1beta",
    segment: "dataStreams",
    capabilities: ["list", "get", "create", "update", "delete"],
  },
  "key-events": {
    version: "v1beta",
    segment: "keyEvents",
    capabilities: ["list", "get", "create", "update", "delete"],
  },
  "custom-dimensions": {
    version: "v1beta",
    segment: "customDimensions",
    capabilities: ["list", "get", "create", "update", "archive"],
  },
  "custom-metrics": {
    version: "v1beta",
    segment: "customMetrics",
    capabilities: ["list", "get", "create", "update", "archive"],
  },
  "google-ads-links": {
    version: "v1beta",
    segment: "googleAdsLinks",
    capabilities: ["list", "create", "update", "delete"],
  },
  "firebase-links": {
    version: "v1beta",
    segment: "firebaseLinks",
    capabilities: ["list", "create", "delete"],
  },
  "measurement-protocol-secrets": {
    version: "v1beta",
    segment: "measurementProtocolSecrets",
    capabilities: ["list", "get", "create", "update", "delete"],
  },
  audiences: {
    version: "v1alpha",
    segment: "audiences",
    capabilities: ["list", "get", "create", "update", "archive"],
  },
  "bigquery-links": {
    version: "v1alpha",
    segment: "bigQueryLinks",
    capabilities: ["list", "get", "create", "update", "delete"],
  },
  "calculated-metrics": {
    version: "v1alpha",
    segment: "calculatedMetrics",
    capabilities: ["list", "get", "create", "update", "delete"],
  },
  "channel-groups": {
    version: "v1alpha",
    segment: "channelGroups",
    capabilities: ["list", "get", "create", "update", "delete"],
  },
  "event-create-rules": {
    version: "v1alpha",
    segment: "eventCreateRules",
    capabilities: ["list", "get", "create", "update", "delete"],
  },
  "event-edit-rules": {
    version: "v1alpha",
    segment: "eventEditRules",
    capabilities: ["list", "get", "create", "update", "delete"],
  },
  "access-bindings": {
    version: "v1alpha",
    segment: "accessBindings",
    capabilities: ["list", "get", "create", "update", "delete"],
  },
  annotations: {
    version: "v1alpha",
    segment: "reportingDataAnnotations",
    capabilities: ["list", "get", "create", "update", "delete"],
  },
};

const DATA_API = "https://analyticsdata.googleapis.com";
const ADMIN_API = "https://analyticsadmin.googleapis.com";

export class Ga4Client {
  readonly #connection: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #timeoutMs: number;
  readonly #credential?: Ga4Credential;
  readonly #credentialResolver: Ga4CredentialResolver;

  constructor(options: Ga4ClientOptions = {}) {
    this.#connection = options.connection ?? "default";
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#credential = options.credential;
    this.#credentialResolver =
      options.credentialResolver ??
      (async (connection, action) =>
        parseGa4Credential(
          (
            await resolveCredentialSecret({
              provider: "google-analytics",
              connection,
              action,
            })
          ).secret,
        ));
  }

  runReport(property: string, body: Record<string, unknown>): Promise<unknown> {
    return this.data(`v1beta/${propertyName(property)}:runReport`, { method: "POST", body: jsonBody(body) });
  }

  runRealtimeReport(property: string, body: Record<string, unknown>): Promise<unknown> {
    return this.data(`v1beta/${propertyName(property)}:runRealtimeReport`, { method: "POST", body: jsonBody(body) });
  }

  batchRunReports(property: string, body: Record<string, unknown>): Promise<unknown> {
    return this.data(`v1beta/${propertyName(property)}:batchRunReports`, { method: "POST", body: jsonBody(body) });
  }

  runPivotReport(property: string, body: Record<string, unknown>): Promise<unknown> {
    return this.data(`v1beta/${propertyName(property)}:runPivotReport`, { method: "POST", body: jsonBody(body) });
  }

  batchRunPivotReports(property: string, body: Record<string, unknown>): Promise<unknown> {
    return this.data(`v1beta/${propertyName(property)}:batchRunPivotReports`, {
      method: "POST",
      body: jsonBody(body),
    });
  }

  getMetadata(property: string): Promise<unknown> {
    return this.data(`v1beta/${propertyName(property)}/metadata`);
  }

  checkCompatibility(property: string, body: Record<string, unknown>): Promise<unknown> {
    return this.data(`v1beta/${propertyName(property)}:checkCompatibility`, {
      method: "POST",
      body: jsonBody(body),
    });
  }

  createAudienceExport(property: string, body: Record<string, unknown>): Promise<unknown> {
    return this.data(
      `v1beta/${propertyName(property)}/audienceExports`,
      { method: "POST", body: jsonBody(body) },
      "audience-exports.write",
    );
  }

  getAudienceExport(name: string): Promise<unknown> {
    return this.data(`v1beta/${resourceName(name, "properties/")}`);
  }

  listAudienceExports(property: string, pageSize?: number, pageToken?: string): Promise<unknown> {
    return this.data(withQuery(`v1beta/${propertyName(property)}/audienceExports`, { pageSize, pageToken }));
  }

  queryAudienceExport(name: string, body: Record<string, unknown>): Promise<unknown> {
    return this.data(`v1beta/${resourceName(name, "properties/")}:query`, { method: "POST", body: jsonBody(body) });
  }

  listAccountSummaries(pageSize?: number, pageToken?: string): Promise<unknown> {
    return this.admin(withQuery("v1beta/accountSummaries", { pageSize, pageToken }));
  }

  listAdmin(resource: Ga4AdminResource, parent?: string, pageSize?: number, pageToken?: string): Promise<unknown> {
    const contract = adminContract(resource, "list");
    let path: string;
    const query: Record<string, string | number | undefined> = { pageSize, pageToken };
    if (contract.topLevel) {
      path = `${contract.version}/${contract.segment}`;
      if (contract.propertyList) {
        if (!parent) throw new Error("--parent accounts/<id> is required when listing GA4 properties.");
        query.filter = `parent:${resourceName(parent, "accounts/")}`;
      }
    } else {
      if (!parent) throw new Error(`--parent is required for GA4 admin resource ${resource}.`);
      path = `${contract.version}/${resourceName(parent)}/${contract.segment}`;
    }
    return this.admin(withQuery(path, query));
  }

  getAdmin(resource: Ga4AdminResource, name: string): Promise<unknown> {
    const contract = adminContract(resource, "get");
    return this.admin(`${contract.version}/${resourceName(name)}`);
  }

  createAdmin(resource: Ga4AdminResource, parent: string | undefined, body: Record<string, unknown>): Promise<unknown> {
    const contract = adminContract(resource, "create");
    const path = contract.topLevel
      ? `${contract.version}/${contract.segment}`
      : `${contract.version}/${resourceName(requiredParent(resource, parent))}/${contract.segment}`;
    return this.admin(path, { method: "POST", body: jsonBody(body) }, "admin.write");
  }

  updateAdmin(
    resource: Ga4AdminResource,
    name: string,
    body: Record<string, unknown>,
    updateMask: string,
  ): Promise<unknown> {
    const contract = adminContract(resource, "update");
    const path = withQuery(`${contract.version}/${resourceName(name)}`, { updateMask });
    return this.admin(path, { method: "PATCH", body: jsonBody({ ...body, name: resourceName(name) }) }, "admin.write");
  }

  deleteAdmin(resource: Ga4AdminResource, name: string): Promise<unknown> {
    const contract = adminContract(resource, "delete");
    return this.admin(`${contract.version}/${resourceName(name)}`, { method: "DELETE" }, "admin.destructive");
  }

  archiveAdmin(resource: Ga4AdminResource, name: string): Promise<unknown> {
    const contract = adminContract(resource, "archive");
    return this.admin(
      `${contract.version}/${resourceName(name)}:archive`,
      { method: "POST", body: "{}" },
      "admin.destructive",
    );
  }

  getAdminSetting(
    setting:
      | "data-retention"
      | "attribution"
      | "google-signals"
      | "reporting-identity"
      | "enhanced-measurement"
      | "data-redaction",
    name: string,
  ): Promise<unknown> {
    const suffixes = {
      "data-retention": ["v1beta", "dataRetentionSettings"],
      attribution: ["v1alpha", "attributionSettings"],
      "google-signals": ["v1alpha", "googleSignalsSettings"],
      "reporting-identity": ["v1alpha", "reportingIdentitySettings"],
      "enhanced-measurement": ["v1alpha", "enhancedMeasurementSettings"],
      "data-redaction": ["v1alpha", "dataRedactionSettings"],
    } as const;
    const [version, suffix] = suffixes[setting];
    return this.admin(`${version}/${resourceName(name)}/${suffix}`);
  }

  updateAdminSetting(
    setting:
      | "data-retention"
      | "attribution"
      | "google-signals"
      | "reporting-identity"
      | "enhanced-measurement"
      | "data-redaction",
    name: string,
    body: Record<string, unknown>,
    updateMask?: string,
  ): Promise<unknown> {
    const contracts = {
      "data-retention": ["v1beta", "dataRetentionSettings"],
      attribution: ["v1alpha", "attributionSettings"],
      "google-signals": ["v1alpha", "googleSignalsSettings"],
      "reporting-identity": ["v1alpha", "reportingIdentitySettings"],
      "enhanced-measurement": ["v1alpha", "enhancedMeasurementSettings"],
      "data-redaction": ["v1alpha", "dataRedactionSettings"],
    } as const;
    const [version, suffix] = contracts[setting];
    const settingName = `${resourceName(name)}/${suffix}`;
    const path = withQuery(`${version}/${settingName}`, { updateMask });
    return this.admin(path, { method: "PATCH", body: jsonBody({ ...body, name: settingName }) }, "admin.write");
  }

  getGlobalSiteTag(dataStreamName: string): Promise<unknown> {
    return this.admin(`v1alpha/${resourceName(dataStreamName)}/globalSiteTag`);
  }

  searchChangeHistory(account: string, body: Record<string, unknown>): Promise<unknown> {
    return this.admin(`v1beta/${resourceName(account, "accounts/")}:searchChangeHistoryEvents`, {
      method: "POST",
      body: jsonBody(body),
    });
  }

  runAccessReport(entity: string, body: Record<string, unknown>): Promise<unknown> {
    return this.admin(`v1beta/${resourceName(entity)}:runAccessReport`, { method: "POST", body: jsonBody(body) });
  }

  acknowledgeUserDataCollection(property: string, body: Record<string, unknown>): Promise<unknown> {
    return this.admin(
      `v1beta/${propertyName(property)}:acknowledgeUserDataCollection`,
      {
        method: "POST",
        body: jsonBody(body),
      },
      "admin.write",
    );
  }

  private data(path: string, init: RequestInit = {}, action: Ga4CredentialAction = "data.read"): Promise<unknown> {
    return this.request(`${DATA_API}/${path}`, init, action);
  }

  private admin(path: string, init: RequestInit = {}, action: Ga4CredentialAction = "admin.read"): Promise<unknown> {
    return this.request(`${ADMIN_API}/${path}`, init, action);
  }

  private async request(url: string, init: RequestInit, action: Ga4CredentialAction): Promise<unknown> {
    const credential = this.#credential ?? (await this.#credentialResolver(this.#connection, action));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
    let response: Response;
    try {
      response = await this.#fetch(url, {
        ...init,
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${credential.accessToken}`,
          "content-type": "application/json",
          ...init.headers,
        },
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`Google Analytics API request timed out after ${this.#timeoutMs}ms.`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
    const text = await response.text();
    if (!response.ok) throw new Error(`Google Analytics API request failed (${response.status}): ${redact(text)}`);
    return text ? (JSON.parse(text) as unknown) : {};
  }
}

export function parseGa4Credential(value: string): Ga4Credential {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Google Analytics credential must be a JSON object containing accessToken.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Google Analytics credential must be a JSON object containing accessToken.");
  }
  const accessToken = (parsed as Record<string, unknown>).accessToken;
  if (typeof accessToken !== "string" || !accessToken.trim()) {
    throw new Error("Google Analytics credential misses accessToken.");
  }
  return { accessToken };
}

export function parseAdminResource(value: string): Ga4AdminResource {
  if (Object.hasOwn(ADMIN_RESOURCES, value)) return value as Ga4AdminResource;
  throw new Error(`Unsupported GA4 admin resource: ${value}. Use ${Object.keys(ADMIN_RESOURCES).join("|")}.`);
}

function adminContract(resource: Ga4AdminResource, capability: AdminCapability): AdminResourceContract {
  const contract = ADMIN_RESOURCES[resource];
  if (!contract.capabilities.includes(capability)) {
    throw new Error(
      `GA4 admin resource ${resource} does not support ${capability} in its confirmed official contract.`,
    );
  }
  return contract;
}

function requiredParent(resource: string, parent?: string): string {
  if (!parent) throw new Error(`--parent is required for GA4 admin resource ${resource}.`);
  return parent;
}

function propertyName(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("GA4 property is required.");
  return trimmed.startsWith("properties/") ? trimmed : `properties/${trimmed}`;
}

function resourceName(value: string, expectedPrefix?: string): string {
  const trimmed = value.trim().replace(/^\/+/, "");
  if (!trimmed) throw new Error("GA4 resource name is required.");
  if (expectedPrefix && !trimmed.startsWith(expectedPrefix)) return `${expectedPrefix}${trimmed}`;
  return trimmed;
}

function jsonBody(value: Record<string, unknown>): string {
  return JSON.stringify(value);
}

function withQuery(path: string, values: Record<string, string | number | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== "") query.set(key, String(value));
  }
  const encoded = query.toString();
  return encoded ? `${path}?${encoded}` : path;
}

function redact(value: string): string {
  return value
    .replace(/("(?:access_token|refresh_token|client_secret|accessToken)"\s*:\s*")[^"]+/gi, "$1[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .slice(0, 1_000);
}
