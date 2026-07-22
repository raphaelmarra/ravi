import "reflect-metadata";
import { z } from "zod";
import { Ga4Client, parseAdminResource } from "../../apps/google-analytics-4/client.js";
import { jsonValueSchema } from "../return-schemas.js";
import { Arg, Command, CommandAccess, Group, Option, Returns } from "../decorators.js";

const resultSchema = z.object({ result: jsonValueSchema }).strict();

function wrap(result: unknown) {
  const payload = { result: result as never };
  console.log(JSON.stringify(payload, null, 2));
  return payload;
}

function writePlan(operation: string, dryRun: boolean | undefined, plan: Record<string, unknown>) {
  if (dryRun !== true) {
    throw new Error(`${operation} is dry-run-only in this migration. Re-run with --dry-run; no Google write was sent.`);
  }
  return wrap({
    ok: true,
    dryRun: true,
    liveExecution: false,
    networkCalled: false,
    operation,
    nextAction: "Review this plan with HITL before any future live promotion.",
    plan,
  });
}

@Group({
  name: "ga4",
  description: "Query GA4 reports and manage Analytics configuration through official Google APIs",
  scope: "open",
})
export class Ga4Commands {
  private client(connection?: string): Ga4Client {
    return new Ga4Client({ connection });
  }

  @Command({
    name: "report",
    description: "Run a bounded GA4 core report with explicit dimensions, metrics and dates",
    helpAfter: ga4Help({
      use: "Consultas ad-hoc de tráfego ou comportamento que os presets não cobrem.",
      notUse:
        "Use top-pages/top-sources/ecommerce para relatórios prontos e check-compatibility antes de combinações incertas.",
      examples: [
        "ravi ga4 report 123 --dimensions pagePath --metrics screenPageViews,sessions --start-date 30daysAgo --json",
        "ravi ga4 report properties/123 --dimensions country --metrics activeUsers --limit 50 --json",
      ],
      source: "Data API v1beta properties.runReport (POST, leitura).",
    }),
  })
  @CommandAccess({ kind: "read", resource: "ga4.data", action: "report", risk: "low" })
  @Returns(resultSchema)
  async report(
    @Arg("property", { description: "GA4 property id or properties/<id>" }) property: string,
    @Option({ flags: "--dimensions <csv>", description: "Comma-separated Data API dimensions" }) dimensions: string,
    @Option({ flags: "--metrics <csv>", description: "Comma-separated Data API metrics" }) metrics: string,
    @Option({
      flags: "--start-date <date>",
      description: "Start date, e.g. 30daysAgo or 2026-06-01",
      defaultValue: "30daysAgo",
    })
    startDate?: string,
    @Option({
      flags: "--end-date <date>",
      description: "End date, e.g. yesterday or 2026-06-30",
      defaultValue: "yesterday",
    })
    endDate?: string,
    @Option({ flags: "--limit <n>", description: "Rows, 1-250000", defaultValue: "1000" }) limit?: string,
    @Option({ flags: "--offset <n>", description: "Pagination offset", defaultValue: "0" }) offset?: string,
    @Option({ flags: "--connection <id>", description: "Ravi credential connection (default: default)" })
    connection?: string,
  ) {
    const dimensionNames = requiredCsv(dimensions, "--dimensions");
    const metricNames = requiredCsv(metrics, "--metrics");
    return wrap(
      await this.client(connection).runReport(property, {
        dimensions: dimensionNames.map((name) => ({ name })),
        metrics: metricNames.map((name) => ({ name })),
        dateRanges: [{ startDate: startDate ?? "30daysAgo", endDate: endDate ?? "yesterday" }],
        limit: String(integer(limit, 1_000, 1, 250_000)),
        offset: String(integer(offset, 0, 0, Number.MAX_SAFE_INTEGER)),
      }),
    );
  }

  @Command({
    name: "realtime",
    description: "Run a GA4 realtime report for the current 30-minute window",
    helpAfter: ga4Help({
      use: "Monitorar atividade dos últimos 30 minutos (até 60 em propriedades Analytics 360).",
      notUse: "Use report para períodos históricos e metadata para descobrir campos.",
      examples: [
        "ravi ga4 realtime 123 --metrics activeUsers --json",
        "ravi ga4 realtime properties/123 --dimensions country --metrics activeUsers --limit 25 --json",
      ],
      source: "Data API v1beta properties.runRealtimeReport (POST, leitura).",
    }),
  })
  @CommandAccess({ kind: "read", resource: "ga4.data", action: "realtime", risk: "low" })
  @Returns(resultSchema)
  async realtime(
    @Arg("property") property: string,
    @Option({ flags: "--dimensions <csv>", description: "Realtime dimensions" }) dimensions?: string,
    @Option({ flags: "--metrics <csv>", description: "Realtime metrics", defaultValue: "activeUsers" })
    metrics?: string,
    @Option({ flags: "--limit <n>", description: "Rows, 1-250000", defaultValue: "100" }) limit?: string,
    @Option({ flags: "--connection <id>" }) connection?: string,
  ) {
    return wrap(
      await this.client(connection).runRealtimeReport(property, {
        dimensions: csv(dimensions).map((name) => ({ name })),
        metrics: requiredCsv(metrics, "--metrics").map((name) => ({ name })),
        limit: String(integer(limit, 100, 1, 250_000)),
      }),
    );
  }

