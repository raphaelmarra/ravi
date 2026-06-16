#!/usr/bin/env bun
// sde-regua-pre-vencimento — régua pré-vencimento de boletos SDE
//
// Orquestrador domain-specific (jarvis-financ). Wraps:
//   sde bancointer boletos          — fonte dos boletos A_RECEBER
//   sde tiny conta-receber <id>     — resolve seuNumero → telefone/nome
//   ravi contacts find|show|add|tag — sincroniza tags boleto:* no Ravi
//
// Spec: /home/ravi/main-kimi/specs/sde-regua-pre-vencimento.md §4.1
// Operação: cron diário 6h BRT no jarvis-financ
//
// Modelo: um contato pode ter vários boletos com vencimentos distintos.
// O CLI agrupa boletos por telefone, calcula a tag mais crítica do grupo
// e aplica APENAS essa tag por contato, removendo as tags boleto:*
// obsoletas. Idempotência é via tags atuais do contato (policy.tags),
// não via log.
//
// Prioridade entre tags: lida em runtime do metadado do pipeline
// crm_pipeline_1d1139c4265c (regua_tags[].priority) via
// `ravi crm pipeline show <id> --json`. Entradas com priority null são
// ignoradas (ex.: cobranca:em-aberto pertence ao pós-vencimento). Falha
// loud se metadado estiver indisponível ou incompleto — a régua não
// pode operar com priorities stale ou desconhecidas.
//
// Subcomandos:
//   preview   dry-run; lista grupos por contato e o que seria feito
//   apply     aplica tags + cria contatos + escreve JSONL
//   status    resumo do último run a partir do JSONL

import { Command } from "commander";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const LOG_DIR = join(homedir(), ".ravi", "jarvis-financ");
const LOG_FILE = join(LOG_DIR, "regua-pre-vencimento.log");
const VERSION = "0.3.0";
const PIPELINE_ID = process.env.SDE_COBRANCA_PIPELINE_ID ?? "crm_pipeline_1d1139c4265c";

type Tag = "boleto:emitido" | "boleto:vence-em-2d" | "boleto:vence-hoje";
const ALL_TAGS: Tag[] = ["boleto:emitido", "boleto:vence-em-2d", "boleto:vence-hoje"];
type TagRank = Record<Tag, number>;

interface BoletoCobranca {
	codigoSolicitacao: string;
	seuNumero: string;
	situacao: string;
	dataEmissao?: string;
	dataVencimento: string;
	valorNominal: string;
	pagador: { nome: string; cpfCnpj: string };
}

interface BoletosResp {
	success?: boolean;
	data?: {
		cobrancas?: Array<{ cobranca: BoletoCobranca }>;
	};
}

interface TinyContaResp {
	retorno?: {
		status?: string;
		conta?: {
			id?: string;
			vencimento?: string;
			valor?: string;
			cliente?: {
				nome?: string;
				cpf_cnpj?: string;
				fone?: string;
			};
		};
	};
}

interface RaviContactsFindResp {
	query: string;
	total: number;
	contacts: Array<{
		id?: string;
		canonicalIdentity?: string;
		primaryIdentity?: string;
		name?: string;
		displayName?: string;
		tags?: string[];
	}>;
}

interface RaviContactsShowResp {
	found?: boolean;
	target?: string;
	contact?: { id?: string; displayName?: string };
	policy?: { tags?: string[] };
}

interface ReguaTagEntry {
	tag?: string;
	priority?: number | null;
}

interface RaviCrmPipelineShowResp {
	pipeline?: {
		id?: string;
		name?: string;
		metadata?: {
			regua_tags?: ReguaTagEntry[];
		};
	};
}

interface BoletoItem {
	codigoSolicitacao: string;
	seuNumero: string;
	pagador_nome: string;
	cpf_cnpj: string;
	valor: string;
	data_vencimento: string;
	dias_ate_venc: number;
	tag_alvo: Tag | null;
	skip_reason: string | null;
	telefone_raw: string | null;
	telefone_norm: string | null;
	tiny_warning: string | null;
}

interface ContactGroup {
	telefone_norm: string;
	contato_existe: boolean;
	contato_id: string | null;
	contato_nome_existente: string | null;
	pagador_nomes: string[];
	current_boleto_tags: Tag[];
	boletos: BoletoItem[];
	tag_alvo: Tag;
	tags_a_remover: Tag[];
	needs_apply: boolean;
	warning: string | null;
}

