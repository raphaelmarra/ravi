#!/usr/bin/env bun
// sde-regua-pre-vencimento — régua pré-vencimento de boletos SDE
//
// Orquestrador domain-specific (jarvis-financ). Wraps:
//   sde bancointer boletos          — fonte dos boletos A_RECEBER
//   sde tiny conta-receber <id>     — resolve seuNumero → telefone/nome
//   ravi contacts find|add|tag      — sincroniza tags boleto:* no Ravi
//
// Spec: /home/ravi/main-kimi/specs/sde-regua-pre-vencimento.md §4.1
// Operação: cron diário 6h BRT no jarvis-financ
//
// Subcomandos:
//   preview   dry-run; lista o que faria
//   apply     aplica tags + cria contatos + escreve JSONL
//   status    resumo do último run a partir do JSONL

import { Command } from "commander";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const LOG_DIR = join(homedir(), ".ravi", "jarvis-financ");
const LOG_FILE = join(LOG_DIR, "regua-pre-vencimento.log");
const VERSION = "0.1.0";

type Tag = "boleto:emitido" | "boleto:vence-em-2d" | "boleto:vence-hoje";
const ALL_TAGS: Tag[] = ["boleto:emitido", "boleto:vence-em-2d", "boleto:vence-hoje"];

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
		displayName?: string;
		identities?: Array<{ identity?: string }>;
	}>;
}

interface PlanItem {
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
	contato_existe: boolean;
	contato_id: string | null;
	contato_nome_existente: string | null;
	tags_a_remover: Tag[];
	tiny_warning: string | null;
}