  @Command({
    name: "top-pages",
    description: "List the most viewed page paths for an explicit recent period",
    helpAfter: ga4Help({
      use: "Obter rapidamente páginas mais vistas, sessões e período explícito.",
      notUse: "Use report quando precisar de outras dimensões, métricas ou filtros.",
      examples: [
        "ravi ga4 top-pages 123 --days 30 --limit 25 --json",
        "ravi ga4 top-pages properties/123 --days 7 --limit 10 --json",
      ],
      source: "Data API v1beta properties.runReport (preset read-only).",
    }),
  })
  @CommandAccess({ kind: "read", resource: "ga4.data", action: "top-pages", risk: "low" })
  @Returns(resultSchema)
  async topPages(
    @Arg("property") property: string,
    @Option({ flags: "--days <n>", description: "Period length in days", defaultValue: "30" }) days?: string,
    @Option({ flags: "--limit <n>", description: "Rows, 1-1000", defaultValue: "25" }) limit?: string,
    @Option({ flags: "--connection <id>" }) connection?: string,
  ) {
    return this.presetReport(property, "pagePath", ["screenPageViews", "sessions"], days, limit, connection);
  }

  @Command({
    name: "top-sources",
    description: "List traffic sources and revenue for an explicit recent period",
    helpAfter: ga4Help({
      use: "Comparar origens/mídias por sessões, usuários e receita reportada pelo GA4.",
      notUse: "Use ecommerce para visão por canal/item e report para filtros customizados.",
      examples: [
        "ravi ga4 top-sources 123 --days 30 --limit 25 --json",
        "ravi ga4 top-sources properties/123 --days 90 --limit 50 --json",
      ],
      source: "Data API v1beta properties.runReport (preset read-only).",
    }),
  })
  @CommandAccess({ kind: "read", resource: "ga4.data", action: "top-sources", risk: "low" })
  @Returns(resultSchema)
  async topSources(
    @Arg("property") property: string,
    @Option({ flags: "--days <n>", defaultValue: "30" }) days?: string,
    @Option({ flags: "--limit <n>", defaultValue: "25" }) limit?: string,
    @Option({ flags: "--connection <id>" }) connection?: string,
  ) {
    return this.presetReport(
      property,
      "sessionSourceMedium",
      ["sessions", "totalUsers", "purchaseRevenue"],
      days,
      limit,
      connection,
    );
  }

  @Command({
    name: "audience",
    description: "Break down active users by country, city or device category",
    helpAfter: ga4Help({
      use: "Quebrar usuários ativos e sessões por país, cidade ou dispositivo.",
      notUse: "Não use como decisão demográfica isolada; use report para dimensões fora do preset.",
      examples: [
        "ravi ga4 audience 123 --by country --days 30 --json",
        "ravi ga4 audience properties/123 --by device --days 7 --limit 20 --json",
      ],
      source: "Data API v1beta properties.runReport (preset read-only).",
    }),
  })
  @CommandAccess({ kind: "read", resource: "ga4.data", action: "audience", risk: "low" })
  @Returns(resultSchema)
  async audience(
    @Arg("property") property: string,
    @Option({ flags: "--by <dimension>", description: "country|city|device", defaultValue: "country" }) by?: string,
    @Option({ flags: "--days <n>", defaultValue: "30" }) days?: string,
    @Option({ flags: "--limit <n>", defaultValue: "25" }) limit?: string,
    @Option({ flags: "--connection <id>" }) connection?: string,
  ) {
    const dimensions: Record<string, string> = { country: "country", city: "city", device: "deviceCategory" };
    const dimension = dimensions[by ?? "country"];
    if (!dimension) throw new Error("--by must be country|city|device.");
    return this.presetReport(property, dimension, ["activeUsers", "sessions"], days, limit, connection);
  }

  @Command({
    name: "ecommerce",
    description: "Read GA4 ecommerce transactions and revenue without currency conversion",
    helpAfter: ga4Help({
      use: "Ler transações e purchaseRevenue por canal ou item na moeda retornada pelo GA4.",
      notUse: "Não converte moeda e não executa operação financeira; use report para campos customizados.",
      examples: [
        "ravi ga4 ecommerce 123 --by channel --days 30 --json",
        "ravi ga4 ecommerce properties/123 --by item --days 90 --limit 50 --json",
      ],
      source: "Data API v1beta properties.runReport (preset read-only, sem mutação financeira).",
    }),
  })
  @CommandAccess({ kind: "read", resource: "ga4.data", action: "ecommerce", risk: "low" })
  @Returns(resultSchema)
  async ecommerce(
    @Arg("property") property: string,
    @Option({ flags: "--by <view>", description: "channel|item", defaultValue: "channel" }) by?: string,
    @Option({ flags: "--days <n>", defaultValue: "30" }) days?: string,
    @Option({ flags: "--limit <n>", defaultValue: "25" }) limit?: string,
    @Option({ flags: "--connection <id>" }) connection?: string,
  ) {
    const dimension = by === "item" ? "itemName" : by === "channel" || !by ? "sessionDefaultChannelGroup" : null;
    if (!dimension) throw new Error("--by must be channel|item.");
    return this.presetReport(property, dimension, ["transactions", "purchaseRevenue"], days, limit, connection);
  }

  @Command({
    name: "trends",
    description: "Compare a metric across a recent period and its immediately preceding period",
    helpAfter: ga4Help({
      use: "Comparar uma métrica entre um período recente e o período imediatamente anterior.",
      notUse: "Use report para múltiplas métricas/dimensões e realtime para a janela atual.",
      examples: [
        "ravi ga4 trends 123 --metric sessions --days 30 --json",
        "ravi ga4 trends properties/123 --metric purchaseRevenue --days 7 --json",
      ],
      source: "Data API v1beta properties.runReport com dois dateRanges (leitura).",
    }),
  })
  @CommandAccess({ kind: "read", resource: "ga4.data", action: "trends", risk: "low" })
  @Returns(resultSchema)
  async trends(
    @Arg("property") property: string,
    @Option({ flags: "--metric <name>", defaultValue: "sessions" }) metric?: string,
    @Option({ flags: "--days <n>", defaultValue: "30" }) days?: string,
    @Option({ flags: "--connection <id>" }) connection?: string,
  ) {
    const count = integer(days, 30, 1, 365);
    return wrap(
      await this.client(connection).runReport(property, {
        metrics: [{ name: metric ?? "sessions" }],
        dateRanges: [
          { startDate: `${count}daysAgo`, endDate: "yesterday", name: "current" },
          { startDate: `${count * 2}daysAgo`, endDate: `${count + 1}daysAgo`, name: "previous" },
        ],
      }),
    );
  }