interface BoletoSkip {
	boleto: BoletoItem;
	reason: string;
}

interface Plan {
	today: string;
	janela_fim: string;
	groups: ContactGroup[];
	skipped: BoletoSkip[];
}

interface LogEntry {
	ts: string;
	run_id: string;
	run_date: string;
	action:
		| "run-start"
		| "run-end"
		| "tag-applied"
		| "tag-noop"
		| "tag-removed"
		| "contact-created"
		| "boleto-skipped"
		| "group-skipped"
		| "warn"
		| "error";
	dry_run: boolean;
	codigoSolicitacao?: string;
	seuNumero?: string;
	telefone?: string;
	nome?: string;
	dias_ate_venc?: number;
	tag_alvo?: Tag | null;
	tags_removidas?: Tag[];
	idempotency_key?: string;
	message?: string;
	[k: string]: unknown;
}

// ---------- subprocess helpers ----------

function runCmd(
	bin: string,
	args: string[],
	opts: { timeoutMs?: number } = {},
): { code: number; stdout: string; stderr: string } {
	const res = spawnSync(bin, args, {
		encoding: "utf-8",
		timeout: opts.timeoutMs ?? 90_000,
		stdio: ["ignore", "pipe", "pipe"],
	});
	return {
		code: res.status ?? 1,
		stdout: res.stdout ?? "",
		stderr: res.stderr ?? "",
	};
}

function jsonCmd<T>(bin: string, args: string[]): T {
	const r = runCmd(bin, [...args, "--json"]);
	if (r.code !== 0) {
		throw new Error(`${bin} ${args.join(" ")} exit ${r.code}: ${r.stderr.trim().slice(0, 600)}`);
	}
	const out = r.stdout.trim();
	if (!out) throw new Error(`${bin} ${args.join(" ")} returned empty stdout`);
	try {
		return JSON.parse(out) as T;
	} catch (e) {
		throw new Error(`${bin} ${args.join(" ")} bad JSON: ${(e as Error).message}`);
	}
}

// ---------- dates ----------

function todayISO(): string {
	const d = new Date();
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${y}-${m}-${day}`;
}

function addDaysISO(date: string, days: number): string {
	const d = new Date(`${date}T00:00:00`);
	d.setDate(d.getDate() + days);
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${y}-${m}-${day}`;
}

function diffDays(target: string, base: string): number {
	const t = new Date(`${target}T00:00:00`).getTime();
	const b = new Date(`${base}T00:00:00`).getTime();
	return Math.round((t - b) / (24 * 3600 * 1000));
}

// ---------- tag rules (spec §3.4 + §4.1.3.b) ----------

function targetTag(dias: number): { tag: Tag | null; skip_reason: string | null } {
	if (dias < 0) return { tag: null, skip_reason: "atrasado-pertence-pos-venc" };
	if (dias === 0) return { tag: "boleto:vence-hoje", skip_reason: null };
	if (dias === 1 || dias === 2) return { tag: "boleto:vence-em-2d", skip_reason: null };
	if (dias >= 3) return { tag: "boleto:emitido", skip_reason: null };
	return { tag: null, skip_reason: "fora-da-janela" };
}

function highestTag(tags: Iterable<Tag>, rank: TagRank): Tag | null {
	let best: Tag | null = null;
	let bestRank = -Infinity;
	for (const t of tags) {
		const r = rank[t];
		if (r > bestRank) {
			best = t;
			bestRank = r;
		}
	}
	return best;
}

// Lê prioridade das tags boleto:* do metadado do pipeline (regua_tags[].priority).
// Falha loud se faltar metadado, prioridade null, ou tag esperada ausente — a
// régua não pode operar com configuração stale.
function loadTagRank(): TagRank {
	const resp = jsonCmd<RaviCrmPipelineShowResp>("ravi", [
		"crm",
		"pipeline",
		"show",
		PIPELINE_ID,
	]);
	const entries = resp.pipeline?.metadata?.regua_tags;
	if (!Array.isArray(entries)) {
		throw new Error(
			`pipeline ${PIPELINE_ID} sem metadata.regua_tags — não dá pra calcular prioridade`,
		);
	}

	const rank: Partial<TagRank> = {};
	for (const e of entries) {
		if (!e || typeof e.tag !== "string") continue;
		if (typeof e.priority !== "number") continue; // ignora null (ex.: cobranca:em-aberto)
		if (!ALL_TAGS.includes(e.tag as Tag)) continue; // ignora tags fora do escopo da régua
		rank[e.tag as Tag] = e.priority;
	}

	const missing = ALL_TAGS.filter((t) => typeof rank[t] !== "number");
	if (missing.length > 0) {
		throw new Error(
			`pipeline ${PIPELINE_ID}.regua_tags sem priority numérica pra: ${missing.join(", ")}`,
		);
	}
	return rank as TagRank;
}

