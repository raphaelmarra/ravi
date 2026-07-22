---
id: apps/google-analytics-4
title: "Google Analytics 4"
kind: capability
domain: apps
capability: google-analytics-4
capabilities:
  - manifest
  - cli
  - operations
  - permissions
  - google-analytics-data
  - google-analytics-admin
tags:
  - apps
  - ga4
  - analytics
  - google
applies_to:
  - src/apps/google-analytics-4
  - src/cli/commands/ga4.ts
  - src/plugins/internal/ravi-system/skills/ga4
owners:
  - ravi-dev
status: draft
normative: true
---

# Google Analytics 4

## Intent

Expor relatórios e administração do Google Analytics 4 como Ravi App nativo,
descobrível e permissionado, sem depender do SDE em runtime e sem desativar o
legado durante a migração paralela.

## Decisão de implementação

- `confirmed_official_contract`: **yes**
- `implementation_go_no_go`: **GO**
- App id: `google-analytics-4`
- CLI nativo: `ravi ga4`
- Cliente: REST nativo para `analyticsdata.googleapis.com` e
  `analyticsadmin.googleapis.com`
- Credencial: conexão futura pelo broker Ravi; ausência falha antes de `fetch`
- Persistência: nenhuma; respostas são recalculáveis e não agregam lineage local
- Legado: `sde ga4` permanece intacto e fora do diff

O id do app difere do grupo CLI de propósito. Um manifesto com id `ga4` e
operações `ravi ga4 ...` reentraria no alias dinâmico do router. O padrão
`google-analytics-4` + `ravi ga4` mantém o CLI curto sem recursão.

## Contrato oficial verificado em 2026-07-13

- Data API v1beta: `runReport`, `runRealtimeReport`, `batchRunReports`,
  `runPivotReport`, `batchRunPivotReports`, `getMetadata`,
  `checkCompatibility` e `properties.audienceExports`.
- Admin API v1beta: contas, propriedades, summaries, change history, access
  reports, data streams, key events, custom dimensions/metrics, Google Ads
  links, Firebase links e Measurement Protocol secrets.
- Admin API v1alpha: recursos preview do legado, incluindo audiences, BigQuery
  links, calculated metrics, channel groups, event rules, access bindings,
  annotations e settings preview.
- OAuth read: `https://www.googleapis.com/auth/analytics.readonly`.
- OAuth write: `https://www.googleapis.com/auth/analytics.edit` ou
  `https://www.googleapis.com/auth/analytics`, conforme o método oficial. A
  entrega inicial não cadastra nem usa esses tokens.

Fontes oficiais:

- https://developers.google.com/analytics/devguides/reporting/data/v1/rest
- https://developers.google.com/analytics/devguides/reporting/data/v1/rest/v1beta/properties/runReport
- https://developers.google.com/analytics/devguides/config/admin/v1/rest
- https://developers.google.com/identity/protocols/oauth2/scopes

## Matriz de operações

