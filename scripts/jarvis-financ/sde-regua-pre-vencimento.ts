#!/usr/bin/env bun
// sde-regua-pre-vencimento — régua pré-vencimento de boletos SDE (v2)
//
// Orquestrador domain-specific (jarvis-financ). v2 simplificada:
// não usa mais tags boleto:*. Cria tasks CRM diretamente para cada
// boleto a vencer, owner=agent:sde-dispatcher. O dispatcher lê essas
// tasks nos horários dele (8h/12h/16h) e envia prévias para aprovação.
//
// Spec: /home/ravi/main-kimi/specs/sde-regua-pre-vencimento-v2.md
// Operação: cron diário 6h BRT no jarvis-financ
//
// Pipeline upstream:
//   sde bancointer boletos        — fonte dos boletos A_RECEBER D+0/D+1/D+2
//   sde tiny conta-receber <id>   — resolve seuNumero → telefone/nome
//   ravi contacts find/add        — sincroniza contato no Ravi
//   ravi crm task create          — cria task CRM (owner=sde-dispatcher)
//
// Tipo de notificação por dias até vencimento:
//   dias_ate_venc == 0 → VENCIMENTO_HOJE
//   dias_ate_venc == 1 → LEMBRETE_2DIAS (lembrete 1 dia antes)
//   dias_ate_venc == 2 → LEMBRETE_2DIAS
//
// Idempotência:
//   --idempotency-key = jarvis-financ:<codigoSolicitacao>:<tipo>:<data_venc>
//   Não duplica task para mesmo boleto + tipo.
//
// Subcomandos:
//   preview   dry-run; lista tasks que seriam criadas
//   apply     cria tasks CRM e escreve JSONL
//   status    resumo do último run a partir do JSONL

import { Command } from "commander";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const LOG_DIR = join(homedir(), ".ravi", "jarvis-financ");
const LOG_FILE = join(LOG_DIR, "regua-pre-vencimento.log");
const VERSION = "2.0.0";
const PIPELINE_SLUG = process.env.SDE_COBRANCA_PIPELINE_SLUG ?? "sde-cobranca";
const INSTANCE = process.env.SDE_DISPATCHER_INSTANCE ?? "sde";
const DEFAULT_LIMIT = Number.parseInt(
	process.env.SDE_REGUA_DAILY_LIMIT ?? "50",
	10,
);

type TipoNotificacao = "EMISSAO" | "LEMBRETE_2DIAS" | "VENCIMENTO_HOJE";

interface BoletoCobranca {
	codigoSolicitacao: string;
	seuNumero: string;
	situacao: string;
	dataEmissao?: string;
	dataVencimento: string;
	valorNominal: string | number;
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
	}>;
}

interface RaviContactsAddResp {
	contact?: { id?: string; displayName?: string };
	created?: boolean;
}

interface RaviCrmTaskCreateResp {
	task?: { id?: string };
	created?: boolean;
	skipped?: boolean;
	reason?: string;
}

interface PipelineFirstContactRule {
	control_tag: string;
	intro?: string;
	template?: string;
	placeholders?: Record<string, string>;
}

interface PipelineMessageRule {
	prefix?: string;
	first_contact?: PipelineFirstContactRule;
}

interface RaviCrmPipelineShowResp {
	pipeline?: {
		id?: string;
		name?: string;
		metadata?: {
			message_rule?: PipelineMessageRule;
			[k: string]: unknown;
		};
	};
}

interface RaviContactsShowResp {
	policy?: { tags?: string[] };
	tags?: string[];
}

interface BoletoItem {
	codigoSolicitacao: string;
	seuNumero: string;
	pagador_nome_inter: string;
	cpf_cnpj: string;
	valor: string;
	data_vencimento: string;
	dias_ate_venc: number;
	tipo_notificacao: TipoNotificacao | null;
	skip_reason: string | null;
	tiny_nome: string | null;
	telefone_raw: string | null;
	telefone_norm: string | null;
	tiny_warning: string | null;
}