// ---------- phone normalize ----------

function normalizePhone(raw: string | null | undefined): string | null {
	if (!raw) return null;
	const s = raw.trim();
	if (!s) return null;
	const hasPlus = s.startsWith("+");
	const digits = s.replace(/[^\d]/g, "");
	if (!digits) return null;
	if (hasPlus) return `+${digits}`;
	if (digits.startsWith("55") && (digits.length === 12 || digits.length === 13)) {
		return `+${digits}`;
	}
	if (digits.length === 10 || digits.length === 11) return `+55${digits}`;
	return null;
}

function digitsOnly(phone: string): string {
	return phone.replace(/[^\d]/g, "");
}

// ---------- log ----------

function ensureLogDir(): void {
	if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
}

function appendLog(entry: LogEntry): void {
	ensureLogDir();
	appendFileSync(LOG_FILE, `${JSON.stringify(entry)}\n`);
}

function readLog(): LogEntry[] {
	if (!existsSync(LOG_FILE)) return [];
	const raw = readFileSync(LOG_FILE, "utf-8");
	const lines = raw.split("\n").filter((l) => l.trim().length > 0);
	const out: LogEntry[] = [];
	for (const line of lines) {
		try {
			out.push(JSON.parse(line) as LogEntry);
		} catch {
			// skip malformed lines
		}
	}
	return out;
}

// ---------- ravi contacts ----------

interface ContactLookup {
	id: string | null;
	displayName: string | null;
	tags: Tag[];
}

function findContactByPhone(phoneNorm: string): ContactLookup {
	// Regra (7): `ravi contacts find` SEM o '+'. Passa só digits.
	const query = digitsOnly(phoneNorm);
	const resp = jsonCmd<RaviContactsFindResp>("ravi", ["contacts", "find", query]);
	if (resp.total === 0 || resp.contacts.length === 0) {
		return { id: null, displayName: null, tags: [] };
	}
	const c = resp.contacts[0];
	const id = c?.id ?? c?.canonicalIdentity ?? c?.primaryIdentity ?? null;
	const displayName = c?.displayName ?? c?.name ?? null;

	// Regra (8): tags do contato vivem em `policy.tags` (via show).
	let tags: Tag[] = [];
	if (id) {
		try {
			const show = jsonCmd<RaviContactsShowResp>("ravi", ["contacts", "show", id]);
			const rawTags = show.policy?.tags ?? [];
			tags = rawTags.filter((t): t is Tag => ALL_TAGS.includes(t as Tag));
		} catch {
			// non-fatal: se show falhar, prossegue sem saber tags atuais
			tags = [];
		}
	}
	return { id, displayName, tags };
}

function createContact(phone: string, name: string, dryRun: boolean): { ok: boolean; error?: string } {
	if (dryRun) return { ok: true };
	const r = runCmd("ravi", ["contacts", "add", phone, name, "--json"]);
	if (r.code !== 0) return { ok: false, error: r.stderr.trim().slice(0, 400) };
	return { ok: true };
}

function tagContact(contact: string, tag: Tag, dryRun: boolean): { ok: boolean; error?: string } {
	if (dryRun) return { ok: true };
	const r = runCmd("ravi", ["contacts", "tag", contact, tag, "--json"]);
	if (r.code !== 0) return { ok: false, error: r.stderr.trim().slice(0, 400) };
	return { ok: true };
}

function untagContact(
	contact: string,
	tag: Tag,
	dryRun: boolean,
): { ok: boolean; error?: string } {
	if (dryRun) return { ok: true };
	const r = runCmd("ravi", ["contacts", "untag", contact, tag, "--json"]);
	if (r.code !== 0) return { ok: false, error: r.stderr.trim().slice(0, 400) };
	return { ok: true };
}

// ---------- planning ----------

function fetchBoletos(window: { inicio: string; fim: string }): BoletoCobranca[] {
	const resp = jsonCmd<BoletosResp>("sde", [
		"bancointer",
		"boletos",
		"--inicio",
		window.inicio,
		"--fim",
		window.fim,
		"--situacao",
		"A_RECEBER",
	]);
	const arr = resp.data?.cobrancas ?? [];
	return arr.map((x) => x.cobranca).filter((c): c is BoletoCobranca => Boolean(c));
}