  @Command({
    name: "metadata",
    description: "List dimensions and metrics available to a GA4 property",
    helpAfter: ga4Help({
      use: "Descobrir dimensões, métricas e comparações válidas, inclusive campos customizados.",
      notUse: "Use check-compatibility para validar uma combinação específica.",
      examples: ["ravi ga4 metadata 0 --json", "ravi ga4 metadata properties/123 --json"],
      source: "Data API v1beta properties.getMetadata (GET, leitura).",
    }),
  })
  @CommandAccess({ kind: "read", resource: "ga4.data", action: "metadata", risk: "low" })
  @Returns(resultSchema)
  async metadata(@Arg("property") property: string, @Option({ flags: "--connection <id>" }) connection?: string) {
    return wrap(await this.client(connection).getMetadata(property));
  }

  @Command({
    name: "check-compatibility",
    description: "Check core-report dimension and metric compatibility",
    helpAfter: ga4Help({
      use: "Validar dimensões e métricas antes de montar um core report.",
      notUse: "Não valida regras específicas de realtime; use metadata para catálogo completo.",
      examples: [
        "ravi ga4 check-compatibility 123 --dimensions country --metrics activeUsers --json",
        "ravi ga4 check-compatibility properties/123 --dimensions pagePath --metrics sessions --compatible-only --json",
      ],
      source: "Data API v1beta properties.checkCompatibility (POST, leitura sem mutação).",
    }),
  })
  @CommandAccess({ kind: "read", resource: "ga4.data", action: "check-compatibility", risk: "low" })
  @Returns(resultSchema)
  async checkCompatibility(
    @Arg("property") property: string,
    @Option({ flags: "--dimensions <csv>" }) dimensions: string,
    @Option({ flags: "--metrics <csv>" }) metrics: string,
    @Option({ flags: "--compatible-only", description: "Return only compatible fields" }) compatibleOnly?: boolean,
    @Option({ flags: "--connection <id>" }) connection?: string,
  ) {
    return wrap(
      await this.client(connection).checkCompatibility(property, {
        dimensions: requiredCsv(dimensions, "--dimensions").map((name) => ({ name })),
        metrics: requiredCsv(metrics, "--metrics").map((name) => ({ name })),
        compatibilityFilter: compatibleOnly ? "COMPATIBLE" : undefined,
      }),
    );
  }

  @Command({
    name: "batch-report",
    description: "Run multiple core reports from an official BatchRunReports request JSON",
    helpAfter: ga4Help({
      use: "Executar vários core reports da mesma propriedade em uma chamada.",
      notUse: "Use report para uma consulta simples e batch-pivot-report para pivôs.",
      examples: [
        'ravi ga4 batch-report 123 --request-json \'{"requests":[{"metrics":[{"name":"activeUsers"}]}]}\' --json',
        'ravi ga4 batch-report properties/123 --request-json \'{"requests":[{"dimensions":[{"name":"country"}],"metrics":[{"name":"sessions"}]}]}\' --json',
      ],
      source: "Data API v1beta properties.batchRunReports (POST, leitura).",
    }),
  })
  @CommandAccess({ kind: "read", resource: "ga4.data", action: "batch-report", risk: "low" })
  @Returns(resultSchema)
  async batchReport(
    @Arg("property") property: string,
    @Option({ flags: "--request-json <json>", description: "Official BatchRunReportsRequest JSON" })
    requestJson: string,
    @Option({ flags: "--connection <id>" }) connection?: string,
  ) {
    return wrap(await this.client(connection).batchRunReports(property, jsonObject(requestJson, "--request-json")));
  }

  @Command({
    name: "pivot-report",
    description: "Run one pivot report from an official RunPivotReport request JSON",
    helpAfter: ga4Help({
      use: "Executar tabela dinâmica quando um core report simples não expressa a análise.",
      notUse: "Use report para tabelas simples e metadata/check-compatibility antes de campos incertos.",
      examples: [
        'ravi ga4 pivot-report 123 --request-json \'{"metrics":[{"name":"sessions"}],"pivots":[{"fieldNames":["country"],"limit":10}]}\' --json',
        'ravi ga4 pivot-report properties/123 --request-json \'{"dateRanges":[{"startDate":"7daysAgo","endDate":"yesterday"}],"dimensions":[{"name":"country"}],"metrics":[{"name":"activeUsers"}],"pivots":[{"fieldNames":["country"]}]}\' --json',
      ],
      source: "Data API v1beta properties.runPivotReport (POST, leitura).",
    }),
  })
  @CommandAccess({ kind: "read", resource: "ga4.data", action: "pivot-report", risk: "low" })
  @Returns(resultSchema)
  async pivotReport(
    @Arg("property") property: string,
    @Option({ flags: "--request-json <json>" }) requestJson: string,
    @Option({ flags: "--connection <id>" }) connection?: string,
  ) {
    return wrap(await this.client(connection).runPivotReport(property, jsonObject(requestJson, "--request-json")));
  }