interface LogEntry {
	ts: string;
	run_id: string;
	run_date: string;
	action:
		| "run-start"
		| "run-end"
		| "tag-applied"
		| "tag-skipped-already-applied"
		| "tag-removed"
		| "contact-created"
		| "contact-found"
		| "boleto-skipped"
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
	if (dias === 2) return { tag: "boleto:vence-em-2d", skip_reason: null };
	if (dias === 1) return { tag: null, skip_reason: "dia-1-fora-da-regua-spec" };
	if (dias >= 3) return { tag: "boleto:emitido", skip_reason: null };
	return { tag: null, skip_reason: "fora-da-janela" };
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

function alreadyAppliedToday(idem: string, runDate: string, log: LogEntry[]): boolean {
	return log.some(
		(e) =>
			e.action === "tag-applied" &&
			e.idempotency_key === idem &&
			e.run_date === runDate &&
			e.dry_run === false,
	);
}

// ---------- ravi contacts ----------

function findContactByPhone(phone: string): {
	id: string | null;
	displayName: string | null;
	tags: Tag[];
} {
	const resp = jsonCmd<RaviContactsFindResp>("ravi", ["contacts", "find", phone]);
	if (resp.total === 0 || resp.contacts.length === 0) {
		return { id: null, displayName: null, tags: [] };
	}
	const c = resp.contacts[0];
	const id = c?.id ?? c?.canonicalIdentity ?? c?.primaryIdentity ?? null;
	const displayName = c?.displayName ?? null;
	let tags: Tag[] = [];
	if (id) {
		try {
			interface ContactShowResp {
				tags?: string[];
				contact?: { tags?: string[] };
			}
			const show = jsonCmd<ContactShowResp>("ravi", ["contacts", "show", id]);
			const rawTags = show.tags ?? show.contact?.tags ?? [];
			tags = rawTags.filter((t): t is Tag => ALL_TAGS.includes(t as Tag));
		} catch {
			// non-fatal: if show fails, we proceed without knowing existing tags
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

function buildPlan(today: string): PlanItem[] {
	const fim = addDaysISO(today, 7);
	const boletos = fetchBoletos({ inicio: today, fim });

	const items: PlanItem[] = [];
	for (const b of boletos) {
		const dias = diffDays(b.dataVencimento, today);
		const { tag, skip_reason } = targetTag(dias);

		const item: PlanItem = {
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
			contato_existe: false,
			contato_id: null,
			contato_nome_existente: null,
			tags_a_remover: [],
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
			items.push(item);
			continue;
		}

		const found = findContactByPhone(item.telefone_norm);
		item.contato_existe = Boolean(found.id);
		item.contato_id = found.id;
		item.contato_nome_existente = found.displayName;
		item.tags_a_remover = found.tags.filter((t) => t !== tag);

		items.push(item);
	}

	return items;
}

// ---------- output formatting ----------

function fmtItem(i: PlanItem): string {
	const tag = i.tag_alvo ?? "(skip)";
	const reason = i.skip_reason ? ` [skip: ${i.skip_reason}]` : "";
	const phone = i.telefone_norm ?? i.telefone_raw ?? "(sem fone)";
	const contato = i.contato_existe
		? `contato#${i.contato_id?.slice(0, 12) ?? "?"}`
		: i.telefone_norm
			? "NOVO"
			: "—";
	const rem = i.tags_a_remover.length > 0 ? ` rem=[${i.tags_a_remover.join(",")}]` : "";
	const warn = i.tiny_warning ? ` ⚠ ${i.tiny_warning}` : "";
	return [
		`  ${i.data_vencimento}`,
		`d=${String(i.dias_ate_venc).padStart(2, " ")}`,
		`R$${i.valor.padStart(9, " ")}`,
		tag.padEnd(20, " "),
		phone.padEnd(15, " "),
		contato.padEnd(20, " "),
		i.pagador_nome,
		rem,
		reason,
		warn,
	].join(" ");
}

interface RunSummary {
	dry_run: boolean;
	total: number;
	skipped: number;
	would_create: number;
	would_apply: number;
	would_remove: number;
	by_tag: Record<string, number>;
}

function summarize(plan: PlanItem[], dryRun: boolean): RunSummary {
	const by_tag: Record<string, number> = {};
	let skipped = 0;
	let wouldCreate = 0;
	let wouldApply = 0;
	let wouldRemove = 0;
	for (const i of plan) {
		if (!i.tag_alvo || i.skip_reason) {
			skipped++;
			continue;
		}
		by_tag[i.tag_alvo] = (by_tag[i.tag_alvo] ?? 0) + 1;
		wouldApply++;
		wouldRemove += i.tags_a_remover.length;
		if (!i.contato_existe) wouldCreate++;
	}
	return {
		dry_run: dryRun,
		total: plan.length,
		skipped,
		would_create: wouldCreate,
		would_apply: wouldApply,
		would_remove: wouldRemove,
		by_tag,
	};
}

// ---------- subcommands ----------

interface CmdOpts {
	json?: boolean;
}

function cmdPreview(opts: CmdOpts): void {
	const today = todayISO();
	const plan = buildPlan(today);
	const summary = summarize(plan, true);

	if (opts.json) {
		process.stdout.write(`${JSON.stringify({ today, summary, plan }, null, 2)}\n`);
		return;
	}

	process.stdout.write(`régua pré-vencimento — preview (dry-run)\n`);
	process.stdout.write(`hoje=${today}  janela=${today} → ${addDaysISO(today, 7)}\n`);
	process.stdout.write(`boletos elegíveis: ${plan.length}\n\n`);
	for (const i of plan) process.stdout.write(`${fmtItem(i)}\n`);
	process.stdout.write(
		`\nresumo: aplicaria ${summary.would_apply} tag(s) em ${summary.would_apply - summary.would_create} contato(s) existentes + ${summary.would_create} novo(s); removeria ${summary.would_remove} tag(s) obsoleta(s); pulou ${summary.skipped}.\n`,
	);
	for (const [t, n] of Object.entries(summary.by_tag)) {
		process.stdout.write(`  ${t}: ${n}\n`);
	}
}

function cmdApply(opts: CmdOpts): void {
	const today = todayISO();
	const runId = `run_${today}_${Date.now()}`;
	const log = readLog();

	appendLog({
		ts: new Date().toISOString(),
		run_id: runId,
		run_date: today,
		action: "run-start",
		dry_run: false,
		message: "régua pré-vencimento iniciada",
	});

	const plan = buildPlan(today);
	const result = {
		applied: [] as Array<{ contact: string; tag: Tag; created: boolean }>,
		removed: [] as Array<{ contact: string; tag: Tag }>,
		skipped: [] as Array<{ codigoSolicitacao: string; reason: string }>,
		errors: [] as Array<{ codigoSolicitacao: string; error: string }>,
	};

	for (const i of plan) {
		if (!i.tag_alvo) {
			result.skipped.push({
				codigoSolicitacao: i.codigoSolicitacao,
				reason: i.skip_reason ?? "sem-tag",
			});
			appendLog({
				ts: new Date().toISOString(),
				run_id: runId,
				run_date: today,
				action: "boleto-skipped",
				dry_run: false,
				codigoSolicitacao: i.codigoSolicitacao,
				seuNumero: i.seuNumero,
				nome: i.pagador_nome,
				dias_ate_venc: i.dias_ate_venc,
				message: i.skip_reason ?? "sem-tag",
			});
			continue;
		}

		if (i.skip_reason || !i.telefone_norm) {
			result.skipped.push({
				codigoSolicitacao: i.codigoSolicitacao,
				reason: i.skip_reason ?? "sem-telefone-resolvivel",
			});
			appendLog({
				ts: new Date().toISOString(),
				run_id: runId,
				run_date: today,
				action: "warn",
				dry_run: false,
				codigoSolicitacao: i.codigoSolicitacao,
				seuNumero: i.seuNumero,
				nome: i.pagador_nome,
				dias_ate_venc: i.dias_ate_venc,
				tag_alvo: i.tag_alvo,
				message: i.skip_reason ?? "sem-telefone-resolvivel",
			});
			continue;
		}

		const idem = `${i.telefone_norm}:${i.tag_alvo}:${i.data_vencimento}`;
		if (alreadyAppliedToday(idem, today, log)) {
			result.skipped.push({
				codigoSolicitacao: i.codigoSolicitacao,
				reason: "ja-aplicada-hoje",
			});
			appendLog({
				ts: new Date().toISOString(),
				run_id: runId,
				run_date: today,
				action: "tag-skipped-already-applied",
				dry_run: false,
				codigoSolicitacao: i.codigoSolicitacao,
				telefone: i.telefone_norm,
				nome: i.pagador_nome,
				tag_alvo: i.tag_alvo,
				idempotency_key: idem,
			});
			continue;
		}

		let contactRef = i.contato_id ?? i.telefone_norm;
		let created = false;
		if (!i.contato_existe) {
			const c = createContact(i.telefone_norm, i.pagador_nome || "Cliente SDE", false);
			if (!c.ok) {
				result.errors.push({
					codigoSolicitacao: i.codigoSolicitacao,
					error: `contact-add:${c.error}`,
				});
				appendLog({
					ts: new Date().toISOString(),
					run_id: runId,
					run_date: today,
					action: "error",
					dry_run: false,
					codigoSolicitacao: i.codigoSolicitacao,
					telefone: i.telefone_norm,
					nome: i.pagador_nome,
					message: `contact-add falhou: ${c.error}`,
				});
				continue;
			}
			created = true;
			contactRef = i.telefone_norm;
			appendLog({
				ts: new Date().toISOString(),
				run_id: runId,
				run_date: today,
				action: "contact-created",
				dry_run: false,
				telefone: i.telefone_norm,
				nome: i.pagador_nome,
			});
		}

		const tagRes = tagContact(contactRef, i.tag_alvo, false);
		if (!tagRes.ok) {
			result.errors.push({
				codigoSolicitacao: i.codigoSolicitacao,
				error: `tag:${tagRes.error}`,
			});
			appendLog({
				ts: new Date().toISOString(),
				run_id: runId,
				run_date: today,
				action: "error",
				dry_run: false,
				codigoSolicitacao: i.codigoSolicitacao,
				telefone: i.telefone_norm,
				tag_alvo: i.tag_alvo,
				message: `tag falhou: ${tagRes.error}`,
			});
			continue;
		}
		result.applied.push({ contact: contactRef, tag: i.tag_alvo, created });
		appendLog({
			ts: new Date().toISOString(),
			run_id: runId,
			run_date: today,
			action: "tag-applied",
			dry_run: false,
			codigoSolicitacao: i.codigoSolicitacao,
			seuNumero: i.seuNumero,
			telefone: i.telefone_norm,
			nome: i.pagador_nome,
			dias_ate_venc: i.dias_ate_venc,
			tag_alvo: i.tag_alvo,
			idempotency_key: idem,
		});

		for (const obsTag of i.tags_a_remover) {
			const r = untagContact(contactRef, obsTag, false);
			if (!r.ok) {
				appendLog({
					ts: new Date().toISOString(),
					run_id: runId,
					run_date: today,
					action: "warn",
					dry_run: false,
					codigoSolicitacao: i.codigoSolicitacao,
					telefone: i.telefone_norm,
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
				codigoSolicitacao: i.codigoSolicitacao,
				telefone: i.telefone_norm,
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
		message: `applied=${result.applied.length} removed=${result.removed.length} skipped=${result.skipped.length} errors=${result.errors.length}`,
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
	process.stdout.write(`puladas:   ${result.skipped.length}\n`);
	process.stdout.write(`erros:     ${result.errors.length}\n`);
	if (result.errors.length > 0) {
		process.stdout.write(`\nerros:\n`);
		for (const e of result.errors) {
			process.stdout.write(`  ${e.codigoSolicitacao}: ${e.error}\n`);
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
	const created = lastRun.filter((e) => e.action === "contact-created").length;
	const skipped = lastRun.filter(
		(e) => e.action === "boleto-skipped" || e.action === "tag-skipped-already-applied",
	).length;
	const warns = lastRun.filter((e) => e.action === "warn").length;
	const errors = lastRun.filter((e) => e.action === "error").length;

	const out = {
		last_run_id: lastId,
		started_at: start?.ts ?? null,
		ended_at: end?.ts ?? null,
		applied,
		removed,
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
			"resolve telefone via Tiny, sincroniza tags boleto:* no Ravi:",
			"  dias_ate_venc == 0  → boleto:vence-hoje",
			"  dias_ate_venc == 2  → boleto:vence-em-2d",
			"  dias_ate_venc >= 3  → boleto:emitido",
			"",
			"Idempotência: dedup por (telefone, tag, data_venc) no JSONL.",
			`Log: ${LOG_FILE}`,
			"",
			"Spec: /home/ravi/main-kimi/specs/sde-regua-pre-vencimento.md §4.1",
		].join("\n"),
	)
	.version(VERSION);

program
	.command("preview")
	.description("Lista boletos elegíveis e o que seria feito (dry-run, sem efeitos)")
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
	.description("Cria contatos faltantes, aplica tags alvo e remove tags obsoletas")
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