function resolveTinyCustomer(seuNumero: string): {
	telefone_raw: string | null;
	nome: string | null;
	warning: string | null;
} {
	try {
		const resp = jsonCmd<TinyContaResp>("sde", ["tiny", "conta-receber", seuNumero]);
		const conta = resp.retorno?.conta;
		const cliente = conta?.cliente;
		if (!cliente) {
			return { telefone_raw: null, nome: null, warning: "tiny-sem-cliente" };
		}
		return {
			telefone_raw: cliente.fone ?? null,
			nome: cliente.nome ?? null,
			warning: cliente.fone ? null : "tiny-sem-telefone",
		};
	} catch (e) {
		return {
			telefone_raw: null,
			nome: null,
			warning: `tiny-erro:${(e as Error).message.slice(0, 200)}`,
		};
	}
}

function buildPlan(today: string, rank: TagRank): Plan {
	const janela_fim = addDaysISO(today, 7);
	const boletos = fetchBoletos({ inicio: today, fim: janela_fim });

	// Fase 1: normaliza cada boleto em BoletoItem com tag isolada + telefone Tiny.
	const items: BoletoItem[] = [];
	for (const b of boletos) {
		const dias = diffDays(b.dataVencimento, today);
		const { tag, skip_reason } = targetTag(dias);

		const item: BoletoItem = {
			codigoSolicitacao: b.codigoSolicitacao,
			seuNumero: b.seuNumero,
			pagador_nome: b.pagador?.nome ?? "",
			cpf_cnpj: b.pagador?.cpfCnpj ?? "",
			valor: b.valorNominal,
			data_vencimento: b.dataVencimento,
			dias_ate_venc: dias,
			tag_alvo: tag,
			skip_reason,
			telefone_raw: null,
			telefone_norm: null,
			tiny_warning: null,
		};

		if (!tag) {
			items.push(item);
			continue;
		}

		const tiny = resolveTinyCustomer(b.seuNumero);
		item.telefone_raw = tiny.telefone_raw;
		item.tiny_warning = tiny.warning;
		item.telefone_norm = normalizePhone(tiny.telefone_raw);

		if (!item.telefone_norm) {
			item.skip_reason = item.skip_reason ?? "sem-telefone-resolvivel";
		}

		items.push(item);
	}

	// Fase 2: separa skipped de elegíveis e agrupa elegíveis por telefone.
	const skipped: BoletoSkip[] = [];
	const eligible: BoletoItem[] = [];
	for (const it of items) {
		if (!it.tag_alvo || it.skip_reason || !it.telefone_norm) {
			skipped.push({
				boleto: it,
				reason: it.skip_reason ?? "sem-tag",
			});
		} else {
			eligible.push(it);
		}
	}

	// Fase 3: agrupa por telefone, lê contato uma vez por telefone, calcula tag mais crítica.
	const byPhone = new Map<string, BoletoItem[]>();
	for (const it of eligible) {
		const arr = byPhone.get(it.telefone_norm as string) ?? [];
		arr.push(it);
		byPhone.set(it.telefone_norm as string, arr);
	}

	const groups: ContactGroup[] = [];
	for (const [phone, bs] of byPhone) {
		const lookup = findContactByPhone(phone);
		const tagsBoletos = bs
			.map((b) => b.tag_alvo)
			.filter((t): t is Tag => t !== null);
		const tagAlvo = highestTag(tagsBoletos, rank);
		if (!tagAlvo) {
			// guard impossível dado o filtro anterior; trata defensivamente
			for (const b of bs) skipped.push({ boleto: b, reason: "sem-tag-elegivel" });
			continue;
		}
		const tagsARemover = lookup.tags.filter((t) => t !== tagAlvo);
		const needsApply = !lookup.tags.includes(tagAlvo);

		const pagadorNomes: string[] = [];
		for (const b of bs) {
			if (b.pagador_nome && !pagadorNomes.includes(b.pagador_nome)) {
				pagadorNomes.push(b.pagador_nome);
			}
		}

		const tinyWarning = bs.find((b) => b.tiny_warning)?.tiny_warning ?? null;

		groups.push({
			telefone_norm: phone,
			contato_existe: Boolean(lookup.id),
			contato_id: lookup.id,
			contato_nome_existente: lookup.displayName,
			pagador_nomes: pagadorNomes,
			current_boleto_tags: lookup.tags,
			boletos: bs,
			tag_alvo: tagAlvo,
			tags_a_remover: tagsARemover,
			needs_apply: needsApply,
			warning: tinyWarning,
		});
	}

	return { today, janela_fim, groups, skipped };
}