  @Command({
    name: "batch-pivot-report",
    description: "Run multiple pivot reports from official request JSON",
    helpAfter: ga4Help({
      use: "Executar múltiplos relatórios pivot da mesma propriedade em uma chamada.",
      notUse: "Use pivot-report para um pivô e batch-report para core reports simples.",
      examples: [
        'ravi ga4 batch-pivot-report 123 --request-json \'{"requests":[{"metrics":[{"name":"sessions"}],"pivots":[{"fieldNames":["country"]}]}]}\' --json',
        "ravi ga4 batch-pivot-report properties/123 --request-json '{\"requests\":[]}' --json",
      ],
      source: "Data API v1beta properties.batchRunPivotReports (POST, leitura).",
    }),
  })
  @CommandAccess({ kind: "read", resource: "ga4.data", action: "batch-pivot-report", risk: "low" })
  @Returns(resultSchema)
  async batchPivotReport(
    @Arg("property") property: string,
    @Option({ flags: "--request-json <json>" }) requestJson: string,
    @Option({ flags: "--connection <id>" }) connection?: string,
  ) {
    return wrap(
      await this.client(connection).batchRunPivotReports(property, jsonObject(requestJson, "--request-json")),
    );
  }

  @Command({
    name: "audience-export-create",
    description: "Create a server-side audience export job",
    helpAfter: ga4Help({
      use: "Criar um job assíncrono de exportação de audiência já existente.",
      notUse: "Não use sem confirmação humana; consulte com audience-export-get e leia com audience-export-query.",
      examples: [
        'ravi ga4 audience-export-create 123 --request-json \'{"audience":"properties/123/audiences/4","dimensions":[{"dimensionName":"userId"}]}\' --dry-run --json',
        'ravi ga4 audience-export-create properties/123 --request-json \'{"audience":"properties/123/audiences/4","dimensions":[]}\' --dry-run --json',
      ],
      source: "Data API v1beta properties.audienceExports.create (POST, write; dry-run-only nesta migração).",
      mutation: true,
    }),
  })
  @CommandAccess({
    kind: "mutate",
    resource: "ga4.audience-exports",
    action: "create",
    risk: "medium",
    requiresConfirmation: true,
  })
  @Returns(resultSchema)
  async audienceExportCreate(
    @Arg("property") property: string,
    @Option({ flags: "--request-json <json>", description: "Official AudienceExport body" }) requestJson: string,
    @Option({ flags: "--dry-run", description: "Required; only prints the planned request without Google writes" })
    dryRun?: boolean,
    @Option({ flags: "--connection <id>" }) connection?: string,
  ) {
    return writePlan("audience-export-create", dryRun, {
      method: "POST",
      api: "Analytics Data API v1beta",
      path: `properties/${property.replace(/^properties\//, "")}/audienceExports`,
      body: jsonObject(requestJson, "--request-json"),
      connection: connection ?? "default",
      permission: "ga4:audience-exports:write",
      mutating: true,
      destructive: false,
    });
  }

  @Command({
    name: "audience-export-get",
    description: "Get audience export job metadata",
    helpAfter: ga4Help({
      use: "Consultar configuração e estado de um job de audience export.",
      notUse: "Use audience-export-query para ler as linhas e list para descobrir jobs.",
      examples: [
        "ravi ga4 audience-export-get properties/123/audienceExports/456 --json",
        "ravi ga4 audience-export-get properties/123/audienceExports/456 --connection approved --json",
      ],
      source: "Data API v1beta properties.audienceExports.get (GET, leitura).",
    }),
  })
  @CommandAccess({ kind: "read", resource: "ga4.audience-exports", action: "get", risk: "low" })
  @Returns(resultSchema)
  async audienceExportGet(
    @Arg("name", { description: "properties/<id>/audienceExports/<id>" }) name: string,
    @Option({ flags: "--connection <id>" }) connection?: string,
  ) {
    return wrap(await this.client(connection).getAudienceExport(name));
  }

  @Command({
    name: "audience-export-list",
    description: "List audience exports for a property",
    helpAfter: ga4Help({
      use: "Listar jobs de audience export com página limitada e next page token.",
      notUse: "Use audience-export-get para um job e query para suas linhas.",
      examples: [
        "ravi ga4 audience-export-list 123 --limit 50 --json",
        "ravi ga4 audience-export-list properties/123 --limit 50 --page-token NEXT --json",
      ],
      source: "Data API v1beta properties.audienceExports.list (GET, leitura paginada).",
    }),
  })
  @CommandAccess({ kind: "read", resource: "ga4.audience-exports", action: "list", risk: "low" })
  @Returns(resultSchema)
  async audienceExportList(
    @Arg("property") property: string,
    @Option({ flags: "--limit <n>", defaultValue: "50" }) limit?: string,
    @Option({ flags: "--page-token <token>" }) pageToken?: string,
    @Option({ flags: "--connection <id>" }) connection?: string,
  ) {
    return wrap(await this.client(connection).listAudienceExports(property, integer(limit, 50, 1, 200), pageToken));
  }

  @Command({
    name: "audience-export-query",
    description: "Read rows from a completed audience export",
    helpAfter: ga4Help({
      use: "Ler linhas de um audience export concluído, com body oficial explícito.",
      notUse: "Use audience-export-get para verificar estado antes de consultar linhas.",
      examples: [
        "ravi ga4 audience-export-query properties/123/audienceExports/456 --request-json '{\"limit\":100}' --json",
        'ravi ga4 audience-export-query properties/123/audienceExports/456 --request-json \'{"offset":100,"limit":100}\' --json',
      ],
      source: "Data API v1beta properties.audienceExports.query (POST, leitura).",
    }),
  })
  @CommandAccess({ kind: "read", resource: "ga4.audience-exports", action: "query", risk: "low" })
  @Returns(resultSchema)
  async audienceExportQuery(
    @Arg("name") name: string,
    @Option({ flags: "--request-json <json>" }) requestJson: string,
    @Option({ flags: "--connection <id>" }) connection?: string,
  ) {
    return wrap(await this.client(connection).queryAudienceExport(name, jsonObject(requestJson, "--request-json")));
  }

