---
id: crm/multi-agent-pipeline-routing
title: "Multi-Agent Pipeline Routing (1 agent per CRM pipeline)"
kind: capability
domain: crm
capabilities:
  - multi-agent-pipeline-routing
  - pipeline-agent-mapping
  - cross-pipeline-handoff
  - context-rich-handoff
  - agent-availability-fallback
  - opportunity-promotion-rules
  - opportunity-creation-flow
tags:
  - crm
  - routing
  - multi-agent
  - lifecycle
  - sales-funnel
  - customer-success
  - rebac
  - migration
applies_to:
  - src/contacts.ts
  - src/router/router-db.ts
  - src/router/resolver.ts
  - src/router/sessions.ts
  - src/cli/commands/crm.ts
  - src/cli/commands/agents.ts
  - src/cli/commands/routes.ts
  - src/tasks/service.ts
  - src/triggers/topic-catalog.ts
  - src/permissions/scope.ts
  - src/plugins/internal/ravi-system/skills/crm/
owners:
  - dev-do-ravi
status: draft
normative: true
---

# Multi-Agent Pipeline Routing (1 agent per CRM pipeline)

## Intent

Permitir que o Ravi atenda clientes via **1 agente dedicado por pipeline do CRM**, com **handoff rico de contexto** entre agentes quando o cliente "muda de etapa do funil". Cada pipeline tem um agente especializado: "boas-vindas" qualifica/descobre; "vendas" apresenta/fecha; "pós-venda" faz onboarding/expansão; "retenção" lida com churn — nomes e quantidade são definidos por conta (account), não hardcoded.

Resolve 3 problemas concretos do estado atual:
1. **Especialização inexistente**: hoje 1 agente principal atende cliente independente do estágio do relacionamento. Especialização por pipeline melhora qualidade (descoberta ≠ fechamento ≠ retenção)
2. **Transições CRM não disparam reação**: `moveCrmOpportunityStage` grava `crm_events` mas **não emite NATS event** → triggers que esperam reagir a stage-change não rodam (`src/contacts.ts:5765`)
3. **Routing cego ao CRM**: hoje `routes` matcha por `pattern + account_id`, sem ciência do pipeline ativo do contato (`src/router/router-db.ts:1010`)

**Pattern de mercado** (2026 — HubSpot Breeze, Drift, Intercom Fin, MindStudio): orchestrator-worker com agents especializados. HubSpot tem 4 agents fixos por domínio (Customer/Prospecting/Content/Knowledge). Esta capability adota a variante **per-pipeline** — alinhada ao funil de cada cliente. Handoff entre agentes SEMPRE com contexto rico (summary + history + next step), nunca transcript raw.

**See:** `docs/proposals/crm-multi-agent-pipeline-routing-prd.md` (PRD humano-legível a criar antes da implementação Fase 1, per AGENTS.md B.14).

---

## Invariants

### A. Pipeline Configuration (resolve gap #1)

- **`crm_pipelines.is_default`**: já existe na schema. Constraint NOVA — apenas **1 default por `(account_id, entity_type)`** simultâneo. Hoje schema não tem `account_id` em `crm_pipelines` → ALTER necessário pra suportar multi-account (default config = `'default'` pra back-compat)
- **Pipeline de entrada**: contato NOVO sem opportunity → trigger cria opportunity no pipeline `is_default=1 AND entity_type='opportunity'` da SUA account. Sem default configurado → contato fica `lifecycle='unknown'`, sem opportunity, atendido por route default (comportamento atual)
- **Pipeline nomeado em PT-BR ou EN, livre por conta**: spec não enforça "boas-vindas / vendas / pos-venda". Convenção apenas: `crm_pipelines.name` é display, `crm_pipelines.slug` (a adicionar) é stable identifier `[a-z0-9-]+`, único por account

### B. Opportunity Creation Flow (resolve gap #2)