// ---------- output formatting ----------

function fmtBoleto(b: BoletoItem): string {
	return `      ${b.data_vencimento} d=${String(b.dias_ate_venc).padStart(2, " ")} R$${b.valor.padStart(9, " ")} ${b.tag_alvo ?? "(skip)"}  cod=${b.codigoSolicitacao.slice(0, 8)} seu=${b.seuNumero}`;
}

function fmtGroup(g: ContactGroup): string {
	const status = g.needs_apply
		? "APPLY"
		: g.tags_a_remover.length > 0
			? "CLEANUP"
			: "NO-OP";
	const contato = g.contato_existe
		? `#${g.contato_id?.slice(0, 12) ?? "?"} ${g.contato_nome_existente ?? ""}`
		: "NOVO";
	const atual = g.current_boleto_tags.length > 0 ? `[${g.current_boleto_tags.join(",")}]` : "[]";
	const remove = g.tags_a_remover.length > 0 ? ` rem=[${g.tags_a_remover.join(",")}]` : "";
	const nomes = g.pagador_nomes.join(" | ");
	const warn = g.warning ? ` ⚠${g.warning}` : "";
	return `  [${status}] ${g.telefone_norm}  ${contato}\n    alvo=${g.tag_alvo}  atual=${atual}${remove}  boletos=${g.boletos.length}  nomes="${nomes}"${warn}`;
}

interface RunSummary {
	dry_run: boolean;
	total_boletos: number;
	total_groups: number;
	groups_apply: number;
	groups_cleanup_only: number;
	groups_noop: number;
	contacts_to_create: number;
	tags_to_apply: number;
	tags_to_remove: number;
	boletos_skipped: number;
	by_tag: Record<string, number>;
}

function summarize(plan: Plan, dryRun: boolean): RunSummary {
	const by_tag: Record<string, number> = {};
	let groupsApply = 0;
	let groupsCleanup = 0;
	let groupsNoop = 0;
	let toCreate = 0;
	let tagsApply = 0;
	let tagsRemove = 0;
	let totalBoletos = plan.skipped.length;
	for (const g of plan.groups) {
		totalBoletos += g.boletos.length;
		by_tag[g.tag_alvo] = (by_tag[g.tag_alvo] ?? 0) + 1;
		if (g.needs_apply) {
			groupsApply++;
			tagsApply++;
			if (!g.contato_existe) toCreate++;
		} else if (g.tags_a_remover.length > 0) {
			groupsCleanup++;
		} else {
			groupsNoop++;
		}
		tagsRemove += g.tags_a_remover.length;
	}
	return {
		dry_run: dryRun,
		total_boletos: totalBoletos,
		total_groups: plan.groups.length,
		groups_apply: groupsApply,
		groups_cleanup_only: groupsCleanup,
		groups_noop: groupsNoop,
		contacts_to_create: toCreate,
		tags_to_apply: tagsApply,
		tags_to_remove: tagsRemove,
		boletos_skipped: plan.skipped.length,
		by_tag,
	};
}

// ---------- subcommands ----------

interface CmdOpts {
	json?: boolean;
}