  @Command({
    name: "admin-account-summaries",
    description: "List account/property summaries using Admin API v1beta",
    helpAfter: ga4Help({
      use: "Descobrir contas e propriedades acessíveis com paginação oficial.",
      notUse: "Use admin-list properties com --parent para listar propriedades de uma conta específica.",
      examples: [
        "ravi ga4 admin-account-summaries --limit 50 --json",
        "ravi ga4 admin-account-summaries --limit 50 --page-token NEXT --json",
      ],
      source: "Admin API v1beta accountSummaries.list (GET, admin read).",
    }),
  })
  @CommandAccess({ kind: "read", resource: "ga4.admin", action: "account-summaries", risk: "low" })
  @Returns(resultSchema)
  async adminAccountSummaries(
    @Option({ flags: "--limit <n>", defaultValue: "50" }) limit?: string,
    @Option({ flags: "--page-token <token>" }) pageToken?: string,
    @Option({ flags: "--connection <id>" }) connection?: string,
  ) {
    return wrap(await this.client(connection).listAccountSummaries(integer(limit, 50, 1, 200), pageToken));
  }

  @Command({
    name: "admin-list",
    description: "List a confirmed GA4 Admin resource using its official v1beta/v1alpha channel",
    helpAfter: ga4Help({
      use: "Listar um recurso Admin suportado; properties exige parent accounts/<id>.",
      notUse: "Use admin-get para um resource name e admin-account-summaries para descoberta inicial.",
      examples: [
        "ravi ga4 admin-list properties --parent accounts/123 --limit 50 --json",
        "ravi ga4 admin-list key-events --parent properties/123 --limit 50 --json",
      ],
      source: "Google Analytics Admin API v1beta/v1alpha list methods (admin read).",
    }),
  })
  @CommandAccess({ kind: "read", resource: "ga4.admin", action: "list", risk: "low" })
  @Returns(resultSchema)
  async adminList(
    @Arg("resource", { description: "Run `ravi ga4 admin-list --help` for supported resource names" }) resource: string,
    @Option({ flags: "--parent <name>", description: "Parent resource, e.g. properties/123 or a data stream name" })
    parent?: string,
    @Option({ flags: "--limit <n>", defaultValue: "50" }) limit?: string,
    @Option({ flags: "--page-token <token>" }) pageToken?: string,
    @Option({ flags: "--connection <id>" }) connection?: string,
  ) {
    return wrap(
      await this.client(connection).listAdmin(
        parseAdminResource(resource),
        parent,
        integer(limit, 50, 1, 200),
        pageToken,
      ),
    );
  }

  @Command({
    name: "admin-get",
    description: "Get one confirmed GA4 Admin resource by canonical resource name",
    helpAfter: ga4Help({
      use: "Obter um recurso Admin pelo resource name canônico retornado pelo Google.",
      notUse: "Use admin-list para descobrir resource names; alguns recursos oficiais não possuem get.",
      examples: [
        "ravi ga4 admin-get properties properties/123 --json",
        "ravi ga4 admin-get key-events properties/123/keyEvents/456 --json",
      ],
      source: "Google Analytics Admin API v1beta/v1alpha get methods (admin read).",
    }),
  })
  @CommandAccess({ kind: "read", resource: "ga4.admin", action: "get", risk: "low" })
  @Returns(resultSchema)
  async adminGet(
    @Arg("resource") resource: string,
    @Arg("name", { description: "Canonical Google resource name" }) name: string,
    @Option({ flags: "--connection <id>" }) connection?: string,
  ) {
    return wrap(await this.client(connection).getAdmin(parseAdminResource(resource), name));
  }

  @Command({
    name: "admin-setting-get",
    description: "Read a confirmed GA4 property or data-stream setting",
    helpAfter: ga4Help({
      use: "Consultar retenção, atribuição, signals, reporting identity ou settings de data stream.",
      notUse: "Use admin-setting-update somente com aprovação e update mask oficial.",
      examples: [
        "ravi ga4 admin-setting-get data-retention properties/123 --json",
        "ravi ga4 admin-setting-get enhanced-measurement properties/123/dataStreams/456 --json",
      ],
      source: "Google Analytics Admin API settings get methods (admin read).",
    }),
  })
  @CommandAccess({ kind: "read", resource: "ga4.admin.settings", action: "get", risk: "low" })
  @Returns(resultSchema)
  async adminSettingGet(
    @Arg("setting", {
      description: "data-retention|attribution|google-signals|reporting-identity|enhanced-measurement|data-redaction",
    })
    setting: string,
    @Arg("name", { description: "Canonical property or data stream resource name" }) name: string,
    @Option({ flags: "--connection <id>" }) connection?: string,
  ) {
    return wrap(await this.client(connection).getAdminSetting(parseSetting(setting), name));
  }

  @Command({
    name: "admin-global-site-tag",
    description: "Read the gtag.js snippet for a GA4 web data stream",
    helpAfter: ga4Help({
      use: "Ler o snippet global site tag de um web data stream.",
      notUse: "Não use para editar tracking; esta operação é somente leitura.",
      examples: [
        "ravi ga4 admin-global-site-tag properties/123/dataStreams/456 --json",
        "ravi ga4 admin-global-site-tag properties/123/dataStreams/456 --connection approved --json",
      ],
      source: "Admin API v1alpha properties.dataStreams.getGlobalSiteTag (GET, admin read).",
    }),
  })
  @CommandAccess({ kind: "read", resource: "ga4.admin.data-streams", action: "global-site-tag", risk: "low" })
  @Returns(resultSchema)
  async adminGlobalSiteTag(
    @Arg("data-stream", { description: "properties/<id>/dataStreams/<id>" }) dataStream: string,
    @Option({ flags: "--connection <id>" }) connection?: string,
  ) {
    return wrap(await this.client(connection).getGlobalSiteTag(dataStream));
  }