- **Trigger canônico** para criar opportunity inicial: `ravi.contacts.contact.created` (verificar se existe no topic catalog; se não, adicionar). Handler:
  - Lê `account_id` do contato
  - Busca `crm_pipelines.is_default=1 AND account_id=<X>` (ou `account_id='default'` fallback)
  - Cria opportunity em stage `category='new'` (primeiro stage por `sort_order`) com `primary_contact_id=<contact.id>`
  - Atualiza `crm_contact_profiles.primary_opportunity_id` pra essa opportunity
- **Trigger é opt-in via setting**: `crm.auto_create_opportunity_on_contact_created=true|false`. Default `false` na Fase 1 (mudança opt-in conscientemente). Operadores ativam quando quiserem
- **Path manual continua valendo**: `ravi crm opportunities create` segue funcionando pra criar manualmente. Trigger não substitui — coexiste

### C. Pipeline-Agent Mapping

- **`crm_pipelines.assigned_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL`** — coluna NOVA via lazy ALTER TABLE (padrão Ravi sem migration files)
- **CLI canônica**: `ravi crm pipelines assign-agent <pipeline-id> <agent-id>` opera o mapping. `--unassign` zera
- **Não exclusivo**: 1 agente PODE estar em N pipelines (MVP comum: mesmo agent cobre boas-vindas + qualificação). Spec não restringe — operadores controlam via CLI
- **NULL = "usa route padrão"** (back-compat). Sem mapping configurado, routing cai pro resolver tradicional. Isso permite ativação progressiva sem big-bang

### D. Roteamento Mensagem→Agente (resolve gap parcial: dependência clara)

Resolver paralelo, **não-destrutivo**, em `src/router/resolver.ts`:
- Nova função `resolveAgentByContactPrimaryOpportunity(contactId, accountId): string | null`
  1. Lookup `crm_contact_profiles.primary_opportunity_id` (filtrado por `account_id`)
  2. → `crm_opportunities.pipeline_id`
  3. → `crm_pipelines.assigned_agent_id`
  4. Validação: agente existe + ativo (ver § Agent Availability) + REBAC (ver § REBAC)
  5. Retorna `agent_id` ou `null`

**Ordem de precedência final** no `resolver.resolveRoute`:
1. Route explícita (existing `routes.pattern + account_id`, ordenada por `priority` desc)
2. `resolveAgentByContactPrimaryOpportunity` (CRM-aware)
3. Default agent do account (fallback existente)

Mensagem do mesmo contato em canais distintos (WhatsApp + Instagram) usa o MESMO `contact_id` (assumindo merge prévio via `ravi contacts` — fora do escopo desta capability). Routing por pipeline é **canal-agnóstico** dentro do mesmo account. Cross-account exige `account_id` match (não compartilha primary_opportunity).

### E. Primary Opportunity Promotion (resolve gap #3)

- **Schema**: `crm_contact_profiles.primary_opportunity_id` é o ground truth de "qual opportunity define o agente que atende". Já existe na schema
- **Regra default** (sem setting configurado): **most_recently_updated** entre opportunities com `status='open'`. Quando opportunity é criada/movida, função `recomputeContactPrimaryOpportunity(contactId)` roda **sincronicamente** dentro da mesma transação:
  ```sql
  UPDATE crm_contact_profiles SET primary_opportunity_id = (
    SELECT id FROM crm_opportunities 
    WHERE primary_contact_id = ? AND status = 'open'
    ORDER BY updated_at DESC LIMIT 1
  ) WHERE id = ?
  ```
- **Setting configurável**: `crm.primary_opportunity_rule = "most_recent_open" | "highest_value" | "most_advanced_pipeline"`. Default na Fase 1: `most_recent_open` (mais simples, comportamento previsível). Outras regras como Fase 4
- **Mudança manual**: `ravi crm contacts set-primary <contact-id> <opportunity-id>` força override. Idempotente. Recompute SKIP até next opportunity create/move
- **Zero opportunities abertas**: primary_opportunity_id = NULL → cai pro fallback de route default

### F. NATS Events Canônicos pra Transições CRM

`moveCrmOpportunityStage` (`src/contacts.ts:5737`) MUST emitir, **DEPOIS** da gravação no DB e no ledger `crm_events`:

- `ravi.crm.opportunity.stage_changed` (sempre — payload inclui pipeline anterior + novo, even se mesmo pipeline)
- `ravi.crm.opportunity.status_changed` (apenas quando `previous.status !== next.status`)
- `ravi.crm.opportunity.converted` (apenas quando `category='terminal_won'`)
- `ravi.crm.opportunity.lost` (apenas quando `category='terminal_lost'`)
- `ravi.crm.contact.primary_opportunity_changed` (quando `recomputeContactPrimaryOpportunity` altera o valor)

**Topic catalog** (`src/triggers/topic-catalog.ts`) MUST registrar os 5 topics como `category: 'crm'` para serem subscríveis por triggers/observers.

**Idempotência**: emit é fire-and-forget (consistente com [[runtime]] — NATS pub/sub sem persistence). Triggers MUST tolerar duplicação via `correlationId` (event ID do `crm_events` insert) ou state-check.

**Sem retro-emit**: eventos passados (`crm_events` históricos) NÃO são reemitidos. Quem precisar de replay reconstrói do ledger DB.

### G. Auto-Progression Entre Pipelines (opt-in)

- **Tabela nova**: `crm_pipeline_transitions(id, account_id, from_pipeline_id, from_terminal_category, to_pipeline_id, auto_create_opportunity INTEGER DEFAULT 1, copy_facts INTEGER DEFAULT 1, copy_account_link INTEGER DEFAULT 1, created_at, updated_at, UNIQUE(account_id, from_pipeline_id, from_terminal_category))`
- **Trigger handler** de `ravi.crm.opportunity.converted` / `.lost`:
  1. Consulta `crm_pipeline_transitions` por `(account_id, from_pipeline_id, terminal_category)`
  2. Hit + `auto_create_opportunity=1`:
     - Cria opportunity em `to_pipeline_id`, stage `category='new'` (primeiro por sort_order)
     - `copy_facts=1` → copia `last_summary`, `next_action_at`, `next_task_id` da opportunity origem
     - `copy_account_link=1` → herda `account_id`, `primary_account_id`
     - `recomputeContactPrimaryOpportunity(contact_id)` → handoff de routing automático
     - Cria task no novo agent via `ravi tasks create --agent <X> --profile handoff-rich`
  3. Miss → terminal apenas fecha (comportamento atual, back-compat)
- **Anti-loop**: `crm_pipeline_transitions.from_pipeline_id ≠ to_pipeline_id` constraint + DFS check na criação (DAG enforcement)
- **CLI**: `ravi crm transitions create/list/show/delete`

### H. Handoff Rico de Contexto (resolve gap #5 — memory cross-pipeline)

Task de handoff MUST conter no `instructions`:
- **Summary** da fase anterior — agente antigo deve escrever via `ravi tasks done --summary "..."` na sua última task ativa. Se sem summary, usa `crm_opportunities.last_summary` ou último `crm_events.payload.outcome`
- **Facts CRM** completos via skill `ravi-system:crm`: lifecycle, buying-role, priority, needs, objections, next-action, owner
- **Últimas N mensagens** (default 10, configurável via setting `crm.handoff_message_window`) do `chat_messages` do contact, com `timestamp` e `actor_type`
- **Próximas ações sugeridas** baseadas no pipeline destino (vindo da skill do pipeline)

**Profile task `handoff-rich`** (novo, em `src/tasks/profiles.ts`):
- `required_inputs`: `from_pipeline_id`, `to_pipeline_id`, `contact_id`, `opportunity_id`
- `optional_inputs`: `summary`, `next_action_hint`
- `template` puxa contexto descrito acima

**Memory continuity**:
- Sessão do agente ANTIGO **não morre** quando primary_opportunity muda. Histórico persiste em `chat_messages`
- Próximo turn do cliente é roteado pro agente NOVO (per § D), mas agente antigo pode ser explicitamente acionado via `ravi sessions send <session-name>` (rara — uso humano)
- Se cliente VOLTAR a falar tema do pipeline antigo (ex: dúvida pós-venda sobre algo de pré-venda), skill do agente NOVO carrega skill auxiliar do pipeline antigo via skill-gate por trigger word — não troca de agent_id (ver § J)