function cmdPreview(opts: CmdOpts): void {
	const today = todayISO();
	const rank = loadTagRank();
	const plan = buildPlan(today, rank);
	const summary = summarize(plan, true);

	if (opts.json) {
		process.stdout.write(`${JSON.stringify({ summary, plan, rank }, null, 2)}\n`);
		return;
	}

	process.stdout.write(`régua pré-vencimento — preview (dry-run)\n`);
	process.stdout.write(`pipeline=${PIPELINE_ID}\n`);
	process.stdout.write(
		`prioridade tags: ${ALL_TAGS.map((t) => `${t}=${rank[t]}`).join(", ")}\n`,
	);
	process.stdout.write(`hoje=${plan.today}  janela=${plan.today} → ${plan.janela_fim}\n`);
	process.stdout.write(
		`grupos: ${plan.groups.length}  (apply=${summary.groups_apply}, cleanup-only=${summary.groups_cleanup_only}, no-op=${summary.groups_noop})\n`,
	);
	process.stdout.write(`boletos pulados: ${plan.skipped.length}\n\n`);

	if (plan.groups.length > 0) {
		process.stdout.write(`grupos por contato:\n`);
		for (const g of plan.groups) {
			process.stdout.write(`${fmtGroup(g)}\n`);
			for (const b of g.boletos) process.stdout.write(`${fmtBoleto(b)}\n`);
		}
	}

	if (plan.skipped.length > 0) {
		process.stdout.write(`\nboletos pulados:\n`);
		for (const s of plan.skipped) {
			process.stdout.write(
				`  ${s.boleto.data_vencimento} d=${s.boleto.dias_ate_venc} ${s.boleto.pagador_nome} cod=${s.boleto.codigoSolicitacao.slice(0, 8)} — ${s.reason}\n`,
			);
		}
	}

	process.stdout.write(
		`\nresumo: aplicaria ${summary.tags_to_apply} tag(s) (${summary.contacts_to_create} contato(s) novo(s)); removeria ${summary.tags_to_remove} tag(s) obsoleta(s); ${summary.groups_noop} grupo(s) já em estado correto.\n`,
	);
	for (const [t, n] of Object.entries(summary.by_tag)) {
		process.stdout.write(`  ${t}: ${n} contato(s)\n`);
	}
}

