"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import type { Actor, Role } from "@/lib/domain/types";
import type { PendingHumanRequest } from "@/lib/approvals/types";

const ROLE_LABEL: Record<Role, string> = {
  medico: "Médico/a",
  recepcion: "Recepción",
  paciente: "Paciente",
};

const SCENARIOS: Record<Role, { label: string; text: string }[]> = {
  medico: [
    { label: "Mi agenda de mañana", text: "¿Qué turnos tengo mañana?" },
    { label: "Ficha de un paciente", text: "Traeme la ficha de Jorge Fernández." },
    { label: "Pendientes de aprobar", text: "¿Qué tengo pendiente de aprobar?" },
    { label: "Renovar receta (directo)", text: "Renová la receta de Apixabán 5 mg de Jorge Fernández." },
  ],
  recepcion: [
    {
      label: "Pedido de receta → aprobación",
      text: "Llamó Jorge Fernández (DNI 20.999.888), quiere renovar la receta de Apixabán.",
    },
    {
      label: "Homónimo + cancelación < 24 h",
      text: "Una paciente de apellido Gómez quiere cancelar el turno que tiene mañana.",
    },
    {
      label: "Reembolso alto → aprobación",
      text: "Lucía Ortiz (DNI 39.222.777) reclama que le devuelvan los $180.000 de la resonancia.",
    },
    {
      label: "Alta de paciente",
      text: "Dá de alta a Carla Ruiz, DNI 45.888.111, nació el 1999-09-20, cobertura Swiss Medical SMG40.",
    },
  ],
  paciente: [
    { label: "Mis turnos", text: "¿Qué turnos tengo?" },
    { label: "Sacar un turno", text: "Quiero un turno de control la semana que viene a la mañana." },
    { label: "Renovar mi receta", text: "Necesito renovar mi receta." },
    {
      label: "Consulta clínica",
      text: "Tengo un dolor en el pecho desde ayer, ¿es grave? ¿qué me conviene tomar?",
    },
  ],
};

const PANEL_TITLE: Record<Role, string> = {
  medico: "Bandeja de aprobaciones",
  recepcion: "Pedidos enviados al médico/a",
  paciente: "Tus pedidos en revisión",
};