### I. Skills Por Pipeline (resolve gap #11 — slug convention)

- **1 skill markdown por pipeline** em `src/plugins/internal/ravi-system/skills/pipeline-<slug>/SKILL.md`
- **Slug convention**: `[a-z0-9-]+`, mesmo slug usado em `crm_pipelines.slug`. Comprimento 2-32 chars
- **Reservados** (não-permitidos como slug por causa de colisão com skill-gate names): `tasks`, `crm`, `agents`, `sessions`, `routes`, `default`
- **Validação**: `ravi crm pipelines create --slug <X>` rejeita slug reservado ou inválido
- **Cada skill MUST**:
  - Definir `description` com trigger words (ativam skill via skill-gate por palavra-chave)
  - Reusar `ravi-system:crm` via `wf optimize` (importa skill canônica)
  - Definir prompts de tom + scripts de descoberta/qualificação/fechamento conforme propósito do pipeline
- **Skill-gate entries**: `skill_gate_rules` ganha entries que carregam `pipeline-<slug>` quando agente do pipeline X chama tool `crm:opportunities_show` filtrada por `pipeline_id=<X>`

### J. Skill Conflict Resolution (cross-pipeline relevance)

Quando agente de pipeline X recebe mensagem sobre tema de pipeline Y:
- Skill-gates monitoram trigger words globais. Ex: skill `pipeline-pos-venda` carrega quando palavra "rastreio", "garantia", "troca", "devolução" aparece
- Skill auxiliar é carregada **temporariamente** (apenas pro turn), não troca `agent_id`. Cliente continua atendido pelo mesmo agente
- Agente principal recebe contexto suplementar + escolhe responder OU escalar. Escalação manual via `ravi tasks create --agent <Y> --profile handoff-rich` (mesmo profile do auto-handoff)

### K. Agent Availability + Fallback (resolve gap #4 — agente offline/deletado)

Resolver `resolveAgentByContactPrimaryOpportunity` validação:
1. **Agente existe**: `agents.id` SELECT → não null
2. **Agente ativo**: campo NOVO `agents.enabled INTEGER DEFAULT 1` (ALTER TABLE). Disabled = pula esse mapping
3. **Agente tem REBAC** pra `crm:read_opportunity` (ver § L)

Falhas → resolver retorna `null` → cai pro fallback chain (route explícita → default agent). NUNCA bloqueia mensagem.

**CLI**: `ravi agents disable <agent-id>` / `enable`. Disable é soft (atributo); delete é destrutivo (HITL).

**ON DELETE SET NULL** em `crm_pipelines.assigned_agent_id`: se agente é deletado, pipelines automaticamente perdem mapping → roteamento cai pro fallback.

**Notificação operacional**: `agents.disabled` por > 5min com pipelines mapeados → trigger `ravi.crm.pipeline.orphaned` notifica operador (sem bloquear cliente).

### L. REBAC Mínima Obrigatória (resolve gap #12 — promovido de "futuro" pra Fase 1)

Cada agente de pipeline MUST ter, no mínimo, REBAC:
- `crm:read_contact` — ler perfil de qualquer contato roteado pra ele
- `crm:read_opportunity` — ler opportunity do pipeline dele
- `crm:write_opportunity_in_pipeline:<pipeline-id>` — mover stage/atualizar campos da opportunity **DESTE** pipeline apenas (granular)
- `chats:read_messages_for_contact` — histórico de mensagens
- `tasks:create` / `tasks:done` / `tasks:fail` / `tasks:block` — operar próprio inbox
- `tags:apply` / `tags:remove` (com namespace allowlist) — tagear conforme regras do pipeline

REBAC adicional condicional:
- `crm:write_opportunity_across_pipelines` — pode mover opportunity de um pipeline pra outro (necessário pra agentes de "triagem" ou "escalation")
- `crm:read_cross_pipeline_history` — ler histórico de pipelines anteriores do mesmo contato (default ON pra MVP; pode virar OFF + handoff-summary-only no futuro)