function cmdApply(opts: CmdOpts): void {
	const today = todayISO();
	const runId = `run_${today}_${Date.now()}`;
	const rank = loadTagRank();

	appendLog({
		ts: new Date().toISOString(),
		run_id: runId,
		run_date: today,
		action: "run-start",
		dry_run: false,
		pipeline_id: PIPELINE_ID,
		tag_rank: rank,
		message: "régua pré-vencimento iniciada",
	});

	const plan = buildPlan(today, rank);
	const result = {
		applied: [] as Array<{ contact: string; tag: Tag; created: boolean }>,
		removed: [] as Array<{ contact: string; tag: Tag }>,
		noop: [] as Array<{ contact: string; tag: Tag }>,
		skipped: [] as Array<{ ref: string; reason: string }>,
		errors: [] as Array<{ ref: string; error: string }>,
	};

	// boletos sem grupo (skipped na fase de planejamento)
	for (const s of plan.skipped) {
		result.skipped.push({ ref: s.boleto.codigoSolicitacao, reason: s.reason });
		appendLog({
			ts: new Date().toISOString(),
			run_id: runId,
			run_date: today,
			action: "boleto-skipped",
			dry_run: false,
			codigoSolicitacao: s.boleto.codigoSolicitacao,
			seuNumero: s.boleto.seuNumero,
			nome: s.boleto.pagador_nome,
			dias_ate_venc: s.boleto.dias_ate_venc,
			message: s.reason,
		});
	}

	for (const g of plan.groups) {
		const idem = `${g.telefone_norm}:${g.tag_alvo}:${today}`;
		const codigos = g.boletos.map((b) => b.codigoSolicitacao);

		// Idempotência por tags atuais (regra 5): se já está no estado desejado, no-op.
		if (!g.needs_apply && g.tags_a_remover.length === 0) {
			result.noop.push({ contact: g.contato_id ?? g.telefone_norm, tag: g.tag_alvo });
			appendLog({
				ts: new Date().toISOString(),
				run_id: runId,
				run_date: today,
				action: "tag-noop",
				dry_run: false,
				telefone: g.telefone_norm,
				nome: g.contato_nome_existente ?? g.pagador_nomes[0] ?? "",
				tag_alvo: g.tag_alvo,
				idempotency_key: idem,
				codigos,
				message: "ja-em-estado-correto",
			});
			continue;
		}

		// Cria contato se faltar.
		let contactRef = g.contato_id ?? g.telefone_norm;
		let created = false;
		if (!g.contato_existe) {
			const nomeNovo = g.pagador_nomes[0] || "Cliente SDE";
			const c = createContact(g.telefone_norm, nomeNovo, false);
			if (!c.ok) {
				result.errors.push({
					ref: g.telefone_norm,
					error: `contact-add:${c.error}`,
				});
				appendLog({
					ts: new Date().toISOString(),
					run_id: runId,
					run_date: today,
					action: "error",
					dry_run: false,
					telefone: g.telefone_norm,
					nome: nomeNovo,
					codigos,
					message: `contact-add falhou: ${c.error}`,
				});
				continue;
			}
			created = true;
			contactRef = g.telefone_norm;
			appendLog({
				ts: new Date().toISOString(),
				run_id: runId,
				run_date: today,
				action: "contact-created",
				dry_run: false,
				telefone: g.telefone_norm,
				nome: nomeNovo,
			});
		}

		// Aplica a tag alvo (se faltar).
		if (g.needs_apply) {
			const tagRes = tagContact(contactRef, g.tag_alvo, false);
			if (!tagRes.ok) {
				result.errors.push({
					ref: contactRef,
					error: `tag:${tagRes.error}`,
				});
				appendLog({
					ts: new Date().toISOString(),
					run_id: runId,
					run_date: today,
					action: "error",
					dry_run: false,
					telefone: g.telefone_norm,
					tag_alvo: g.tag_alvo,
					codigos,
					message: `tag falhou: ${tagRes.error}`,
				});
				continue;
			}
			result.applied.push({ contact: contactRef, tag: g.tag_alvo, created });
			appendLog({
				ts: new Date().toISOString(),
				run_id: runId,
				run_date: today,
				action: "tag-applied",
				dry_run: false,
				telefone: g.telefone_norm,
				nome: g.contato_nome_existente ?? g.pagador_nomes[0] ?? "",
				tag_alvo: g.tag_alvo,
				idempotency_key: idem,
				codigos,
			});
		}

		// Remove tags boleto:* obsoletas do contato (regra 4).
		for (const obsTag of g.tags_a_remover) {
			const r = untagContact(contactRef, obsTag, false);
			if (!r.ok) {
				appendLog({
					ts: new Date().toISOString(),
					run_id: runId,
					run_date: today,
					action: "warn",
					dry_run: false,
					telefone: g.telefone_norm,
					message: `untag ${obsTag} falhou: ${r.error}`,
				});
				continue;
			}
			result.removed.push({ contact: contactRef, tag: obsTag });
			appendLog({
				ts: new Date().toISOString(),
				run_id: runId,
				run_date: today,
				action: "tag-removed",
				dry_run: false,
				telefone: g.telefone_norm,
				tag_alvo: obsTag,
			});
		}
	}

	appendLog({
		ts: new Date().toISOString(),
		run_id: runId,
		run_date: today,
		action: "run-end",
		dry_run: false,
		message: `applied=${result.applied.length} removed=${result.removed.length} noop=${result.noop.length} skipped=${result.skipped.length} errors=${result.errors.length}`,
	});

	if (opts.json) {
		process.stdout.write(
			`${JSON.stringify({ run_id: runId, run_date: today, result }, null, 2)}\n`,
		);
		return;
	}

	process.stdout.write(`régua pré-vencimento — apply\n`);
	process.stdout.write(`run_id=${runId}\n`);
	process.stdout.write(`aplicadas: ${result.applied.length}\n`);
	process.stdout.write(`  (criou ${result.applied.filter((a) => a.created).length} contato(s))\n`);
	process.stdout.write(`removidas: ${result.removed.length}\n`);
	process.stdout.write(`no-op:     ${result.noop.length}\n`);
	process.stdout.write(`puladas:   ${result.skipped.length}\n`);
	process.stdout.write(`erros:     ${result.errors.length}\n`);
	if (result.errors.length > 0) {
		process.stdout.write(`\nerros:\n`);
		for (const e of result.errors) {
			process.stdout.write(`  ${e.ref}: ${e.error}\n`);
		}
		process.exit(2);
	}
}