export function ChatApp({ actor }: { actor: Actor }) {
  const router = useRouter();
  const transport = useMemo(() => new DefaultChatTransport({ api: "/api/chat" }), []);
  const { messages, sendMessage, status, error } = useChat({ transport });
  const [input, setInput] = useState("");
  const busy = status === "submitted" || status === "streaming";

  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, status]);

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.replace("/login");
    router.refresh();
  }

  function submit() {
    const text = input.trim();
    if (!text) return;
    sendMessage({ text });
    setInput("");
  }

  const wide = actor.role !== "paciente";
  return (
    <main
      className={`mx-auto flex w-full flex-col gap-4 p-4 md:h-[100dvh] md:flex-row md:overflow-hidden md:p-6 ${
        wide ? "max-w-6xl" : "max-w-4xl"
      }`}
    >
      <section className="flex min-h-[65vh] flex-1 flex-col overflow-hidden rounded-xl border border-hairline bg-surface shadow-card md:min-h-0">
        <header className="flex items-center justify-between border-b border-hairline px-5 py-3.5">
          <div className="space-y-0.5">
            <h1 className="text-[15px] font-semibold tracking-tight text-ink">CLAVDOA Secretario médico</h1>
            <p className="text-[12px] text-muted">
              {actor.name}
              {actor.specialty ? ` · ${actor.specialty}` : ` · ${ROLE_LABEL[actor.role]}`}
            </p>
          </div>
          <button
            onClick={logout}
            className="rounded-pill border border-hairline px-3.5 py-1.5 text-[12px] font-semibold text-muted transition-colors hover:border-ink hover:text-ink"
          >
            Salir
          </button>
        </header>

        <div ref={scrollRef} className="flex-1 space-y-5 overflow-y-auto overscroll-contain px-5 py-6">
          {messages.length === 0 && (
            <div className="flex h-full flex-col justify-center gap-4">
              <p className="text-center text-[14px] text-muted">
                ¿En qué te ayudo? Probá uno de estos:
              </p>
              <div className="flex flex-wrap justify-center gap-2">
                {SCENARIOS[actor.role].map((s) => (
                  <button
                    key={s.label}
                    onClick={() => sendMessage({ text: s.text })}
                    className="rounded-pill border border-hairline bg-surface px-4 py-2 text-[13px] font-medium text-ink transition-colors hover:border-ink"
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((m) => (
            <MessageBubble key={m.id} role={m.role} parts={m.parts as Part[]} />
          ))}

          {status === "submitted" && (
            <p className="text-[12px] text-muted">
              <span className="animate-pulse">●</span> pensando…
            </p>
          )}
          {error && (
            <p className="text-[13px] text-[#c0392b]">
              Error: {error.message}. ¿Está seteada <code>ANTHROPIC_API_KEY</code> y con saldo?
            </p>
          )}
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
          className="flex items-center gap-2 border-t border-hairline p-3.5"
        >
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={actor.role === "paciente" ? "Escribí tu consulta…" : "Escribí un mensaje…"}
            className="flex-1 rounded-pill border border-hairline bg-canvas px-4 py-2.5 text-[15px] text-ink placeholder:text-muted/70 transition-colors focus:border-ink focus:bg-surface focus:outline-none"
          />
          <button
            type="submit"
            disabled={busy || !input.trim()}
            className="shrink-0 rounded-pill bg-ink px-5 py-2.5 text-[14px] font-semibold text-white transition-colors hover:bg-ink-hover disabled:opacity-40"
          >
            Enviar
          </button>
        </form>
      </section>

      <div
        className={`flex w-full flex-col gap-4 overflow-y-auto md:min-h-0 ${
          actor.role === "paciente" ? "md:w-72" : "md:w-96"
        }`}
      >
        {actor.role !== "recepcion" && (
          <AgendaPanel actor={actor} onSend={(text) => sendMessage({ text })} />
        )}
        {actor.role !== "recepcion" && <CalendarPanel />}
        <ApprovalsPanel actor={actor} />
      </div>
    </main>
  );
}

type Part = { type: string; [k: string]: unknown };

function renderInline(text: string, keyBase: string) {
  return text.split(/(\*\*[^*]+\*\*|\*[^*\n]+\*)/g).map((p, i) => {
    const key = `${keyBase}-${i}`;
    if (/^\*\*[^*]+\*\*$/.test(p))
      return (
        <strong key={key} className="font-semibold">
          {p.slice(2, -2)}
        </strong>
      );
    if (/^\*[^*\n]+\*$/.test(p))
      return (
        <em key={key} className="italic">
          {p.slice(1, -1)}
        </em>
      );
    return <span key={key}>{p}</span>;
  });
}

/** Minimal Markdown for the agent's replies: headings, bold, bullets, quotes, rules. */
function Markdown({ text }: { text: string }) {
  const blocks: React.ReactNode[] = [];
  let list: string[] = [];
  const flush = (k: string) => {
    if (!list.length) return;
    blocks.push(
      <ul key={`${k}-ul`} className="my-1 list-disc space-y-0.5 pl-5">
        {list.map((li, i) => (
          <li key={i}>{renderInline(li, `${k}-${i}`)}</li>
        ))}
      </ul>,
    );
    list = [];
  };

  text.split("\n").forEach((raw, i) => {
    const line = raw.trimEnd();
    const k = `l${i}`;
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flush(k);
      blocks.push(<hr key={k} className="my-2.5 border-hairline" />);
    } else if (/^#{1,4}\s+/.test(line)) {
      flush(k);
      blocks.push(
        <p key={k} className="mt-2 mb-0.5 text-[15px] font-semibold">
          {renderInline(line.replace(/^#{1,4}\s+/, ""), k)}
        </p>,
      );
    } else if (/^\s*[-*]\s+/.test(line)) {
      list.push(line.replace(/^\s*[-*]\s+/, ""));
    } else if (/^>\s?/.test(line)) {
      flush(k);
      blocks.push(
        <blockquote key={k} className="my-1 border-l-2 border-hairline-strong pl-3 text-ink/80">
          {renderInline(line.replace(/^>\s?/, ""), k)}
        </blockquote>,
      );
    } else if (line.trim() === "") {
      flush(k);
    } else {
      flush(k);
      blocks.push(<p key={k}>{renderInline(line, k)}</p>);
    }
  });
  flush("end");
  return <div className="space-y-1.5">{blocks}</div>;
}

const TOOL_LABELS: Record<string, string> = {
  getClinicInfo: "Datos del consultorio",
  findPatient: "Buscando al paciente",
  getPatientBriefing: "Resumen del paciente",
  listMyAgenda: "Agenda",
  listPendingApprovals: "Bandeja de aprobaciones",
  listAvailableSlots: "Turnos disponibles",
  scheduleAppointment: "Agendando turno",
  cancelAppointment: "Cancelando turno",
  rescheduleAppointment: "Reprogramando turno",
  createPrescriptionRenewal: "Renovación de receta",
  sendPatientMessage: "Mensaje al paciente",
  refundInvoice: "Reembolso",
  registerPatient: "Alta de paciente",
  registerProfessional: "Alta de profesional",
  requestHumanApproval: "Pedido de aprobación",
  askHumanInput: "Consulta a una persona",
};

function toolNameOf(part: Part): string {
  return part.type === "dynamic-tool"
    ? String((part as { toolName?: string }).toolName ?? "tool")
    : part.type.slice(5);
}

function ToolLine({ part }: { part: Part }) {
  const name = toolNameOf(part);
  const done = String((part as { state?: string }).state ?? "") === "output-available";
  const label = TOOL_LABELS[name] ?? name;
  const hitl = name === "requestHumanApproval" || name === "askHumanInput";

  if (hitl && !done) {
    return (
      <p className="pl-0.5 text-[13px] font-medium text-[#9a6a1f]">
        ⏸ Esperando la respuesta de una persona…
      </p>
    );
  }
  return (
    <p className="flex items-center gap-1.5 pl-0.5 text-[12px] text-muted">
      <span className={done ? "text-[#2e7d5b]" : "animate-pulse"}>{done ? "✓" : "○"}</span>
      {label}
    </p>
  );
}

function MessageBubble({ role, parts }: { role: string; parts: Part[] }) {
  const isUser = role === "user";
  const toolParts = parts.filter(
    (p) => p.type === "dynamic-tool" || p.type.startsWith("tool-"),
  );
  const text = parts
    .filter((p) => p.type === "text")
    .map((p) => String((p as { text?: string }).text ?? ""))
    .join("\n")
    .trim();

  return (
    <div className="space-y-2">
      {!isUser && toolParts.map((p, i) => <ToolLine key={i} part={p} />)}
      {(text || isUser) && (
        <div className={isUser ? "flex justify-end" : "flex justify-start"}>
          <div
            className={`max-w-[85%] rounded-xl px-4 py-2.5 text-[15px] leading-relaxed ${
              isUser ? "bg-ink text-white" : "bg-canvas text-ink"
            }`}
          >
            {isUser ? <p className="whitespace-pre-wrap">{text}</p> : <Markdown text={text} />}
          </div>
        </div>
      )}
    </div>
  );
}

const CARD = "flex w-full shrink-0 flex-col gap-3 rounded-xl border border-hairline bg-surface p-5 shadow-card";

type AgendaData =
  | {
      role: "medico";
      clock: string;
      running: "en horario" | "atrasada" | "adelantada";
      offsetMinutes: number;
      attendedToday: number;
      inAttention: { appointmentId: string; patientName: string; scheduled: string } | null;
      next: {
        appointmentId: string;
        patientName: string;
        reason: string;
        scheduled: string;
        estimated: string;
        isBirthday: boolean;
      } | null;
      upcoming: { patientName: string; scheduled: string; estimated: string }[];
      briefing: string | null;
    }
  | {
      role: "paciente";
      hasVisit: boolean;
      provider?: string;
      reason?: string;
      scheduled?: string | null;
      estimated?: string | null;
      delayMinutes?: number;
      running?: string;
      earlierAt?: string | null;
      inProgress?: boolean;
      notices: string[];
    }
  | { role: "recepcion"; unsupported: true };

function runningBadge(running: string, offset: number) {
  if (running === "atrasada")
    return { text: `+${offset} min`, cls: "bg-[#fbf1e3] text-[#9a6a1f]" };
  if (running === "adelantada")
    return { text: `${offset} min`, cls: "bg-[#e6f4ec] text-[#2e7d5b]" };
  return { text: "en horario", cls: "bg-canvas text-muted" };
}

function AgendaPanel({ actor, onSend }: { actor: Actor; onSend: (t: string) => void }) {
  const [data, setData] = useState<AgendaData | null>(null);

  useEffect(() => {
    const load = async () => {
      try {
        const r = await fetch("/api/agenda", { cache: "no-store" });
        if (r.ok) setData(await r.json());
      } catch {
        /* ignore */
      }
    };
    load();
    const id = setInterval(load, 3000);
    return () => clearInterval(id);
  }, []);

  if (!data) return null;

  if (data.role === "medico") {
    const badge = runningBadge(data.running, data.offsetMinutes);
    return (
      <aside className={CARD}>
        <div className="flex items-center justify-between">
          <h2 className="text-[15px] font-semibold tracking-tight text-ink">Consultorio · ahora</h2>
          <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${badge.cls}`}>
            {data.clock} · {badge.text}
          </span>
        </div>

        {data.inAttention ? (
          <div className="space-y-2 rounded-lg border border-hairline p-3.5">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">En atención</p>
            <p className="text-[14px] font-semibold text-ink">{data.inAttention.patientName}</p>
            <p className="text-[12px] text-muted">desde las {data.inAttention.scheduled}</p>
            <button
              onClick={() => onSend(`Terminé de atender a ${data.inAttention!.patientName} (${data.inAttention!.appointmentId}).`)}
              className="w-full rounded-md bg-ink px-2 py-2 text-[13px] font-semibold text-white transition-colors hover:bg-ink-hover"
            >
              Terminé
            </button>
            <p className="text-[11px] text-muted/80">
              Si duró distinto, decímelo en el chat (“duró 50 minutos”).
            </p>
          </div>
        ) : data.next ? (
          <div className="space-y-2 rounded-lg border border-hairline p-3.5">
            <div className="flex items-center justify-between">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">Próximo</p>
              {data.next.isBirthday && (
                <span className="rounded-full bg-[#fbecec] px-2 py-0.5 text-[11px] font-semibold text-[#b23b3b]">
                  🎂 cumple años
                </span>
              )}
            </div>
            <p className="text-[14px] font-semibold text-ink">{data.next.patientName}</p>
            <p className="text-[12px] text-muted">
              {data.next.reason} · {data.next.scheduled}
              {data.next.estimated !== data.next.scheduled ? ` → ~${data.next.estimated}` : ""}
            </p>
            {data.briefing && (
              <p className="whitespace-pre-wrap text-[12px] leading-relaxed text-ink/80">
                {data.briefing}
              </p>
            )}
            <button
              onClick={() => onSend(`Iniciá la atención de ${data.next!.patientName} (${data.next!.appointmentId}).`)}
              className="w-full rounded-md bg-[#2e7d5b] px-2 py-2 text-[13px] font-semibold text-white transition-opacity hover:opacity-90"
            >
              Iniciar atención
            </button>
          </div>
        ) : (
          <p className="text-[13px] text-muted">No quedan pacientes en la agenda de hoy.</p>
        )}

        {data.upcoming.length > 0 && (
          <div className="space-y-1">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">En espera</p>
            {data.upcoming.map((u, i) => (
              <p key={i} className="text-[12px] text-muted">
                {u.scheduled}
                {u.estimated !== u.scheduled ? ` → ~${u.estimated}` : ""} · {u.patientName}
              </p>
            ))}
          </div>
        )}
      </aside>
    );
  }

  if (data.role === "paciente") {
    if (!data.hasVisit) {
      return (
        <aside className={CARD}>
          <h2 className="text-[15px] font-semibold tracking-tight text-ink">Tu turno de hoy</h2>
          <p className="text-[13px] text-muted">No tenés turno para hoy.</p>
          {data.notices.map((n, i) => (
            <p key={i} className="rounded-lg bg-canvas p-2.5 text-[12px] text-ink/80">{n}</p>
          ))}
        </aside>
      );
    }
    const delayed = (data.delayMinutes ?? 0) >= 10;
    return (
      <aside className={CARD}>
        <h2 className="text-[15px] font-semibold tracking-tight text-ink">Tu turno de hoy</h2>
        <div className="rounded-lg border border-hairline p-3.5">
          <p className="text-[22px] font-semibold text-ink">
            {data.scheduled}
            {data.estimated && data.estimated !== data.scheduled && (
              <span className="text-muted"> → ~{data.estimated}</span>
            )}
          </p>
          <p className="text-[12px] text-muted">
            {data.provider} · {data.reason}
          </p>
          <p className="mt-1 text-[12px]">
            {data.inProgress
              ? "El profesional te va a llamar en breve."
              : delayed
                ? `La agenda va demorada (+${data.delayMinutes} min).`
                : data.running === "adelantada"
                  ? "El profesional va adelantado."
                  : "En horario."}
          </p>
        </div>

        {data.notices.map((n, i) => (
          <p key={i} className="rounded-lg bg-canvas p-2.5 text-[12px] text-ink/80">{n}</p>
        ))}

        <div className="flex flex-wrap gap-2">
          {delayed && (
            <button
              onClick={() => onSend("Gracias por avisar, voy a ir más tarde entonces.")}
              className="rounded-md border border-hairline px-3 py-1.5 text-[12px] font-semibold text-ink hover:border-ink"
            >
              Voy más tarde
            </button>
          )}
          {data.earlierAt && (
            <button
              onClick={() => onSend(`¿Puedo ir más temprano? Vi que hay lugar ${data.earlierAt}.`)}
              className="rounded-md bg-ink px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-ink-hover"
            >
              Ir más temprano ({data.earlierAt})
            </button>
          )}
        </div>
      </aside>
    );
  }

  return null;
}

type CalItem = {
  time: string;
  who: string;
  reason: string;
  status: "scheduled" | "in-progress" | "completed" | "cancelled";
  birthday: boolean;
  estimated?: string;
};
type CalData = { title: string; days: { date: string; label: string; free?: number; items: CalItem[] }[] };

const STATUS_DOT: Record<CalItem["status"], string> = {
  scheduled: "bg-hairline-strong",
  "in-progress": "bg-[#2e7d5b]",
  completed: "bg-[#2e7d5b]/40",
  cancelled: "bg-[#b23b3b]/50",
};

function CalendarPanel() {
  const [data, setData] = useState<CalData | null>(null);

  useEffect(() => {
    const load = async () => {
      try {
        const r = await fetch("/api/calendar", { cache: "no-store" });
        if (r.ok) setData(await r.json());
      } catch {
        /* ignore */
      }
    };
    load();
    const id = setInterval(load, 4000);
    return () => clearInterval(id);
  }, []);

  if (!data) return null;

  return (
    <aside className={CARD}>
      <h2 className="text-[15px] font-semibold tracking-tight text-ink">{data.title}</h2>
      {data.days.length === 0 && (
        <p className="text-[13px] text-muted">No hay turnos agendados.</p>
      )}
      <div className="space-y-3">
        {data.days.map((d) => (
          <div key={d.date} className="space-y-1.5">
            <div className="flex items-baseline justify-between">
              <p className="text-[12px] font-semibold capitalize text-ink">{d.label}</p>
              {typeof d.free === "number" && (
                <p className="text-[11px] text-muted">{d.free} libres</p>
              )}
            </div>
            {d.items.map((it, i) => (
              <div key={i} className="flex gap-2.5 rounded-lg border border-hairline px-2.5 py-2">
                <span
                  className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_DOT[it.status]}`}
                  aria-hidden
                />
                <div className="min-w-0 flex-1">
                  <p className="text-[12px] font-semibold tabular-nums text-ink">
                    {it.time}
                    {it.estimated && it.estimated !== it.time && (
                      <span className="ml-1 font-normal text-[#9a6a1f]">~{it.estimated}</span>
                    )}
                    {it.birthday && <span className="ml-1"> 🎂</span>}
                  </p>
                  <p className="truncate text-[12px] text-ink/90">{it.who}</p>
                  <p className="truncate text-[11px] text-muted">{it.reason}</p>
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
    </aside>
  );
}

function ApprovalsPanel({ actor }: { actor: Actor }) {
  const [data, setData] = useState<{ slackEnabled: boolean; pending: PendingHumanRequest[] }>({
    slackEnabled: false,
    pending: [],
  });

  async function refresh() {
    try {
      const r = await fetch("/api/approvals", { cache: "no-store" });
      if (r.ok) setData(await r.json());
    } catch {
      /* ignore */
    }
  }

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 2000);
    return () => clearInterval(id);
  }, []);

  const readOnly = actor.role === "paciente";

  return (
    <aside className="flex w-full shrink-0 flex-col gap-3 rounded-xl border border-hairline bg-surface p-5 shadow-card">
      <div className="flex items-center justify-between">
        <h2 className="text-[15px] font-semibold tracking-tight text-ink">{PANEL_TITLE[actor.role]}</h2>
        <span
          className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${
            data.slackEnabled ? "bg-[#e6f4ec] text-[#2e7d5b]" : "bg-canvas text-muted"
          }`}
        >
          Slack {data.slackEnabled ? "conectado" : "off"}
        </span>
      </div>

      {data.pending.length === 0 && (
        <p className="text-[13px] text-muted">
          {readOnly
            ? "No tenés pedidos en revisión."
            : "Nada pendiente. Cuando el agente pida aprobación o una aclaración, aparece acá (y en Slack si está configurado)."}
        </p>
      )}

      {data.pending.map((req) => (
        <RequestCard key={req.token} req={req} readOnly={readOnly} onResolved={refresh} />
      ))}
    </aside>
  );
}

function RequestCard({
  req,
  readOnly,
  onResolved,
}: {
  req: PendingHumanRequest;
  readOnly: boolean;
  onResolved: () => void;
}) {
  const [note, setNote] = useState("");
  const [answer, setAnswer] = useState("");
  const [sending, setSending] = useState(false);

  async function send(body: Record<string, unknown>) {
    setSending(true);
    try {
      await fetch("/api/approvals", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: req.token, ...body }),
      });
      onResolved();
    } finally {
      setSending(false);
    }
  }

  const riskClass =
    req.riskLevel === "alto"
      ? "bg-[#fdeaea] text-[#b23b3b]"
      : req.riskLevel === "medio"
        ? "bg-[#fbf1e3] text-[#9a6a1f]"
        : "bg-canvas text-muted";

  const field =
    "w-full rounded-md border border-hairline bg-surface px-2.5 py-1.5 text-[13px] text-ink placeholder:text-muted/70 focus:border-ink focus:outline-none";

  return (
    <div className="space-y-2.5 rounded-lg border border-hairline p-3.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[13px] font-semibold text-ink">{req.action}</span>
        {req.riskLevel && (
          <span className={`rounded-sm px-1.5 py-0.5 text-[10px] font-semibold uppercase ${riskClass}`}>
            {req.riskLevel}
          </span>
        )}
      </div>
      {req.patientName && <p className="text-[12px] text-muted">👤 {req.patientName}</p>}
      {req.requestedBy && <p className="text-[11px] text-muted/80">Enviado por {req.requestedBy}</p>}
      <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-ink/90">{req.summary}</p>

      {readOnly ? (
        <p className="text-[12px] italic text-muted">En revisión…</p>
      ) : req.kind === "approval" ? (
        <>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Nota / motivo (opcional)"
            className={field}
          />
          <div className="flex gap-2">
            <button
              disabled={sending}
              onClick={() => send({ approved: true, note: note || undefined })}
              className="flex-1 rounded-md bg-[#2e7d5b] px-2 py-2 text-[13px] font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              Aprobar
            </button>
            <button
              disabled={sending}
              onClick={() => send({ approved: false, note: note || undefined })}
              className="flex-1 rounded-md bg-[#b23b3b] px-2 py-2 text-[13px] font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              Rechazar
            </button>
          </div>
        </>
      ) : (
        <>
          <textarea
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            placeholder="Tu respuesta para el agente…"
            rows={2}
            className={field}
          />
          <button
            disabled={sending || !answer.trim()}
            onClick={() => send({ answer })}
            className="w-full rounded-md bg-ink px-2 py-2 text-[13px] font-semibold text-white transition-colors hover:bg-ink-hover disabled:opacity-40"
          >
            Enviar respuesta
          </button>
        </>
      )}
    </div>
  );
}