Quando `assign-agent` é chamado, CLI **valida** que o agente tem REBAC mínima. Se faltar, prompt avisa: `ravi permissions grant --agent <X> --grant crm:read_opportunity ...` antes de prosseguir.

### M. Opportunity Pause/Resume (resolve gap #6)

- Opportunity com `status='paused'` é IGNORADA pelo `recomputeContactPrimaryOpportunity` (ordena só `status='open'`)
- Cliente com APENAS opportunities pausadas + 0 abertas → primary_opportunity_id = NULL → routing cai pro fallback
- Pausa explícita: `ravi crm opportunities pause <id> --reason "..."` muda status. Emite `ravi.crm.opportunity.paused`
- Resume: `ravi crm opportunities resume <id>` muda pra open. Emite `ravi.crm.opportunity.resumed`. **Recompute** + handoff considerados na próxima mensagem
- **Reading-list** do agente filtra `primary_opportunity.status='open'` → pausados desaparecem da fila automaticamente

### N. Escalação Humano-on-Demand (resolve gap #7)

- Skill universal `escalation-human` (a criar) com trigger words: "quero falar com gente", "atendente humano", "pessoa real", "supervisor"
- Detecta intent → cria task pro agente de fallback humano configurado em `crm_pipelines.escalation_agent_id` (nova coluna, opcional). Se NULL, usa default agent do account
- Task tem profile `escalation-rich` (variante de `handoff-rich` com `urgency='high'`)
- Bot responde imediatamente "Vou te transferir pra equipe, X minutos" — não bloqueia
- Histórico fica completo pro humano ver via reading-list de escalation

### O. Multi-Channel Coherence (resolve gap #8)

- Routing por pipeline é **canal-agnóstico** dentro do mesmo `account_id`. Cliente atende via WhatsApp E Instagram com mesmo agente do pipeline ativo
- Quando contact é mergeado de canais distintos (operação `ravi contacts merge` — fora do escopo), `primary_opportunity_id` único = mesmo pipeline = mesmo agente
- Se canais distintos têm `account_id` diferente, são clientes "separados" do POV do CRM. Esta capability NÃO une cross-account (decisão de produto: contas omni são silos)

### P. Load Balancing + Agent Capacity (resolve gap #9)

- Campo NOVO `agents.max_concurrent_open_opportunities INTEGER DEFAULT NULL` (NULL = ilimitado)
- Resolver verifica: se agente do pipeline já tem `>= max` opportunities open atribuídas, **não roteia mais novas**, cai pro fallback. Opportunities EXISTENTES continuam sendo atendidas pelo mesmo agente
- CLI `ravi agents set-capacity <agent-id> <N>`
- Telemetria: `ravi.crm.agent.capacity_reached` event quando hit. Trigger pode escalar pra operador
- **MVP**: NULL default. Capacity é opt-in. Operadores ativam quando vir saturação

### Q. Migration Path Pra Clientes Existentes (resolve gap #10)

- **Lazy assign on next message** (default): contato sem opportunity → próxima mensagem → trigger contact updated check → se pipeline default existe + auto_create_opportunity_on_contact_created=true → cria opportunity. Caso contrário, contato fica como hoje
- **Backfill em lote** (opt-in): `ravi crm migrate backfill-opportunities --account <id> --dry-run` lista contatos sem opportunity ativa, mostra plano. `--apply` executa em batches transacionais com idempotência
- **Manual**: operador cria opportunity normal via `ravi crm opportunities create` quando quiser. Routing automático começa do próximo turn
- Migration NÃO é obrigatória. Esta capability é coexistência — sistemas que não usam pipeline routing continuam funcionando

### R. Next-Action Integration (resolve gap #13)

- `crm_contact_profiles.next_action_at` + `next_task_id` JÁ existem
- Handoff task automaticamente atualiza:
  - `crm_contact_profiles.next_task_id` = ID da nova task
  - `crm_contact_profiles.next_action_at` = task `due_at` ou `created_at + setting('crm.default_next_action_delay', '1h')`
