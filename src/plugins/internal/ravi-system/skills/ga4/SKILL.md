---
name: ga4
description: |
  Opera o Ravi App nativo Google Analytics 4. Use quando precisar:
  - Consultar relatórios históricos, realtime, ecommerce ou tendências do GA4
  - Descobrir dimensões/métricas e validar compatibilidade
  - Listar recursos e configurações pela Google Analytics Admin API
  - Inspecionar o manifesto, permissões e health do app google-analytics-4
---

# Google Analytics 4

O app `google-analytics-4` usa cliente REST nativo e o CLI `ravi ga4`. O SDE
legado continua disponível como fallback da migração, mas não é chamado pelo app.

## Fluxo canônico

1. Valide o cadastro sem acessar credenciais:

```bash
ravi apps check google-analytics-4 --json
ravi apps show google-analytics-4 --json
```

2. Antes de um report customizado, descubra/valide campos:

```bash
ravi ga4 metadata 0 --json
ravi ga4 check-compatibility <property> \
  --dimensions country --metrics activeUsers --json
```

3. Rode uma leitura limitada:

```bash
ravi ga4 top-pages <property> --days 30 --limit 25 --json
ravi ga4 report <property> --dimensions pagePath \
  --metrics screenPageViews,sessions --start-date 30daysAgo --limit 50 --json
```

Leia o `--help` do subcomando para exemplos, endpoint oficial, impacto, erros e
alternativas. Não improvise resource names ou request bodies fora do contrato.

## Permissões

- Data reads: `ga4:data:read`
- Admin reads: `ga4:admin:read`
- Audience export create: `ga4:audience-exports:write`
- Admin writes: `ga4:admin:write`
- Delete/archive: `ga4:admin:destructive`
- Financial: nenhuma operação

Manifest permissions não concedem acesso. Writes/destrutivos também exigem
`execute app:google-analytics-4` e confirmação humana declarada pelo comando.

## Falhas que exigem ação

- Credencial ausente: pare e peça onboarding de conexão pelo broker Ravi; nunca
  copie token ou arquivo do SDE.
- Dimensão/métrica inválida: rode `metadata` e `check-compatibility`.
- Recurso Admin não suportado: use somente a allowlist mostrada no erro/help.
- Erro do Google: reporte status e mensagem redigida, sem tentar outra scope ou
  operação mutating automaticamente.

## Fase atual

O cadastro, cliente, CLI, permissões e mocks são entregues sem token real. Prova
autenticada read-only, comparação com legado e qualquer mutação real são fases
posteriores e exigem autorização própria.