function cmdStatus(opts: CmdOpts): void {
	const log = readLog();
	if (log.length === 0) {
		const msg = { hasLog: false, message: "sem log — nunca rodou apply" };
		if (opts.json) process.stdout.write(`${JSON.stringify(msg, null, 2)}\n`);
		else process.stdout.write(`${msg.message}\n`);
		return;
	}

	const runs = new Map<string, LogEntry[]>();
	for (const e of log) {
		const id = e.run_id ?? "(sem-id)";
		const arr = runs.get(id) ?? [];
		arr.push(e);
		runs.set(id, arr);
	}

	const runIds = Array.from(runs.keys());
	const lastId = runIds[runIds.length - 1];
	const lastRun = runs.get(lastId) ?? [];
	const start = lastRun.find((e) => e.action === "run-start");
	const end = lastRun.find((e) => e.action === "run-end");
	const applied = lastRun.filter((e) => e.action === "tag-applied").length;
	const removed = lastRun.filter((e) => e.action === "tag-removed").length;
	const noop = lastRun.filter((e) => e.action === "tag-noop").length;
	const created = lastRun.filter((e) => e.action === "contact-created").length;
	const skipped = lastRun.filter(
		(e) => e.action === "boleto-skipped" || e.action === "group-skipped",
	).length;
	const warns = lastRun.filter((e) => e.action === "warn").length;
	const errors = lastRun.filter((e) => e.action === "error").length;

	const out = {
		last_run_id: lastId,
		started_at: start?.ts ?? null,
		ended_at: end?.ts ?? null,
		applied,
		removed,
		noop,
		contacts_created: created,
		skipped,
		warns,
		errors,
		total_runs: runIds.length,
		log_file: LOG_FILE,
	};

	if (opts.json) {
		process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
		return;
	}

	process.stdout.write(`régua pré-vencimento — status\n`);
	process.stdout.write(`log: ${LOG_FILE}\n`);
	process.stdout.write(`total de runs: ${out.total_runs}\n`);
	process.stdout.write(`último run: ${out.last_run_id}\n`);
	process.stdout.write(`  iniciado: ${out.started_at ?? "?"}\n`);
	process.stdout.write(`  encerrado: ${out.ended_at ?? "(incompleto)"}\n`);
	process.stdout.write(`  tags aplicadas: ${out.applied}\n`);
	process.stdout.write(`  tags removidas: ${out.removed}\n`);
	process.stdout.write(`  no-op (já correto): ${out.noop}\n`);
	process.stdout.write(`  contatos criados: ${out.contacts_created}\n`);
	process.stdout.write(`  pulados: ${out.skipped}\n`);
	process.stdout.write(`  warns: ${out.warns}\n`);
	process.stdout.write(`  erros: ${out.errors}\n`);
}

// ---------- main ----------

const program = new Command();
program
	.name("sde-regua-pre-vencimento")
	.description(
		[
			"Régua pré-vencimento de boletos SDE.",
			"",
			"Operado pelo jarvis-financ (cron 6h BRT). Lê boletos A_RECEBER do Banco Inter,",
			"resolve telefone via Tiny, agrupa por contato e sincroniza UMA tag boleto:*",
			"por contato (a mais crítica entre seus boletos):",
			"  dias_ate_venc == 0   → boleto:vence-hoje",
			"  dias_ate_venc ∈ 1..2 → boleto:vence-em-2d",
			"  dias_ate_venc >= 3   → boleto:emitido",
			"",
			`A prioridade entre tags é lida do metadado do pipeline ${PIPELINE_ID}`,
			"(regua_tags[].priority) em runtime — override via env SDE_COBRANCA_PIPELINE_ID.",
			"",
			"Idempotência: lê tags atuais do contato (policy.tags) e só atua se houver",
			"divergência. Tags boleto:* obsoletas são removidas a cada run.",
			`Log JSONL: ${LOG_FILE}`,
			"",
			"Spec: /home/ravi/main-kimi/specs/sde-regua-pre-vencimento.md §3.4 + §4.1",
		].join("\n"),
	)
	.version(VERSION);

program
	.command("preview")
	.description("Lista grupos por contato e o que seria feito (dry-run, sem efeitos)")
	.option("--json", "Output JSON em stdout")
	.action((opts: CmdOpts) => {
		try {
			cmdPreview(opts);
		} catch (e) {
			process.stderr.write(`preview falhou: ${(e as Error).message}\n`);
			process.exit(1);
		}
	});

program
	.command("apply")
	.description("Cria contatos faltantes, aplica tag mais crítica por contato e remove obsoletas")
	.option("--json", "Output JSON em stdout")
	.action((opts: CmdOpts) => {
		try {
			cmdApply(opts);
		} catch (e) {
			process.stderr.write(`apply falhou: ${(e as Error).message}\n`);
			appendLog({
				ts: new Date().toISOString(),
				run_id: `run_aborted_${Date.now()}`,
				run_date: todayISO(),
				action: "error",
				dry_run: false,
				message: `apply abortado: ${(e as Error).message}`,
			});
			process.exit(1);
		}
	});

program
	.command("status")
	.description("Mostra resumo do último run a partir do JSONL")
	.option("--json", "Output JSON em stdout")
	.action((opts: CmdOpts) => {
		try {
			cmdStatus(opts);
		} catch (e) {
			process.stderr.write(`status falhou: ${(e as Error).message}\n`);
			process.exit(1);
		}
	});

program.parse(process.argv);
