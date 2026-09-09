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
    {
      label: "Renovar receta (directo)",
      text: "Renová la receta de Apixabán 5 mg de Jorge Fernández.",
    },
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
      label: "Turno de control (directo)",
      text: "María Gómez quiere un turno de control con la Dra. Ruiz la semana que viene a la mañana.",
    },
  ],
  paciente: [
    { label: "Mis turnos", text: "¿Qué turnos tengo?" },
    {
      label: "Sacar un turno",
      text: "Quiero un turno de control la semana que viene a la mañana.",
    },
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
  }

  function submit() {
    const text = input.trim();
    if (!text) return;
    sendMessage({ text });
    setInput("");
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-6xl flex-col gap-4 p-4 text-neutral-900 md:flex-row">
      <section className="flex min-h-[70vh] flex-1 flex-col rounded-xl border border-neutral-200 bg-white shadow-sm">
        <header className="flex items-center justify-between border-b border-neutral-200 px-4 py-3">
          <div>
            <h1 className="text-base font-semibold">Secretario médico · agente</h1>
            <p className="text-xs text-neutral-500">
              {actor.name} · <span className="font-medium">{ROLE_LABEL[actor.role]}</span>
            </p>
          </div>
          <button onClick={logout} className="text-xs text-neutral-500 underline">
            Salir
          </button>
        </header>

        <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
          {messages.length === 0 && (
            <div className="space-y-3">
              <p className="text-sm text-neutral-500">Probá un escenario o escribí un mensaje:</p>
              <div className="flex flex-wrap gap-2">
                {SCENARIOS[actor.role].map((s) => (
                  <button
                    key={s.label}
                    onClick={() => sendMessage({ text: s.text })}
                    className="rounded-full border border-neutral-300 px-3 py-1 text-xs hover:bg-neutral-100"
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

          {busy && <p className="text-xs text-neutral-400">el agente está trabajando…</p>}
          {error && (
            <p className="text-xs text-red-600">
              Error: {error.message}. ¿Está seteada <code>ANTHROPIC_API_KEY</code> y con saldo?
            </p>
          )}
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
          className="flex gap-2 border-t border-neutral-200 p-3"
        >
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={
              actor.role === "paciente" ? "Escribí tu consulta…" : "Escribí acá…"
            }
            className="flex-1 rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-neutral-500"
          />
          <button
            type="submit"
            disabled={busy || !input.trim()}
            className="rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
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

function MessageBubble({ role, parts }: { role: string; parts: Part[] }) {
  const isUser = role === "user";
  return (
    <div className={isUser ? "flex justify-end" : "flex justify-start"}>
      <div
        className={`max-w-[85%] space-y-2 rounded-xl px-3 py-2 text-sm ${
          isUser ? "bg-neutral-900 text-white" : "border border-neutral-200 bg-neutral-50"
        }`}
      >
        {parts.map((part, i) => {
          if (part.type === "text") {
            return (
              <p key={i} className="whitespace-pre-wrap">
                {String((part as { text?: string }).text ?? "")}
              </p>
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
      className={`rounded-lg border px-2 py-1 text-xs ${
        dark ? "border-white/20" : "border-neutral-300 bg-white"
      }`}
    >
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 text-left font-mono"
      >
        <span>{waiting ? "⏸" : "🔧"}</span>
        <span className="font-semibold">{name}</span>
        <span className={dark ? "text-white/60" : "text-neutral-400"}>
          {waiting ? "esperando a un humano…" : state}
        </span>
      </button>
      {open && (
        <pre className="mt-1 max-h-48 overflow-auto rounded bg-neutral-900 p-2 text-[11px] text-neutral-100">
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
    <aside className="flex w-full flex-col gap-3 rounded-xl border border-neutral-200 bg-white p-4 shadow-sm md:w-96">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">{PANEL_TITLE[actor.role]}</h2>
        <span
          className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
            data.slackEnabled ? "bg-green-100 text-green-800" : "bg-neutral-100 text-neutral-500"
          }`}
        >
          Slack {data.slackEnabled ? "conectado" : "no configurado"}
        </span>
      </div>

      {data.pending.length === 0 && (
        <p className="text-xs text-neutral-400">
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

  const riskColor =
    req.riskLevel === "alto"
      ? "bg-red-100 text-red-800"
      : req.riskLevel === "medio"
        ? "bg-amber-100 text-amber-800"
        : "bg-neutral-100 text-neutral-600";

  return (
    <div className="space-y-2 rounded-lg border border-neutral-200 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold">{req.action}</span>
        {req.riskLevel && (
          <span className={`rounded px-1.5 py-0.5 text-[10px] ${riskColor}`}>{req.riskLevel}</span>
        )}
      </div>
      {req.patientName && <p className="text-[11px] text-neutral-500">👤 {req.patientName}</p>}
      {req.requestedBy && (
        <p className="text-[11px] text-neutral-400">Enviado por {req.requestedBy}</p>
      )}
      <p className="whitespace-pre-wrap text-xs text-neutral-700">{req.summary}</p>

      {readOnly ? (
        <p className="text-[11px] italic text-neutral-400">En revisión…</p>
      ) : req.kind === "approval" ? (
        <>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Nota / motivo (opcional)"
            className="w-full rounded border border-neutral-300 px-2 py-1 text-xs"
          />
          <div className="flex gap-2">
            <button
              disabled={sending}
              onClick={() => send({ approved: true, note: note || undefined })}
              className="flex-1 rounded bg-green-600 px-2 py-1.5 text-xs font-medium text-white disabled:opacity-40"
            >
              Aprobar
            </button>
            <button
              disabled={sending}
              onClick={() => send({ approved: false, note: note || undefined })}
              className="flex-1 rounded bg-red-600 px-2 py-1.5 text-xs font-medium text-white disabled:opacity-40"
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
            className="w-full rounded border border-neutral-300 px-2 py-1 text-xs"
          />
          <button
            disabled={sending || !answer.trim()}
            onClick={() => send({ answer })}
            className="w-full rounded bg-neutral-900 px-2 py-1.5 text-xs font-medium text-white disabled:opacity-40"
          >
            Enviar respuesta
          </button>
        </>
      )}
    </div>
  );
}