| operacao_sde | categoria | risco_read_write | endpoint_ou_recurso_oficial | status_decisao | justificativa | fonte_oficial | observacoes_para_ravi_dev |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `auth-url`, `auth`, `config` | setup/auth | write de credencial | OAuth/broker, fora das APIs de dados | `aguardar` | A fase inicial exclui onboarding/token real | OAuth scopes | Usar broker Ravi em fase posterior; nunca ler arquivo legado |
| `health` | verificação | read local | manifesto + resolução fechada de credencial | `migrar` | Health sem token deve provar estrutura, não conexão real | Ravi Apps manifest | `ravi apps check google-analytics-4 --json` |
| `report`, `top-pages`, `top-sources`, `audience`, `ecommerce`, `trends` | relatório | read | `POST /v1beta/properties/*:runReport` | `migrar` | Um endpoint oficial cobre consulta custom e presets | Data API `runReport` | Presets são composição local, sem persistência |
| `realtime` | relatório | read | `POST /v1beta/properties/*:runRealtimeReport` | `migrar` | Método oficial atual | Data API `runRealtimeReport` | Janela padrão oficial de 30 minutos |
| `metadata` | catálogo | read | `GET /v1beta/properties/*/metadata` | `migrar` | Descobre campos universais e customizados | Data API `getMetadata` | Property `0` retorna metadata universal |
| `check-compatibility` | validação | read | `POST /v1beta/properties/*:checkCompatibility` | `migrar` | Evita combinações inválidas antes do relatório | Data API `checkCompatibility` | Core report apenas; realtime tem regras próprias |
| `batch-report`, `pivot-report`, `batch-pivot-report` | relatório avançado | read | métodos batch/pivot v1beta | `migrar` | Métodos constam no REST oficial | Data API REST | Request body oficial entra como JSON explícito |
| `audience-export:get/list/query` | exportação | read | `properties.audienceExports.get/list/query` | `migrar` | Leitura de jobs e resultados oficiais | Data API audienceExports | Paginar list/query |
| `audience-export:create` | exportação | write | `properties.audienceExports.create` | `adicionar` | Cria job server-side e exige classe própria | Data API audienceExports | `ga4:audience-exports:write`, confirmação humana |
| `admin:account-summaries`, `admin:account:get`, `admin:list-properties`, `admin:property:get` | admin discovery | read | Admin API v1beta | `migrar` | Contrato estável atual | Admin API v1beta | Properties list exige filtro parent |
| lists/gets Admin estáveis do legado | admin resource | read | Admin API v1beta resources | `migrar` | Recursos e métodos constam no REST oficial | Admin API v1beta | Allowlist bloqueia pares resource/method inexistentes |
| lists/gets Admin preview do legado | admin resource | read | Admin API v1alpha resources | `migrar` | Contrato oficial existe, mas é preview | Admin API v1alpha | Canal fica explícito no cliente/versioning |
| `admin:change-history`, `admin:access-report` | auditoria | read | v1beta search/run access report | `migrar` | Métodos oficiais read-only | Admin API v1beta | Body oficial explícito |
| consultas de retention/attribution/signals/measurement/reporting identity/redaction | admin setting | read | settings get v1beta/v1alpha | `migrar` | Métodos oficiais confirmados | Admin API REST | `ga4:admin:read` |
| creates/patches/settings updates/acknowledgement Admin | admin mutation | write | create/patch/update/ack oficial | `adicionar` | Cobertura estrutural com confirmação obrigatória | Admin API REST | `ga4:admin:write`; nenhum handler foi executado nesta entrega |
| deletes/archives Admin | admin mutation | destructive | delete/archive oficial | `adicionar` | Classe de risco separada e allowlisted | Admin API REST | `ga4:admin:destructive`; nenhum handler foi executado |
| operações financeiras | financeiro | financial | inexistente no contrato GA4 migrado | `ignorar` | GA4 reporta métricas monetárias, mas não movimenta dinheiro | Data API schema | `ecommerce` é leitura, sem compra/pagamento/cancelamento |

## Permissões e risco

- Read Data API: `ga4:data:read`
- Read Admin API: `ga4:admin:read`
- Write de audience export: `ga4:audience-exports:write`
- Write Admin: `ga4:admin:write`
- Delete/archive Admin: `ga4:admin:destructive`
- Financial: nenhuma capability e nenhuma operação

Manifest permissions são requisitos/audit metadata, não grants. Em contexto
Ravi, reads exigem decisão equivalente a `use app:google-analytics-4`; writes e
destrutivos exigem `execute app:google-analytics-4`, a capability da operação e
confirmação humana declarada no `@CommandAccess`.

## Credencial e segurança

- O cliente aceita somente um envelope com `accessToken` obtido pelo broker
  `google-analytics` em fase posterior.
- Não existe fallback para SDE, arquivo legado ou env var de token.
- Sem conexão, o resolver falha antes de qualquer request de rede.
- Testes injetam apenas `fake-test-token` e `fetch` simulado.
- Erros do Google redigem access token, refresh token e client secret.

## Invariantes

- O app MUST manter `ravi.app/v1` válido e não recursivo.
- Todo comando MUST ter `@CommandAccess`, `@Returns` e `--json`.
- Recursos Admin MUST vir da allowlist versionada e pares método/recurso não
  suportados MUST falhar antes de `fetch`.
- Writes/destrutivos MUST exigir confirmação e permissões distintas.
- O app MUST NOT persistir credencial ou dado de relatório.
- O app MUST NOT executar ou importar o SDE.

## Gaps intencionais

- Onboarding/refresh de OAuth e token real.
- Prova read-only autenticada e comparação de equivalência com `sde ga4`.
- Execução real de writes/destrutivos.
- Substituição ou desativação do legado.

Esses itens pertencem às fases posteriores e não bloqueiam o cadastro nativo
credential-free desta entrega.

## Validation

- `ravi specs get apps/google-analytics-4 --mode rules`
- `ravi apps check google-analytics-4 --json`
- `ravi apps show google-analytics-4 --json`
- `bun test src/apps/google-analytics-4 src/cli/commands/ga4.test.ts`
- `bun run gen:commands`
- `bun run sdk:generate && bun run sdk:check`
- `bun run typecheck && bun run build`
- `bunx biome check src/apps/google-analytics-4 src/cli/commands/ga4.ts src/cli/commands/ga4.test.ts`