- Quando agente do pipeline destino faz `ravi tasks done`, hook atualiza `next_action_at` pra próxima ação inferida (pelo profile da task) OU NULL se finalizou
- **Reading-list** filtra `primary_opportunity.next_action_at <= now()` — agente vê fila ordenada por próximo SLA

### S. Metrics Schema (resolve gap #14)

Eventos canônicos pra telemetria (subscritíveis via NATS, agregáveis via `ravi-cli analytics`):
- `ravi.crm.opportunity.stage_changed` (já em § F) — input pra "tempo médio por stage", "abandono entre stages"
- `ravi.crm.opportunity.converted` / `.lost` (já em § F) — input pra "conversion rate por pipeline"
- `ravi.crm.contact.primary_opportunity_changed` (já em § F) — input pra "handoff frequency", "agent ownership churn"
- `ravi.crm.handoff.task_created` (NOVO) — emit pelo trigger handler com `from_agent_id`, `to_agent_id`, `pipeline_from`, `pipeline_to`, `contact_id`, `correlation_id` — input pra "handoff latency", "handoff coverage por agente"
- `ravi.crm.agent.capacity_reached` (NOVO) — emit por resolver quando cap hit — input pra alertas de saturação

Tabela agregada `crm_pipeline_daily_metrics` (NOVA, populada por cron `ravi crm rollup` diário):
- `(account_id, pipeline_id, date)` PK composto
- `opportunities_opened`, `opportunities_won`, `opportunities_lost`, `opportunities_paused`
- `avg_time_in_pipeline_seconds`, `conversion_rate`, `loss_reason_top3_json`
- `handoff_count_in`, `handoff_count_out`

CLI `ravi crm analytics --pipeline <id> --since 7d` consulta agregados.

### T. Reading-Lists Dependency Resolution (resolve gap estratégico #15)

- Spec `channels/chats/reading-lists` está `status: draft`. Esta capability depende de reading-lists pra operação plena (Fase 3)
- **Fase 1+2 desta capability NÃO depende** de reading-lists. Mapping + routing + handoff funcionam sem reading-list (agente lê inbox via `ravi tasks list --mine` tradicional)
- **Fase 3 esta capability**: pré-requisito = reading-lists virar `status: active`. Se não virar, esta capability fica funcional mas sem reading-list operacional (agente trabalha via tasks)
- Reading-lists `status: draft` NÃO é blocker pra Fase 1. Spec destra capability documenta dependência mas não bloqueia

---

## Validation

```bash
# Fase 1 — Foundation
sqlite3 ~/.ravi/ravi.db ".schema crm_pipelines" | grep assigned_agent_id  # exists?
ravi crm pipelines assign-agent <pipeline-id> <agent-id>
ravi crm pipelines list --json | jq '.[].assigned_agent_id'  # not all null

# Test resolver
ravi self whoami --as-contact <contact-id>  # report agent of primary opp pipeline
bun test src/router/resolver.test.ts -t "primary opportunity routing"
bun test src/router/resolver.test.ts -t "fallback to default route"
bun test src/router/resolver.test.ts -t "respects agent disabled state"
bun test src/router/resolver.test.ts -t "respects agent capacity cap"

# NATS events flowing
ravi crm opportunities move-stage <id> --stage <won-stage-id>
# Subscribe via temporary listener:
timeout 5 bun -e "import {nats} from './src/nats.js'; for await (const e of nats.subscribe('ravi.crm.>')) console.log(e.subject, e.data)"

# Primary opportunity recompute
ravi crm opportunities create --contact <X> --pipeline <Y>  # creates new opp
sqlite3 ~/.ravi/ravi.db "SELECT primary_opportunity_id FROM crm_contact_profiles WHERE id=?"  # should match new opp

# Fase 2 — Handoff
ravi crm transitions create --account default --from boas-vindas --terminal won --to vendas
ravi crm opportunities move-stage <id-boas-vindas> --stage <won-stage-id>
# Within 200ms:
ravi tasks list --tag pipeline-handoff --since 1m  # should have new task

# REBAC
ravi permissions list --agent <pipeline-vendas-agent>  # must include crm:read_opportunity
ravi permissions check --agent <X> --can crm:write_opportunity_in_pipeline:<id>

# Fase 3 — Operational
ravi skills show pipeline-vendas
ravi skill-gates explain --agent <vendas-agent> --tool crm:opportunities_show
ravi reading-lists explain <list-id-pipeline-vendas>

# Fase 4 — Migration + Hardening
ravi crm migrate backfill-opportunities --account default --dry-run
ravi crm analytics --pipeline <id> --since 7d
sqlite3 ~/.ravi/ravi.db "SELECT * FROM crm_pipeline_daily_metrics WHERE pipeline_id=? ORDER BY date DESC LIMIT 7"

# E2E smoke
bun test src/contacts.test.ts -t "multi-agent pipeline routing"
ravi tasks create --agent dev-do-ravi --profile smoke-test "e2e multi-agent routing"
```

