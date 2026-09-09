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
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
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

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-6xl flex-col gap-4 p-4 md:flex-row md:p-6">
      <section className="flex min-h-[72vh] flex-1 flex-col overflow-hidden rounded-xl border border-hairline bg-surface shadow-card">
        <header className="flex items-center justify-between border-b border-hairline px-5 py-4">
          <div className="space-y-0.5">
            <h1 className="text-[17px] font-semibold tracking-tight text-ink">
              Secretario médico · agente
            </h1>
            <p className="text-[13px] text-muted">
              {actor.name} · <span className="font-semibold text-ink">{ROLE_LABEL[actor.role]}</span>
            </p>
          </div>
          <button
            onClick={logout}
            className="rounded-md border border-hairline px-3 py-1.5 text-[13px] font-semibold text-ink transition-colors hover:border-ink"
          >
            Cerrar sesión
          </button>
        </header>

        <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto px-5 py-5">
          {messages.length === 0 && (
            <div className="space-y-3">
              <p className="text-[14px] text-muted">Probá un escenario o escribí un mensaje:</p>
              <div className="flex flex-wrap gap-2">
                {SCENARIOS[actor.role].map((s) => (
                  <button
                    key={s.label}
                    onClick={() => sendMessage({ text: s.text })}
                    className="rounded-full border border-hairline bg-surface px-3.5 py-1.5 text-[13px] font-medium text-ink transition-colors hover:border-ink"
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

          {busy && <p className="text-[13px] text-muted">el agente está trabajando…</p>}
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
          className="flex gap-2 border-t border-hairline p-4"
        >
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={actor.role === "paciente" ? "Escribí tu consulta…" : "Escribí acá…"}
            className="flex-1 rounded-md border border-hairline bg-surface px-3.5 py-2.5 text-[16px] text-ink placeholder:text-muted/70 transition-colors focus:border-ink focus:outline-none"
          />
          <button
            type="submit"
            disabled={busy || !input.trim()}
            className="rounded-md bg-ink px-5 py-2.5 text-[15px] font-semibold text-white transition-colors hover:bg-ink-hover disabled:opacity-40"
          >
            Enviar
          </button>
        </form>
      </section>

      <ApprovalsPanel actor={actor} />
    </main>
  );
}

type Part = { type: string; [k: string]: unknown };

function renderInline(text: string, keyBase: string) {
  return text.split(/(\*\*[^*]+\*\*)/g).map((p, i) =>
    /^\*\*[^*]+\*\*$/.test(p) ? (
      <strong key={`${keyBase}-${i}`} className="font-semibold">
        {p.slice(2, -2)}
      </strong>
    ) : (
      <span key={`${keyBase}-${i}`}>{p}</span>
    ),
  );
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

function MessageBubble({ role, parts }: { role: string; parts: Part[] }) {
  const isUser = role === "user";
  return (
    <div className={isUser ? "flex justify-end" : "flex justify-start"}>
      <div
        className={`max-w-[85%] space-y-2 rounded-xl px-4 py-2.5 text-[15px] leading-relaxed ${
          isUser
            ? "bg-ink text-white"
            : "border border-hairline bg-canvas text-ink"
        }`}
      >
        {parts.map((part, i) => {
          if (part.type === "text") {
            const text = String((part as { text?: string }).text ?? "");
            return isUser ? (
              <p key={i} className="whitespace-pre-wrap">
                {text}
              </p>
            ) : (
              <Markdown key={i} text={text} />
            );
          }
          if (part.type === "reasoning" || part.type === "step-start") return null;
          if (part.type === "dynamic-tool" || part.type.startsWith("tool-")) {
            const name =
              part.type === "dynamic-tool"
                ? String((part as { toolName?: string }).toolName ?? "tool")
                : part.type.slice(5);
            return <ToolChip key={i} name={name} part={part} dark={isUser} />;
          }
          return null;
        })}
      </div>
    </div>
  );
}

function ToolChip({ name, part, dark }: { name: string; part: Part; dark: boolean }) {
  const [open, setOpen] = useState(false);
  const state = String((part as { state?: string }).state ?? "");
  const waiting =
    (name === "requestHumanApproval" || name === "askHumanInput") && state !== "output-available";

  return (
    <div
      className={`rounded-md border px-2.5 py-1.5 text-[12px] ${
        dark ? "border-white/20" : "border-hairline bg-surface"
      }`}
    >
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 text-left font-mono"
      >
        <span>{waiting ? "⏸" : "🔧"}</span>
        <span className="font-semibold">{name}</span>
        <span className={dark ? "text-white/60" : "text-muted"}>
          {waiting ? "esperando a un humano…" : state}
        </span>
      </button>
      {open && (
        <pre className="mt-1.5 max-h-48 overflow-auto rounded-sm bg-ink p-2 text-[11px] text-white/90">
          {JSON.stringify(
            { input: (part as { input?: unknown }).input, output: (part as { output?: unknown }).output },
            null,
            2,
          )}
        </pre>
      )}
    </div>
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
    <aside className="flex w-full flex-col gap-3 rounded-xl border border-hairline bg-surface p-5 shadow-card md:w-96">
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