  @Command({
    name: "admin-change-history",
    description: "Search GA4 account change history with official request JSON",
    helpAfter: ga4Help({
      use: "Auditar eventos de mudança de uma conta com filtros explícitos.",
      notUse: "Use admin-access-report para registros de acesso a dados.",
      examples: [
        "ravi ga4 admin-change-history accounts/123 --request-json '{\"pageSize\":50}' --json",
        'ravi ga4 admin-change-history 123 --request-json \'{"property":"properties/456","pageSize":20}\' --json',
      ],
      source: "Admin API v1beta accounts.searchChangeHistoryEvents (POST, admin read).",
    }),
  })
  @CommandAccess({ kind: "read", resource: "ga4.admin.audit", action: "change-history", risk: "low" })
  @Returns(resultSchema)
  async adminChangeHistory(
    @Arg("account", { description: "Account id or accounts/<id>" }) account: string,
    @Option({ flags: "--request-json <json>" }) requestJson: string,
    @Option({ flags: "--connection <id>" }) connection?: string,
  ) {
    return wrap(await this.client(connection).searchChangeHistory(account, jsonObject(requestJson, "--request-json")));
  }

  @Command({
    name: "admin-access-report",
    description: "Run a read-only GA4 account/property access report",
    helpAfter: ga4Help({
      use: "Consultar registros de acesso a dados de uma conta ou propriedade.",
      notUse: "Use admin-change-history para mudanças de configuração.",
      examples: [
        'ravi ga4 admin-access-report properties/123 --request-json \'{"dateRanges":[{"startDate":"7daysAgo","endDate":"yesterday"}],"dimensions":[],"metrics":[]}\' --json',
        'ravi ga4 admin-access-report accounts/123 --request-json \'{"dateRanges":[{"startDate":"30daysAgo","endDate":"yesterday"}]}\' --json',
      ],
      source: "Admin API v1beta accounts/properties.runAccessReport (POST, admin read).",
    }),
  })
  @CommandAccess({ kind: "read", resource: "ga4.admin.access", action: "report", risk: "low" })
  @Returns(resultSchema)
  async adminAccessReport(
    @Arg("entity", { description: "accounts/<id> or properties/<id>" }) entity: string,
    @Option({ flags: "--request-json <json>" }) requestJson: string,
    @Option({ flags: "--connection <id>" }) connection?: string,
  ) {
    return wrap(await this.client(connection).runAccessReport(entity, jsonObject(requestJson, "--request-json")));
  }

  @Command({
    name: "admin-setting-update",
    description: "Patch a confirmed GA4 property/data-stream setting",
    helpAfter: ga4Help({
      use: "Alterar um setting Admin oficialmente suportado com body e update mask explícitos.",
      notUse: "Leia primeiro com admin-setting-get; não execute sem confirmação humana.",
      examples: [
        'ravi ga4 admin-setting-update data-retention properties/123 --request-json \'{"eventDataRetention":"FOURTEEN_MONTHS"}\' --update-mask eventDataRetention --dry-run --json',
        'ravi ga4 admin-setting-update google-signals properties/123 --request-json \'{"state":"GOOGLE_SIGNALS_ENABLED"}\' --update-mask state --dry-run --json',
      ],
      source: "Google Analytics Admin API settings update methods (PATCH, admin write; dry-run-only nesta migração).",
      mutation: true,
    }),
  })
  @CommandAccess({
    kind: "mutate",
    resource: "ga4.admin.settings",
    action: "update",
    risk: "high",
    requiresConfirmation: true,
  })
  @Returns(resultSchema)
  async adminSettingUpdate(
    @Arg("setting") setting: string,
    @Arg("name") name: string,
    @Option({ flags: "--request-json <json>" }) requestJson: string,
    @Option({ flags: "--update-mask <fields>" }) updateMask?: string,
    @Option({ flags: "--dry-run", description: "Required; only prints the planned request without Google writes" })
    dryRun?: boolean,
    @Option({ flags: "--connection <id>" }) connection?: string,
  ) {
    return writePlan("admin-setting-update", dryRun, {
      method: "PATCH",
      api: "Analytics Admin API v1beta/v1alpha",
      resource: parseSetting(setting),
      name,
      updateMask: updateMask ?? null,
      body: jsonObject(requestJson, "--request-json"),
      connection: connection ?? "default",
      permission: "ga4:admin:write",
      mutating: true,
      destructive: false,
    });
  }

  @Command({
    name: "admin-acknowledge-user-data",
    description: "Acknowledge user-data collection terms for a GA4 property",
    helpAfter: ga4Help({
      use: "Registrar acknowledgement de coleta de user data quando houver aprovação jurídica/operacional.",
      notUse: "Não é health check nem leitura; não execute sem confirmação humana explícita.",
      examples: [
        'ravi ga4 admin-acknowledge-user-data 123 --request-json \'{"acknowledgement":"I acknowledge..."}\' --dry-run --json',
        'ravi ga4 admin-acknowledge-user-data properties/123 --request-json \'{"acknowledgement":"APPROVED_TEXT"}\' --dry-run --json',
      ],
      source:
        "Admin API v1beta properties.acknowledgeUserDataCollection (POST, admin write; dry-run-only nesta migração).",
      mutation: true,
    }),
  })
  @CommandAccess({
    kind: "mutate",
    resource: "ga4.admin.properties",
    action: "acknowledge-user-data",
    risk: "high",
    requiresConfirmation: true,
  })
  @Returns(resultSchema)
  async adminAcknowledgeUserData(
    @Arg("property") property: string,
    @Option({ flags: "--request-json <json>" }) requestJson: string,
    @Option({ flags: "--dry-run", description: "Required; only prints the planned request without Google writes" })
    dryRun?: boolean,
    @Option({ flags: "--connection <id>" }) connection?: string,
  ) {
    return writePlan("admin-acknowledge-user-data", dryRun, {
      method: "POST",
      api: "Analytics Admin API v1beta",
      path: `properties/${property.replace(/^properties\//, "")}:acknowledgeUserDataCollection`,
      body: jsonObject(requestJson, "--request-json"),
      connection: connection ?? "default",
      permission: "ga4:admin:write",
      mutating: true,
      destructive: false,
    });
  }