interface PlannedTask {
	boleto: BoletoItem;
	contato_existe: boolean;
	contato_id: string | null;
	contato_display_name: string | null;
	telefone_norm: string;
	display_name: string;
	tipo_notificacao: TipoNotificacao;
	data_envio: string;
	due_iso: string;
	title: string;
	body: string;
	message: string;
	metadata: TaskMetadata;
	idempotency_key: string;
}

interface TaskMetadata {
	channel: "whatsapp";
	instance: string;
	pipeline: string;
	justification: string;
	message: string;
	codigo_solicitacao: string;
	tipo_notificacao: TipoNotificacao;
	data_vencimento: string;
	valor: string;
	pagador_nome: string;
	seu_numero: string;
	first_contact?: boolean;
	apply_tag_on_send?: string;
}

interface BoletoSkip {
	boleto: BoletoItem;
	reason: string;
}

interface Plan {
	today: string;
	janela_fim: string;
	tasks: PlannedTask[];
	skipped: BoletoSkip[];
}

interface LogEntry {
	ts: string;
	run_id: string;
	run_date: string;
	action:
		| "run-start"
		| "run-end"
		| "task-created"
		| "task-skipped"
		| "contact-created"
		| "boleto-skipped"
		| "limit-reached"
		| "warn"
		| "error";
	dry_run: boolean;
	codigoSolicitacao?: string;
	seuNumero?: string;
	telefone?: string;
	nome?: string;
	dias_ate_venc?: number;
	tipo_notificacao?: TipoNotificacao | null;
	idempotency_key?: string;
	task_id?: string;
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
		throw new Error(
			`${bin} ${args.join(" ")} exit ${r.code}: ${r.stderr.trim().slice(0, 600)}`,
		);
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

function fmtDateBR(iso: string): string {
	const [y, m, d] = iso.split("-");
	if (!y || !m || !d) return iso;
	return `${d}/${m}/${y}`;
}

// ---------- tipo notificação ----------

function tipoFromDias(dias: number): {
	tipo: TipoNotificacao | null;
	skip_reason: string | null;
} {
	if (dias < 0)
		return { tipo: null, skip_reason: "atrasado-pertence-pos-venc" };
	if (dias === 0) return { tipo: "VENCIMENTO_HOJE", skip_reason: null };
	if (dias === 1 || dias === 2)
		return { tipo: "LEMBRETE_2DIAS", skip_reason: null };
	return { tipo: null, skip_reason: "fora-da-janela-D+2" };
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
	if (
		digits.startsWith("55") &&
		(digits.length === 12 || digits.length === 13)
	) {
		return `+${digits}`;
	}
	if (digits.length === 10 || digits.length === 11) return `+55${digits}`;
	return null;
}

function digitsOnly(phone: string): string {
	return phone.replace(/[^\d]/g, "");
}

// ---------- valor format ----------

function fmtValor(v: string | number): string {
	const n = typeof v === "number" ? v : Number.parseFloat(v.replace(",", "."));
	if (!Number.isFinite(n)) return String(v);
	return n.toLocaleString("pt-BR", {
		minimumFractionDigits: 2,
		maximumFractionDigits: 2,
	});
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
}

function findContactByPhone(phoneNorm: string): ContactLookup {
	const query = digitsOnly(phoneNorm);
	const resp = jsonCmd<RaviContactsFindResp>("ravi", [
		"contacts",
		"find",
		query,
	]);
	if (resp.total === 0 || resp.contacts.length === 0) {
		return { id: null, displayName: null };
	}
	const c = resp.contacts[0];
	const id = c?.id ?? c?.canonicalIdentity ?? c?.primaryIdentity ?? null;
	const displayName = c?.displayName ?? c?.name ?? null;
	return { id, displayName };
}

function loadContactTags(contactId: string): string[] {
	try {
		const resp = jsonCmd<RaviContactsShowResp>("ravi", [
			"contacts",
			"show",
			contactId,
		]);
		return resp.policy?.tags ?? resp.tags ?? [];
	} catch {
		return [];
	}
}

function loadPipelineRule(slug: string): PipelineMessageRule | null {
	try {
		const resp = jsonCmd<RaviCrmPipelineShowResp>("ravi", [
			"crm",
			"pipeline",
			"show",
			slug,
		]);
		return resp.pipeline?.metadata?.message_rule ?? null;
	} catch {
		return null;
	}
}

function createContact(
	phone: string,
	name: string,
	dryRun: boolean,
): { ok: boolean; id?: string; displayName?: string; error?: string } {
	if (dryRun) return { ok: true };
	const r = runCmd("ravi", ["contacts", "add", phone, name, "--json"]);
	if (r.code !== 0) return { ok: false, error: r.stderr.trim().slice(0, 400) };
	try {
		const parsed = JSON.parse(r.stdout) as RaviContactsAddResp;
		return {
			ok: true,
			id: parsed.contact?.id,
			displayName: parsed.contact?.displayName,
		};
	} catch {
		return { ok: true };
	}
}

// ---------- ravi crm task ----------

function createCrmTask(
	t: PlannedTask,
	dryRun: boolean,
): {
	ok: boolean;
	task_id?: string;
	skipped?: boolean;
	reason?: string;
	error?: string;
} {
	if (dryRun) return { ok: true, skipped: false };
	const contactRef = t.contato_id ?? t.telefone_norm;
	const args = [
		"crm",
		"task",
		"create",
		t.title,
		"--contact",
		contactRef,
		"--body",
		t.body,
		"--task-type",
		"follow_up",
		"--due",
		t.due_iso,
		"--owner",
		"agent:sde-dispatcher",
		"--source",
		"agent:jarvis-financ",
		"--priority",
		"normal",
		"--metadata",
		JSON.stringify(t.metadata),
		"--idempotency-key",
		t.idempotency_key,
		"--json",
	];
	const r = runCmd("ravi", args);
	if (r.code !== 0) {
		return { ok: false, error: r.stderr.trim().slice(0, 600) };
	}
	try {
		const parsed = JSON.parse(r.stdout) as RaviCrmTaskCreateResp;
		return {
			ok: true,
			task_id: parsed.task?.id,
			skipped: parsed.skipped === true || parsed.created === false,
			reason: parsed.reason,
		};
	} catch {
		return { ok: true };
	}
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
		const resp = jsonCmd<TinyContaResp>("sde", [
			"tiny",
			"conta-receber",
			seuNumero,
		]);
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

function firstName(full: string): string {
	const parts = full.trim().split(/\s+/);
	return parts[0] ?? full;
}

const DEFAULT_PREFIX = "**Lucia - Financeiro:**\n";

interface BoletoContext {
	displayName: string;
	valor: string;
	dataVencimento: string;
	tipo: TipoNotificacao;
	codigoSolicitacao: string;
	seuNumero: string;
}

function buildCorpo(ctx: BoletoContext): string {
	const valorFmt = fmtValor(ctx.valor);
	const dataFmt = fmtDateBR(ctx.dataVencimento);
	const oi = `Oi, ${firstName(ctx.displayName)}! Tudo bem?`;
	let linha: string;
	switch (ctx.tipo) {
		case "VENCIMENTO_HOJE":
			linha = `Seu boleto no valor de R$ ${valorFmt} vence *hoje* (${dataFmt}).`;
			break;
		case "LEMBRETE_2DIAS":
			linha = `Passando pra lembrar que seu boleto no valor de R$ ${valorFmt} vence em ${dataFmt}.`;
			break;
		case "EMISSAO":
			linha = `Acabamos de emitir seu boleto no valor de R$ ${valorFmt}, com vencimento em ${dataFmt}.`;
			break;
	}
	return `${oi}\n\n${linha}\n\nSe precisar do link de pagamento ou de alguma ajuda, é só me avisar. 🧡`;
}

function resolvePlaceholderPath(ctx: BoletoContext, path: string): string {
	const [raw, fmt] = path.split("|");
	const key = raw?.trim();
	if (!key) return "";
	let value: string;
	switch (key) {
		case "cobranca.seuNumero":
		case "seuNumero":
			value = ctx.seuNumero;
			break;
		case "cobranca.codigoSolicitacao":
		case "codigoSolicitacao":
			value = ctx.codigoSolicitacao;
			break;
		case "cobranca.dataVencimento":
		case "dataVencimento":
			value = ctx.dataVencimento;
			break;
		case "cobranca.valor":
		case "valor":
			value = ctx.valor;
			break;
		case "displayName":
		case "cliente.displayName":
			value = ctx.displayName;
			break;
		default:
			return "";
	}
	const f = fmt?.trim();
	if (f === "dd/mm/yyyy" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
		return fmtDateBR(value);
	}
	if (f === "currency-brl") return fmtValor(value);
	return value;
}

function renderTemplate(
	tpl: string,
	ctx: BoletoContext,
	placeholders: Record<string, string> | undefined,
): string {
	if (!placeholders) return tpl;
	let out = tpl;
	for (const [key, path] of Object.entries(placeholders)) {
		out = out.split(`{{${key}}}`).join(resolvePlaceholderPath(ctx, path));
	}
	return out;
}

function buildMessage(
	ctx: BoletoContext,
	rule: PipelineMessageRule | null,
	isFirstContact: boolean,
): string {
	const prefix = rule?.prefix ?? DEFAULT_PREFIX;
	const first = rule?.first_contact;

	if (isFirstContact && first?.template) {
		return renderTemplate(first.template, ctx, first.placeholders);
	}

	const corpo = buildCorpo(ctx);
	if (isFirstContact && first?.intro) {
		return `${prefix}${first.intro}${corpo}`;
	}
	return `${prefix}${corpo}`;
}

function buildPlan(today: string): Plan {
	const janela_fim = addDaysISO(today, 2);
	const boletos = fetchBoletos({ inicio: today, fim: janela_fim });
	const rule = loadPipelineRule(PIPELINE_SLUG);
	const controlTag = rule?.first_contact?.control_tag ?? null;

	const items: BoletoItem[] = [];
	for (const b of boletos) {
		const dias = diffDays(b.dataVencimento, today);
		const { tipo, skip_reason } = tipoFromDias(dias);

		const item: BoletoItem = {
			codigoSolicitacao: b.codigoSolicitacao,
			seuNumero: b.seuNumero,
			pagador_nome_inter: b.pagador?.nome ?? "",
			cpf_cnpj: b.pagador?.cpfCnpj ?? "",
			valor: typeof b.valorNominal === "number"
				? b.valorNominal.toFixed(2)
				: b.valorNominal,
			data_vencimento: b.dataVencimento,
			dias_ate_venc: dias,
			tipo_notificacao: tipo,
			skip_reason,
			tiny_nome: null,
			telefone_raw: null,
			telefone_norm: null,
			tiny_warning: null,
		};

		if (!tipo) {
			items.push(item);
			continue;
		}

		const tiny = resolveTinyCustomer(b.seuNumero);
		item.telefone_raw = tiny.telefone_raw;
		item.tiny_nome = tiny.nome;
		item.tiny_warning = tiny.warning;
		item.telefone_norm = normalizePhone(tiny.telefone_raw);

		if (!item.telefone_norm) {
			item.skip_reason = item.skip_reason ?? "sem-telefone-resolvivel";
		}

		items.push(item);
	}

	const skipped: BoletoSkip[] = [];
	const tasks: PlannedTask[] = [];
	for (const it of items) {
		if (!it.tipo_notificacao || it.skip_reason || !it.telefone_norm) {
			skipped.push({ boleto: it, reason: it.skip_reason ?? "sem-tipo" });
			continue;
		}

		const lookup = findContactByPhone(it.telefone_norm);
		const display = lookup.displayName ?? it.tiny_nome ?? it.pagador_nome_inter ?? "Cliente SDE";

		let isFirstContact = true;
		if (controlTag && lookup.id) {
			const tags = loadContactTags(lookup.id);
			if (tags.includes(controlTag)) isFirstContact = false;
		}

		const data_envio = today;
		const due_iso = `${data_envio}T09:00:00-03:00`;
		const ctx: BoletoContext = {
			displayName: display,
			valor: it.valor,
			dataVencimento: it.data_vencimento,
			tipo: it.tipo_notificacao,
			codigoSolicitacao: it.codigoSolicitacao,
			seuNumero: it.seuNumero,
		};
		const message = buildMessage(ctx, rule, isFirstContact);
		const valorFmt = fmtValor(it.valor);
		const title = `Lembrete boleto ${display} - venc ${fmtDateBR(it.data_vencimento)}`;
		const body = `Boleto R$ ${valorFmt} vence em ${fmtDateBR(it.data_vencimento)}. Notificacao ${it.tipo_notificacao}.`;
		const metadata: TaskMetadata = {
			channel: "whatsapp",
			instance: INSTANCE,
			pipeline: PIPELINE_SLUG,
			justification: "Régua pré-vencimento",
			message,
			codigo_solicitacao: it.codigoSolicitacao,
			tipo_notificacao: it.tipo_notificacao,
			data_vencimento: it.data_vencimento,
			valor: it.valor,
			pagador_nome: it.pagador_nome_inter,
			seu_numero: it.seuNumero,
		};
		if (isFirstContact && controlTag) {
			metadata.first_contact = true;
			metadata.apply_tag_on_send = controlTag;
		}
		const idempotency_key = `jarvis-financ:${it.codigoSolicitacao}:${it.tipo_notificacao}:${it.data_vencimento}`;

		tasks.push({
			boleto: it,
			contato_existe: Boolean(lookup.id),
			contato_id: lookup.id,
			contato_display_name: lookup.displayName,
			telefone_norm: it.telefone_norm,
			display_name: display,
			tipo_notificacao: it.tipo_notificacao,
			data_envio,
			due_iso,
			title,
			body,
			message,
			metadata,
			idempotency_key,
		});
	}

	return { today, janela_fim, tasks, skipped };
}

// ---------- output formatting ----------

function fmtTaskRow(t: PlannedTask): string {
	const b = t.boleto;
	const novo = t.contato_existe ? "" : " [NOVO]";
	return `  ${b.data_vencimento} d=${String(b.dias_ate_venc).padStart(2, " ")} ${t.tipo_notificacao.padEnd(15, " ")} R$${fmtValor(b.valor).padStart(11, " ")}  ${t.telefone_norm}${novo}  ${t.display_name}\n      idem=${t.idempotency_key}`;
}

interface RunSummary {
	dry_run: boolean;
	total_boletos: number;
	tasks_planned: number;
	contacts_to_create: number;
	boletos_skipped: number;
	by_tipo: Record<string, number>;
}

function summarize(plan: Plan, dryRun: boolean): RunSummary {
	const by_tipo: Record<string, number> = {};
	let toCreate = 0;
	for (const t of plan.tasks) {
		by_tipo[t.tipo_notificacao] = (by_tipo[t.tipo_notificacao] ?? 0) + 1;
		if (!t.contato_existe) toCreate++;
	}
	return {
		dry_run: dryRun,
		total_boletos: plan.tasks.length + plan.skipped.length,
		tasks_planned: plan.tasks.length,
		contacts_to_create: toCreate,
		boletos_skipped: plan.skipped.length,
		by_tipo,
	};
}

// ---------- subcommands ----------

interface CmdOpts {
	json?: boolean;
	limit?: string;
}

function cmdPreview(opts: CmdOpts): void {
	const today = todayISO();
	const plan = buildPlan(today);
	const summary = summarize(plan, true);

	if (opts.json) {
		process.stdout.write(`${JSON.stringify({ summary, plan }, null, 2)}\n`);
		return;
	}

	process.stdout.write(`régua pré-vencimento v2 — preview (dry-run)\n`);
	process.stdout.write(
		`pipeline=${PIPELINE_SLUG}  instance=${INSTANCE}  daily_limit=${DEFAULT_LIMIT}\n`,
	);
	process.stdout.write(
		`hoje=${plan.today}  janela=${plan.today} → ${plan.janela_fim} (D+0..D+2)\n`,
	);
	process.stdout.write(
		`tasks planejadas: ${plan.tasks.length}  (contatos novos: ${summary.contacts_to_create})\n`,
	);
	process.stdout.write(`boletos pulados: ${plan.skipped.length}\n\n`);

	if (plan.tasks.length > 0) {
		process.stdout.write(`tasks que seriam criadas:\n`);
		for (const t of plan.tasks) process.stdout.write(`${fmtTaskRow(t)}\n`);
	}

	if (plan.skipped.length > 0) {
		process.stdout.write(`\nboletos pulados:\n`);
		for (const s of plan.skipped) {
			process.stdout.write(
				`  ${s.boleto.data_vencimento} d=${s.boleto.dias_ate_venc} ${s.boleto.pagador_nome_inter} cod=${s.boleto.codigoSolicitacao.slice(0, 8)} — ${s.reason}\n`,
			);
		}
	}

	process.stdout.write(
		`\nresumo: ${summary.tasks_planned} task(s); ${summary.contacts_to_create} contato(s) novo(s); ${summary.boletos_skipped} pulado(s).\n`,
	);
	for (const [tipo, n] of Object.entries(summary.by_tipo)) {
		process.stdout.write(`  ${tipo}: ${n}\n`);
	}
}

function cmdApply(opts: CmdOpts): void {
	const today = todayISO();
	const runId = `run_${today}_${Date.now()}`;
	const limit = opts.limit ? Number.parseInt(opts.limit, 10) : DEFAULT_LIMIT;

	appendLog({
		ts: new Date().toISOString(),
		run_id: runId,
		run_date: today,
		action: "run-start",
		dry_run: false,
		pipeline_slug: PIPELINE_SLUG,
		instance: INSTANCE,
		limit,
		message: "régua pré-vencimento v2 iniciada",
	});

	const plan = buildPlan(today);
	const result = {
		created: [] as Array<{ codigoSolicitacao: string; task_id?: string; tipo: TipoNotificacao }>,
		dedup_skipped: [] as Array<{ codigoSolicitacao: string; reason?: string; tipo: TipoNotificacao }>,
		contacts_created: [] as Array<{ telefone: string; nome: string }>,
		boletos_skipped: [] as Array<{ codigoSolicitacao: string; reason: string }>,
		errors: [] as Array<{ ref: string; error: string }>,
		limit_reached: false,
	};

	for (const s of plan.skipped) {
		result.boletos_skipped.push({
			codigoSolicitacao: s.boleto.codigoSolicitacao,
			reason: s.reason,
		});
		appendLog({
			ts: new Date().toISOString(),
			run_id: runId,
			run_date: today,
			action: "boleto-skipped",
			dry_run: false,
			codigoSolicitacao: s.boleto.codigoSolicitacao,
			seuNumero: s.boleto.seuNumero,
			nome: s.boleto.pagador_nome_inter,
			dias_ate_venc: s.boleto.dias_ate_venc,
			message: s.reason,
		});
	}

	let processed = 0;
	for (const t of plan.tasks) {
		if (processed >= limit) {
			result.limit_reached = true;
			appendLog({
				ts: new Date().toISOString(),
				run_id: runId,
				run_date: today,
				action: "limit-reached",
				dry_run: false,
				message: `limite diário de ${limit} tasks atingido — ${plan.tasks.length - processed} adiada(s) p/ próximo run`,
			});
			break;
		}

		// Cria contato se faltar.
		if (!t.contato_existe) {
			const c = createContact(t.telefone_norm, t.display_name, false);
			if (!c.ok) {
				result.errors.push({
					ref: t.telefone_norm,
					error: `contact-add:${c.error}`,
				});
				appendLog({
					ts: new Date().toISOString(),
					run_id: runId,
					run_date: today,
					action: "error",
					dry_run: false,
					telefone: t.telefone_norm,
					nome: t.display_name,
					codigoSolicitacao: t.boleto.codigoSolicitacao,
					message: `contact-add falhou: ${c.error}`,
				});
				continue;
			}
			result.contacts_created.push({
				telefone: t.telefone_norm,
				nome: t.display_name,
			});
			appendLog({
				ts: new Date().toISOString(),
				run_id: runId,
				run_date: today,
				action: "contact-created",
				dry_run: false,
				telefone: t.telefone_norm,
				nome: t.display_name,
			});
			if (c.id) t.contato_id = c.id;
		}

		const r = createCrmTask(t, false);
		if (!r.ok) {
			result.errors.push({
				ref: t.boleto.codigoSolicitacao,
				error: `task:${r.error}`,
			});
			appendLog({
				ts: new Date().toISOString(),
				run_id: runId,
				run_date: today,
				action: "error",
				dry_run: false,
				codigoSolicitacao: t.boleto.codigoSolicitacao,
				tipo_notificacao: t.tipo_notificacao,
				idempotency_key: t.idempotency_key,
				message: `task create falhou: ${r.error}`,
			});
			continue;
		}

		processed++;

		if (r.skipped) {
			result.dedup_skipped.push({
				codigoSolicitacao: t.boleto.codigoSolicitacao,
				reason: r.reason,
				tipo: t.tipo_notificacao,
			});
			appendLog({
				ts: new Date().toISOString(),
				run_id: runId,
				run_date: today,
				action: "task-skipped",
				dry_run: false,
				codigoSolicitacao: t.boleto.codigoSolicitacao,
				tipo_notificacao: t.tipo_notificacao,
				idempotency_key: t.idempotency_key,
				task_id: r.task_id,
				message: r.reason ?? "idempotency-hit",
			});
			continue;
		}

		result.created.push({
			codigoSolicitacao: t.boleto.codigoSolicitacao,
			task_id: r.task_id,
			tipo: t.tipo_notificacao,
		});
		appendLog({
			ts: new Date().toISOString(),
			run_id: runId,
			run_date: today,
			action: "task-created",
			dry_run: false,
			codigoSolicitacao: t.boleto.codigoSolicitacao,
			seuNumero: t.boleto.seuNumero,
			telefone: t.telefone_norm,
			nome: t.display_name,
			tipo_notificacao: t.tipo_notificacao,
			idempotency_key: t.idempotency_key,
			task_id: r.task_id,
		});
	}

	appendLog({
		ts: new Date().toISOString(),
		run_id: runId,
		run_date: today,
		action: "run-end",
		dry_run: false,
		message: `created=${result.created.length} dedup_skipped=${result.dedup_skipped.length} contacts=${result.contacts_created.length} skipped=${result.boletos_skipped.length} errors=${result.errors.length} limit_reached=${result.limit_reached}`,
	});

	if (opts.json) {
		process.stdout.write(
			`${JSON.stringify({ run_id: runId, run_date: today, result }, null, 2)}\n`,
		);
		return;
	}

	process.stdout.write(`régua pré-vencimento v2 — apply\n`);
	process.stdout.write(`run_id=${runId}\n`);
	process.stdout.write(`tasks criadas:     ${result.created.length}\n`);
	process.stdout.write(`tasks dedup:       ${result.dedup_skipped.length}\n`);
	process.stdout.write(`contatos criados:  ${result.contacts_created.length}\n`);
	process.stdout.write(`boletos pulados:   ${result.boletos_skipped.length}\n`);
	process.stdout.write(`erros:             ${result.errors.length}\n`);
	if (result.limit_reached) {
		process.stdout.write(`⚠ limite diário ${limit} atingido — restante adiado.\n`);
	}
	if (result.errors.length > 0) {
		process.stdout.write(`\nerros:\n`);
		for (const e of result.errors) process.stdout.write(`  ${e.ref}: ${e.error}\n`);
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
	const created = lastRun.filter((e) => e.action === "task-created").length;
	const dedup = lastRun.filter((e) => e.action === "task-skipped").length;
	const contacts = lastRun.filter((e) => e.action === "contact-created").length;
	const skipped = lastRun.filter((e) => e.action === "boleto-skipped").length;
	const warns = lastRun.filter((e) => e.action === "warn").length;
	const errors = lastRun.filter((e) => e.action === "error").length;
	const limit_reached = lastRun.some((e) => e.action === "limit-reached");

	const out = {
		last_run_id: lastId,
		started_at: start?.ts ?? null,
		ended_at: end?.ts ?? null,
		tasks_created: created,
		tasks_dedup_skipped: dedup,
		contacts_created: contacts,
		boletos_skipped: skipped,
		warns,
		errors,
		limit_reached,
		total_runs: runIds.length,
		log_file: LOG_FILE,
	};

	if (opts.json) {
		process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
		return;
	}

	process.stdout.write(`régua pré-vencimento v2 — status\n`);
	process.stdout.write(`log: ${LOG_FILE}\n`);
	process.stdout.write(`total de runs: ${out.total_runs}\n`);
	process.stdout.write(`último run: ${out.last_run_id}\n`);
	process.stdout.write(`  iniciado: ${out.started_at ?? "?"}\n`);
	process.stdout.write(`  encerrado: ${out.ended_at ?? "(incompleto)"}\n`);
	process.stdout.write(`  tasks criadas:    ${out.tasks_created}\n`);
	process.stdout.write(`  tasks dedup:      ${out.tasks_dedup_skipped}\n`);
	process.stdout.write(`  contatos criados: ${out.contacts_created}\n`);
	process.stdout.write(`  boletos pulados:  ${out.boletos_skipped}\n`);
	process.stdout.write(`  warns:            ${out.warns}\n`);
	process.stdout.write(`  erros:            ${out.errors}\n`);
	if (out.limit_reached)
		process.stdout.write(`  ⚠ limite diário atingido neste run\n`);
}

// ---------- main ----------

const program = new Command();
program
	.name("sde-regua-pre-vencimento")
	.description(
		[
			"Régua pré-vencimento de boletos SDE (v2 — tasks CRM diretas).",
			"",
			"Operado pelo jarvis-financ (cron 6h BRT). Lê boletos A_RECEBER do Banco Inter",
			"em janela D+0..D+2, resolve telefone via Tiny e cria UMA task CRM por boleto",
			"(owner=agent:sde-dispatcher). O dispatcher envia prévias nos crons 8h/12h/16h.",
			"",
			"Tipo de notificação por vencimento:",
			"  dias_ate_venc == 0 → VENCIMENTO_HOJE",
			"  dias_ate_venc == 1 → LEMBRETE_2DIAS (lembrete 1 dia antes)",
			"  dias_ate_venc == 2 → LEMBRETE_2DIAS",
			"",
			"Idempotência: jarvis-financ:<codigoSolicitacao>:<tipo>:<data_venc>",
			"",
			`Pipeline (env SDE_COBRANCA_PIPELINE_SLUG): ${PIPELINE_SLUG}`,
			`Instância (env SDE_DISPATCHER_INSTANCE): ${INSTANCE}`,
			`Limite diário (env SDE_REGUA_DAILY_LIMIT): ${DEFAULT_LIMIT}`,
			`Log JSONL: ${LOG_FILE}`,
			"",
			"Spec: /home/ravi/main-kimi/specs/sde-regua-pre-vencimento-v2.md",
		].join("\n"),
	)
	.version(VERSION);

program
	.command("preview")
	.description("Lista tasks CRM que seriam criadas (dry-run, sem efeitos)")
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
	.description(
		"Cria contatos faltantes e tasks CRM (owner=sde-dispatcher) com idempotency-key",
	)
	.option("--json", "Output JSON em stdout")
	.option("--limit <n>", `Máximo de tasks neste run (default ${DEFAULT_LIMIT})`)
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
