---
id: crm
title: "CRM (pipelines, opportunities, contacts, accounts, events)"
kind: domain
domain: crm
capabilities:
  - pipelines
  - opportunities
  - contact-profiles
  - accounts
  - events
  - multi-agent-pipeline-routing
tags:
  - crm
  - lifecycle
  - sales-funnel
  - customer-success
applies_to:
  - src/contacts.ts
  - src/cli/commands/crm.ts
  - src/plugins/internal/ravi-system/skills/crm/
owners:
  - dev-do-ravi
status: active
normative: true
---

# CRM (pipelines, opportunities, contacts, accounts, events)

## Intent

Camada de relacionamento com cliente do Ravi. Modela contas, contatos, oportunidades (deals), pipelines com stages categorizados, e um ledger append-only de eventos de mutação (`crm_events`). Serve 4+ consumidores: chatbot WhatsApp (atendimento), gerador de conteúdo (campanhas), agentes humanos (visão), e — quando a capability [[multi-agent-pipeline-routing]] estiver entregue — agentes de atendimento dedicados por pipeline.

CRM no Ravi NÃO é fonte de transação financeira. Não substitui Tiny ERP. É camada de **relacionamento + lifecycle**, espelhada/enriquecida por eventos de WhatsApp/Instagram/Ads, com ground truth de catálogo/estoque/financeiro vindo de sistemas externos (ver [[catalog]]).

## Invariants

- **Schema canônico em `src/contacts.ts`** (linhas 389-720): tabelas `crm_events`, `crm_contact_profiles`, `crm_accounts`, `crm_account_contacts`, `crm_pipelines`, `crm_pipeline_stages`, `crm_pipeline_stage_topics`, `crm_opportunities`
- **Lifecycle enum de contato** (`crm_contact_profiles.lifecycle`): `unknown, lead, qualified, active, onboarding, waiting, at_risk, dormant, churned, partner, vendor, internal`
- **Stage category enum** (`crm_pipeline_stages.category`): `new, active, waiting, terminal_won, terminal_lost`. `is_terminal=1` quando category começa com `terminal_*`
- **Opportunity status enum** (`crm_opportunities.status`): `open, won, lost, paused, archived`. Status canonicaliza-se a partir do category do stage destino (ver `opportunityStatusForStage` em `src/contacts.ts`)
- **Append-only ledger**: toda mutação CRM (move stage, change status, edit profile, new account/contact/opportunity, pipeline_stage_topic update) gera 1 row em `crm_events` com `eventType` claro, `actorType`, `confidence`, `evidence`, `source`. Nunca update/delete `crm_events` row existente
- **Multi-channel via `account_id`**: contato pode atender múltiplos chats (DM, group, channel-specific) mas o `account_id` (omni instance) é parte da chave de routing
- **Tags multidim** (`tag_definitions.slug`): padrão `prefixo:valor` consolidado (`bant:comprador`, `clv:alto`, `conv:comprando`, `cobranca:em-aberto`, `cotacao-formal`, etc). Mais de 30 namespaces vivos no DB de produção
- **Skill CRM `ravi-system:crm`** documenta facts (`profile.buying_role`, `opportunity.need`) com workflow `--status proposed|confirmed` pra revisão humana antes de gravar campo forte

## Validation

```bash
# Schema integrity
sqlite3 ~/.ravi/ravi.db ".schema crm_pipelines"
sqlite3 ~/.ravi/ravi.db ".schema crm_pipeline_stages"
sqlite3 ~/.ravi/ravi.db ".schema crm_opportunities"

# CLI surface
ravi crm pipelines list
ravi crm stages list <pipeline-id>
ravi crm opportunities list

# Skill carregada
ravi skills show ravi-system:crm

# Sanity ledger
sqlite3 ~/.ravi/ravi.db "SELECT event_type, COUNT(*) FROM crm_events GROUP BY event_type ORDER BY 2 DESC LIMIT 10"
```

## Known Failure Modes

- **`moveCrmOpportunityStage` grava `crm_events` mas NÃO emite NATS event** (`src/contacts.ts:5765`). Triggers que esperam reagir a `ravi.crm.opportunity.stage_changed` via NATS não rodam hoje. Capability [[multi-agent-pipeline-routing]] § F propõe emit de 5 topics canônicos.
- **Sem mapping pipeline→agent**: hoje não existe coluna `crm_pipelines.assigned_agent_id`. Roteamento mensagem→agente passa por `routes` (pattern + account_id), sem ciência do pipeline ativo do contato. Capability [[multi-agent-pipeline-routing]] § C resolve.
- **Sem auto-progression entre pipelines**: `terminal_won` apenas fecha opportunity. Capability [[multi-agent-pipeline-routing]] § G propõe configuração opt-in via tabela `crm_pipeline_transitions` com DAG enforcement (sem loops).
- **Conflito 2+ opportunities ativas em pipelines distintos**: `crm_contact_profiles.primary_opportunity_id` é tiebreaker canônico. Capability [[multi-agent-pipeline-routing]] § E define função `recomputeContactPrimaryOpportunity` síncrona dentro da mesma transação + setting `crm.primary_opportunity_rule` (default `most_recent_open`).
- **Routes sem selector por tag/stage**: `routes.pattern` é regex de chat-id. Capability [[multi-agent-pipeline-routing]] § D adiciona resolver paralelo não-destrutivo (não altera contrato de `routes`).
- **Sem `crm_pipelines.is_default` constraint por account**: hoje schema permite múltiplos defaults por entity_type. Capability [[multi-agent-pipeline-routing]] § A propõe constraint composto + ALTER pra adicionar `account_id` em `crm_pipelines`.
- **Multi-channel ambiguidade**: contato em múltiplos canais (WhatsApp + Instagram) precisa de merge prévio via `ravi contacts merge` pra `primary_opportunity_id` aplicar consistente cross-channel. Sem merge, são contatos "separados". Esta decisão é arquitetural — contas omni são silos pro CRM.