---

## Known Failure Modes

- **NATS sem persistence** (per spec `runtime/`): trigger handler offline na hora do emit `crm.opportunity.converted` perde auto-progression. Mitigação: cron `ravi crm reconcile-orphan-transitions` (diário) cruza `crm_opportunities.status='won'` recente com ausência de opportunity sucessora pra transição CONFIGURADA. Reconciliação **CRM-CRM**, não watchdog de runtime
- **Race entre `moveCrmOpportunityStage` e handoff task**: opportunity convertida → trigger cria task → mas próxima mensagem do cliente chega ANTES da task aparecer. Solução: task creation MUST ser INLINE/síncrona dentro do handler de `converted` (não async). Latência alvo < 100ms
- **Cliente sem `primary_opportunity_id`** (zero opens): recompute zera NULL → routing cai pro fallback default. Bot continua respondendo (default agent), mas sem skill especializada. Operacionalmente OK pra MVP — cliente "esquecido" eventualmente recebe mensagem que ativa trigger de criação de opportunity (se setting habilitado) ou fica pendente até ação manual
- **Auto-progression em loop**: DAG enforcement no `crm_pipeline_transitions` create (constraint `from ≠ to` + DFS no insert). Falha de DFS rejeita criação. Constraint trigger SQL adicional pra runtime (caso seja inserido via raw SQL): `BEFORE INSERT` checa cycle
- **Reading-list desatualizada após `primary_opportunity_id` change**: capability não controla refresh de reading-list. Spec `reading-lists` precisa cursor reactive (fora do escopo). Workaround MVP: reading-list recomputa a cada tick (60s) — delay max 60s pra agente novo ver cliente na fila
- **Mensagem recebida durante janela handoff** (window entre converted → task pro novo agente criada): resolver precisa do recompute SINCRONICAMENTE. Se feito async, há janela onde mensagem é roteada pro AGENT ANTIGO. Mitigação: `crm_contact_profiles.handoff_state` enum `'idle' | 'pending_routing'`. Set `'pending_routing'` no início do handler de `converted`, cleared quando task criada. Mensagem em pending_routing → bot responde "vou transferir você" + queue até cleared
- **Skill conflict cross-pipeline**: skill-gate por trigger word pode carregar skill errada (false positive em palavras genéricas). Mitigação: cada pipeline declara EXACT trigger words (case-insensitive, word boundary). Tests `bun test src/plugins/internal/ravi-system/skills/pipeline-*/` cobrem matching matrix
- **Tag-rules vs pipeline routing** (ambos podem ditar comportamento): coexistem. Routing por pipeline é a CAMADA NOVA; tags continuam pra automações ortogonais (campanhas, segmentação ads, dashboards). Se tag e pipeline divergem ("cobranca:em-aberto" tag mas opportunity em "pos-venda"), routing usa pipeline (consistente com primary_opportunity). Tag fica como sinal informacional pra skill do agente
- **REBAC drift**: operador esquece de dar REBAC mínima ao novo agente. CLI `assign-agent` MUST validar e prompts pra grant. Se forçado via raw SQL UPDATE, agente bloqueia em runtime com `permission_denied` (já existe pattern Ravi)
- **Agente exclusivo bloqueia múltiplos pipelines**: 1 agente cobrindo boas-vindas + vendas hits capacity → 2 pipelines param. Mitigação: capacity cap por agente é warning, não bloqueio total. Resolver pula só novas atribuições; existentes continuam. Operador adiciona outro agente ou aumenta cap
- **Migration backfill em lote causa pico de criação**: 10k contatos → 10k opportunities criadas → 10k NATS events → 10k recomputes. Pode saturar pool runtime. Mitigação: `--batch-size N` (default 100) + sleep entre batches. Telemetria via `ravi.crm.migration.batch_completed` event
- **Privacidade cross-pipeline** (gap LGPD/GDPR potencial): agente pós-venda ve histórico de pré-venda. Default MVP: full history visible (operador é dono da decisão). Roadmap: REBAC `crm:read_cross_pipeline_history` granular + setting `crm.cross_pipeline_history_default = 'full' | 'summary_only'`
- **Escalation human bot loop**: cliente diz "quero humano" → skill detecta → task criada. Mas se bot anterior também respondeu primeiro com mensagem genérica, cliente sente "bot insistindo". Mitigação: skill `escalation-human` SUPPRIME outras skills temporariamente (skill-gate prioridade alta) + bot responde SÓ "transfiro você agora"
- **Slug collision com skill-gates**: pipeline slug `tasks` colide com `ravi-system:tasks` skill. Validação CLI rejeita reserved words (§ I)
- **Account_id NULL em legacy data**: contatos antigos sem account_id explícito → caem em `'default'` por convenção. Esta capability assume `default` account existe (criar em bootstrap se ausente)