  @Command({
    name: "admin-create",
    description: "Create a confirmed GA4 Admin resource from official request JSON",
    helpAfter: ga4Help({
      use: "Criar apenas recursos presentes na allowlist oficial do cliente.",
      notUse: "Não invente resource/endpoint e não execute sem confirmação humana.",
      examples: [
        'ravi ga4 admin-create key-events --parent properties/123 --request-json \'{"eventName":"purchase"}\' --dry-run --json',
        'ravi ga4 admin-create data-streams --parent properties/123 --request-json \'{"displayName":"Web","type":"WEB_DATA_STREAM"}\' --dry-run --json',
      ],
      source:
        "Google Analytics Admin API v1beta/v1alpha create methods (POST, admin write; dry-run-only nesta migração).",
      mutation: true,
    }),
  })
  @CommandAccess({
    kind: "mutate",
    resource: "ga4.admin",
    action: "create",
    risk: "high",
    requiresConfirmation: true,
  })
  @Returns(resultSchema)
  async adminCreate(
    @Arg("resource") resource: string,
    @Option({ flags: "--parent <name>", description: "Required for nested resources" }) parent: string | undefined,
    @Option({ flags: "--request-json <json>", description: "Official create request body" }) requestJson: string,
    @Option({ flags: "--dry-run", description: "Required; only prints the planned request without Google writes" })
    dryRun?: boolean,
    @Option({ flags: "--connection <id>" }) connection?: string,
  ) {
    return writePlan("admin-create", dryRun, {
      method: "POST",
      api: "Analytics Admin API v1beta/v1alpha",
      resource: parseAdminResource(resource),
      parent: parent ?? null,
      body: jsonObject(requestJson, "--request-json"),
      connection: connection ?? "default",
      permission: "ga4:admin:write",
      mutating: true,
      destructive: false,
    });
  }

  @Command({
    name: "admin-update",
    description: "Patch a confirmed GA4 Admin resource with an explicit update mask",
    helpAfter: ga4Help({
      use: "Atualizar recurso Admin allowlisted com resource name e update mask explícitos.",
      notUse: "Leia com admin-get antes; não execute sem confirmação humana.",
      examples: [
        'ravi ga4 admin-update properties properties/123 --update-mask displayName --request-json \'{"displayName":"Loja"}\' --dry-run --json',
        'ravi ga4 admin-update key-events properties/123/keyEvents/456 --update-mask countingMethod --request-json \'{"countingMethod":"ONCE_PER_EVENT"}\' --dry-run --json',
      ],
      source:
        "Google Analytics Admin API v1beta/v1alpha patch methods (PATCH, admin write; dry-run-only nesta migração).",
      mutation: true,
    }),
  })
  @CommandAccess({
    kind: "mutate",
    resource: "ga4.admin",
    action: "update",
    risk: "high",
    requiresConfirmation: true,
  })
  @Returns(resultSchema)
  async adminUpdate(
    @Arg("resource") resource: string,
    @Arg("name") name: string,
    @Option({ flags: "--update-mask <fields>", description: "Required comma-separated field mask" }) updateMask: string,
    @Option({ flags: "--request-json <json>" }) requestJson: string,
    @Option({ flags: "--dry-run", description: "Required; only prints the planned request without Google writes" })
    dryRun?: boolean,
    @Option({ flags: "--connection <id>" }) connection?: string,
  ) {
    if (!updateMask) throw new Error("--update-mask is required.");
    return writePlan("admin-update", dryRun, {
      method: "PATCH",
      api: "Analytics Admin API v1beta/v1alpha",
      resource: parseAdminResource(resource),
      name,
      updateMask,
      body: jsonObject(requestJson, "--request-json"),
      connection: connection ?? "default",
      permission: "ga4:admin:write",
      mutating: true,
      destructive: false,
    });
  }

  @Command({
    name: "admin-delete",
    description: "Delete or trash a confirmed GA4 Admin resource according to the provider contract",
    helpAfter: ga4Help({
      use: "Excluir ou enviar para lixeira somente recursos allowlisted pelo contrato oficial.",
      notUse: "Não use para custom dimensions/metrics/audiences; esses recursos usam archive.",
      examples: [
        "ravi ga4 admin-delete key-events properties/123/keyEvents/456 --dry-run --json",
        "ravi ga4 admin-delete data-streams properties/123/dataStreams/456 --dry-run --json",
      ],
      source: "Google Analytics Admin API delete methods (DELETE, destrutivo; dry-run-only nesta migração).",
      mutation: true,
      destructive: true,
    }),
  })
  @CommandAccess({
    kind: "mutate",
    resource: "ga4.admin",
    action: "delete",
    risk: "destructive",
    requiresConfirmation: true,
  })
  @Returns(resultSchema)
  async adminDelete(
    @Arg("resource") resource: string,
    @Arg("name") name: string,
    @Option({ flags: "--dry-run", description: "Required; only prints the planned request without Google writes" })
    dryRun?: boolean,
    @Option({ flags: "--connection <id>" }) connection?: string,
  ) {
    return writePlan("admin-delete", dryRun, {
      method: "DELETE",
      api: "Analytics Admin API v1beta/v1alpha",
      resource: parseAdminResource(resource),
      name,
      connection: connection ?? "default",
      permission: "ga4:admin:destructive",
      mutating: true,
      destructive: true,
    });
  }