---

## Implementation Phases

### Fase 1 — Foundation (auth-required, blocking)

- ALTER TABLE `crm_pipelines` ADD `assigned_agent_id`, `slug`, `account_id`, `escalation_agent_id`
- ALTER TABLE `crm_contact_profiles` ADD `handoff_state`
- ALTER TABLE `agents` ADD `enabled`, `max_concurrent_open_opportunities`
- Constraint composto unique `(account_id, is_default)` quando entity_type='opportunity'
- Reserved-words validação em slug
- `moveCrmOpportunityStage` ganha 4 NATS emits
- `recomputeContactPrimaryOpportunity` síncrona dentro de mesma transaction
- Topic catalog entries
- Resolver paralelo + fallback chain (com agent availability + capacity check)
- REBAC mínima validation no `assign-agent`
- CLI: `ravi crm pipelines assign-agent`, `ravi agents disable/enable`, `ravi agents set-capacity`
- Unit + integration tests
- **Sem auto-progression ainda. Sem skills por pipeline. Sem reading-lists.**

### Fase 2 — Handoff (depende Fase 1)

- Tabela `crm_pipeline_transitions` + DAG enforcement
- Trigger handler de `crm.opportunity.converted` / `.lost`
- Profile task `handoff-rich` e `escalation-rich`
- `crm_contact_profiles.handoff_state` lifecycle
- CLI: `ravi crm transitions create/list/show/delete`
- Test e2e: criar opp → mover terminal_won → confirma nova opp + task + handoff_state ciclo

### Fase 3 — Operational (skills + reading-lists)

- 3-5 skill templates (boas-vindas, vendas, pos-venda, escalation-human, retenção)
- Skill-gate entries com trigger words
- Reading-lists dinâmicas por pipeline (pré-requisito: reading-lists `active`)
- Skill `escalation-human` universal

### Fase 4 — Hardening + Migration

- Cron `ravi crm reconcile-orphan-transitions` (boot sweep)
- REBAC `crm:read_cross_pipeline_history` granular + setting
- Setting `crm.primary_opportunity_rule` (most_recent_open | highest_value | most_advanced_pipeline)
- Setting `crm.handoff_message_window`, `crm.default_next_action_delay`
- Migration CLI: `ravi crm migrate backfill-opportunities`
- Metrics schema: `crm_pipeline_daily_metrics` + `ravi crm rollup` cron + `ravi crm analytics`
- Telemetria adicional: `ravi.crm.handoff.task_created`, `ravi.crm.agent.capacity_reached`
- Dashboard "quantos clientes em cada pipeline + qual agente atende + KPIs"