  @Command({
    name: "admin-archive",
    description: "Archive a confirmed GA4 Admin resource",
    helpAfter: ga4Help({
      use: "Arquivar custom dimensions, custom metrics ou audiences allowlisted.",
      notUse: "Não use para recursos cujo contrato oficial expõe delete em vez de archive.",
      examples: [
        "ravi ga4 admin-archive custom-dimensions properties/123/customDimensions/7 --dry-run --json",
        "ravi ga4 admin-archive audiences properties/123/audiences/456 --dry-run --json",
      ],
      source: "Google Analytics Admin API archive methods (POST, destrutivo; dry-run-only nesta migração).",
      mutation: true,
      destructive: true,
    }),
  })
  @CommandAccess({
    kind: "mutate",
    resource: "ga4.admin",
    action: "archive",
    risk: "destructive",
    requiresConfirmation: true,
  })
  @Returns(resultSchema)
  async adminArchive(
    @Arg("resource") resource: string,
    @Arg("name") name: string,
    @Option({ flags: "--dry-run", description: "Required; only prints the planned request without Google writes" })
    dryRun?: boolean,
    @Option({ flags: "--connection <id>" }) connection?: string,
  ) {
    return writePlan("admin-archive", dryRun, {
      method: "POST",
      api: "Analytics Admin API v1beta/v1alpha",
      resource: parseAdminResource(resource),
      name,
      connection: connection ?? "default",
      permission: "ga4:admin:destructive",
      mutating: true,
      destructive: true,
    });
  }

  private async presetReport(
    property: string,
    dimension: string,
    metrics: string[],
    days: string | undefined,
    limit: string | undefined,
    connection: string | undefined,
  ) {
    const count = integer(days, 30, 1, 365);
    return wrap(
      await this.client(connection).runReport(property, {
        dimensions: [{ name: dimension }],
        metrics: metrics.map((name) => ({ name })),
        dateRanges: [{ startDate: `${count}daysAgo`, endDate: "yesterday" }],
        limit: String(integer(limit, 25, 1, 1_000)),
        orderBys: [{ metric: { metricName: metrics[0] }, desc: true }],
      }),
    );
  }
}

for (const command of [
  "report",
  "realtime",
  "topPages",
  "topSources",
  "audience",
  "ecommerce",
  "trends",
  "metadata",
  "checkCompatibility",
  "batchReport",
  "pivotReport",
  "batchPivotReport",
  "audienceExportCreate",
  "audienceExportGet",
  "audienceExportList",
  "audienceExportQuery",
  "adminAccountSummaries",
  "adminList",
  "adminGet",
  "adminSettingGet",
  "adminGlobalSiteTag",
  "adminChangeHistory",
  "adminAccessReport",
  "adminSettingUpdate",
  "adminAcknowledgeUserData",
  "adminCreate",
  "adminUpdate",
  "adminDelete",
  "adminArchive",
] as const) {
  const method = Ga4Commands.prototype[command];
  Option({ flags: "--json", description: "Print the stable JSON response envelope" })(
    Ga4Commands.prototype,
    command,
    method.length,
  );
}

function csv(value?: string): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function requiredCsv(value: string | undefined, flag: string): string[] {
  const values = csv(value);
  if (values.length === 0) throw new Error(`${flag} is required.`);
  return values;
}

function integer(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`Expected integer from ${min} to ${max}.`);
  }
  return parsed;
}

function jsonObject(value: string | undefined, flag: string): Record<string, unknown> {
  if (!value) throw new Error(`${flag} is required.`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${flag} must be valid JSON.`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${flag} must be a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

function parseSetting(value: string) {
  const settings = [
    "data-retention",
    "attribution",
    "google-signals",
    "reporting-identity",
    "enhanced-measurement",
    "data-redaction",
  ] as const;
  if (settings.some((setting) => setting === value)) return value as (typeof settings)[number];
  throw new Error(`Unsupported GA4 admin setting: ${value}. Use ${settings.join("|")}.`);
}

interface Ga4HelpInput {
  use: string;
  notUse: string;
  examples: [string, string];
  source: string;
  mutation?: boolean;
  destructive?: boolean;
}

function ga4Help(input: Ga4HelpInput): string {
  const impact = input.destructive
    ? "DESTRUTIVO. Requer autorização de execute app:google-analytics-4, permissão ga4:admin:destructive e confirmação humana."
    : input.mutation
      ? "WRITE. Requer autorização de execute app:google-analytics-4, permissão mutating específica e confirmação humana."
      : "READ-ONLY no provedor. Requer autorização de use app:google-analytics-4 e a permissão read declarada.";
  const hitl = input.mutation
    ? `\nHITL OBRIGATÓRIO\n  Confirme recurso, body/update mask, impacto e rollback antes de executar.\n  Template: "Autoriza ${input.destructive ? "a operação destrutiva" : "a escrita"} GA4 exatamente como exibida?"\n`
    : "";

  return `
CUSTO / SEGURANÇA
  ${impact}
  Nenhuma operação desta CLI é financeira; relatórios podem consumir quota da API.

USE
  ${input.use}

NÃO USE
  ${input.notUse}

REGRAS HARD
  - Credenciais vêm somente do broker Ravi; nunca passe token, refresh token ou client secret em flags.
  - IDs aceitam o resource name canônico documentado; recursos fora da allowlist falham antes do fetch.
  - --json imprime { "result": ... }; sucesso sai com code 0 e erro com code 1.
${hitl}
EXAMPLES
  ${input.examples[0]}
  ${input.examples[1]}

ON ERROR
  Credencial ausente -> configure uma conexão Ravi aprovada; o comando falha antes de chamar o Google.
  Recurso/campo inválido -> rode metadata, check-compatibility ou o comando read correspondente.
  HTTP do Google -> revise status e corpo redigido; segredos nunca são impressos.

FONTES
  ${input.source}
  Contrato verificado em 2026-07-22 na documentação oficial Google for Developers.
`;
}
