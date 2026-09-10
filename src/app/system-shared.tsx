"use client";

import { useEffect, useState } from "react";

// Shared primitives for the "Sistema" view (list, month calendar, patients).

export const CARD =
  "flex w-full shrink-0 flex-col gap-3 rounded-xl border border-hairline bg-surface p-5 shadow-card";
export const BTN =
  "rounded-md border border-hairline px-2.5 py-1 text-[12px] font-semibold text-ink transition-colors hover:border-ink disabled:opacity-40";
export const BTN_DARK =
  "rounded-md bg-ink px-2.5 py-1 text-[12px] font-semibold text-white transition-colors hover:bg-ink-hover disabled:opacity-40";
export const BTN_DANGER =
  "rounded-md bg-[#b23b3b] px-2.5 py-1 text-[12px] font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-40";
export const FIELD =
  "w-full rounded-md border border-hairline bg-surface px-2.5 py-1.5 text-[13px] text-ink placeholder:text-muted/70 focus:border-ink focus:outline-none";

export const pad = (n: number) => String(n).padStart(2, "0");
export const localToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
export const fmtDateTime = (iso: string | null) => {
  if (!iso) return "—";
  const d = new Date(iso.replace(" ", "T"));
  return d.toLocaleString("es-AR", {
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
};
export const fmtDay = (isoDate: string) =>
  new Date(`${isoDate}T12:00:00`).toLocaleDateString("es-AR", {
    weekday: "long",
    day: "2-digit",
    month: "2-digit",
  });

export type CalStatus = "scheduled" | "in-progress" | "completed" | "cancelled";

export interface ManageFlags {
  canCancel: boolean;
  canReschedule: boolean;
  needsApproval: boolean;
  blockedReason: string | null;
}

/** Normalised row the list view and the calendar day-panel both render. */
export interface CalRowItem {
  appointmentId: string;
  time: string;
  who: string;
  reason: string;
  status: CalStatus;
  providerId: string;
  manage: ManageFlags;
  provider?: string;
  birthday?: boolean;
  organizationId?: string;
}

export const STATUS_DOT: Record<CalStatus, string> = {
  scheduled: "bg-hairline-strong",
  "in-progress": "bg-[#2e7d5b]",
  completed: "bg-[#2e7d5b]/40",
  cancelled: "bg-[#b23b3b]/50",
};
export const STATUS_LABEL: Record<CalStatus, string> = {
  scheduled: "Agendado",
  "in-progress": "En atención",
  completed: "Atendido",
  cancelled: "Cancelado",
};

// ---------------------------------------------------------------------------
// Slot picker — used by the reschedule row and every booking form
// ---------------------------------------------------------------------------

interface Slot {
  slotId: string;
  start: string;
  durationMinutes: number;
  providerId: string;
  provider: string;
  specialty?: string;
}

export function SlotPicker({
  organizationId,
  providerId,
  disabled,
  onPick,
  showProvider,
}: {
  organizationId?: string;
  providerId?: string;
  disabled?: boolean;
  onPick: (slotId: string) => void;
  showProvider?: boolean;
}) {
  const [date, setDate] = useState("");
  const [slots, setSlots] = useState<Slot[] | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    let alive = true;
    const run = async () => {
      setSlots(null);
      setErr("");
      const params = new URLSearchParams();
      if (organizationId) params.set("organizationId", organizationId);
      if (providerId) params.set("providerId", providerId);
      if (date) params.set("date", date);
      try {
        const d = await fetch(`/api/slots?${params.toString()}`, { cache: "no-store" }).then((r) => r.json());
        if (!alive) return;
        if (d.error) setErr(d.error);
        else setSlots(d.slots ?? []);
      } catch {
        if (alive) setErr("No se pudieron cargar los horarios.");
      }
    };
    run();
    return () => {
      alive = false;
    };
  }, [organizationId, providerId, date]);

  const byDay = new Map<string, Slot[]>();
  for (const s of slots ?? []) {
    const k = s.start.slice(0, 10);
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k)!.push(s);
  }

  return (
    <div className="mt-1.5 space-y-2">
      <input
        type="date"
        value={date}
        min={localToday()}
        onChange={(e) => setDate(e.target.value)}
        className={FIELD}
      />
      {err && <p className="text-[12px] text-[#c0392b]">{err}</p>}
      {!slots && !err && <p className="text-[12px] text-muted">Cargando horarios…</p>}
      {slots && slots.length === 0 && (
        <p className="text-[12px] text-muted">No hay horarios libres{date ? " ese día" : ""}.</p>
      )}
      <div className="max-h-52 space-y-2 overflow-y-auto">
        {[...byDay.entries()].map(([day, list]) => (
          <div key={day} className="space-y-1">
            <p className="text-[11px] font-semibold uppercase tracking-wide capitalize text-muted">{fmtDay(day)}</p>
            <div className="flex flex-wrap gap-1.5">
              {list.map((s) => (
                <button
                  key={s.slotId}
                  disabled={disabled}
                  onClick={() => onPick(s.slotId)}
                  className="rounded-md border border-hairline px-2 py-1 text-[12px] text-ink transition-colors hover:border-ink disabled:opacity-40"
                  title={showProvider ? `${s.provider}${s.specialty ? ` · ${s.specialty}` : ""}` : undefined}
                >
                  {s.start.slice(11, 16)}
                  {showProvider ? ` · ${s.provider}` : ""}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Appointment row with inline Reprogramar / Cancelar
// ---------------------------------------------------------------------------

export function CalRow({
  it,
  showProvider,
  onDone,
}: {
  it: CalRowItem;
  showProvider: boolean;
  onDone: (msg: string) => void;
}) {
  const [mode, setMode] = useState<"idle" | "confirm-cancel" | "reschedule">("idle");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const canAct = it.manage.canCancel || it.manage.canReschedule;

  async function cancel() {
    setBusy(true);
    setError("");
    try {
      const r = await fetch(`/api/appointments/${it.appointmentId}`, { method: "DELETE" });
      const d = await r.json();
      if (!r.ok || !d.ok) {
        setError(d.error ?? "No se pudo cancelar.");
        return;
      }
      setMode("idle");
      onDone(d.pending ? d.message ?? "Pedido enviado a revisión." : "Turno cancelado.");
    } finally {
      setBusy(false);
    }
  }

  async function reschedule(newSlotId: string) {
    setBusy(true);
    setError("");
    try {
      const r = await fetch(`/api/appointments/${it.appointmentId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ newSlotId }),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) {
        setError(d.error ?? "No se pudo reprogramar.");
        return;
      }
      setMode("idle");
      onDone(d.pending ? d.message ?? "Pedido enviado a revisión." : "Turno reprogramado.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-lg border border-hairline px-3 py-2.5">
      <div className="flex items-start gap-3">
        <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_DOT[it.status]}`} aria-hidden />
        <p className="w-12 shrink-0 text-[13px] font-semibold tabular-nums text-ink">{it.time}</p>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-medium text-ink">
            {it.who}
            {it.birthday ? " 🎂" : ""}
          </p>
          <p className="truncate text-[12px] text-muted">
            {showProvider && it.provider ? `${it.provider} · ` : ""}
            {it.reason}
          </p>
        </div>
        <span className="shrink-0 rounded-full bg-canvas px-2 py-0.5 text-[10px] font-semibold text-muted">
          {STATUS_LABEL[it.status]}
        </span>
      </div>

      {(canAct || it.manage.blockedReason) && (
        <div className="mt-2 flex flex-wrap items-center gap-2 pl-[3.75rem]">
          {it.manage.blockedReason && !canAct && (
            <span className="text-[11px] text-muted">{it.manage.blockedReason}</span>
          )}
          {mode === "idle" && canAct && (
            <>
              {it.manage.canReschedule && (
                <button className={BTN} onClick={() => setMode("reschedule")}>
                  Reprogramar
                </button>
              )}
              {it.manage.canCancel && (
                <button className={BTN} onClick={() => setMode("confirm-cancel")}>
                  Cancelar
                </button>
              )}
              {it.manage.needsApproval && (
                <span className="text-[11px] text-[#9a6a1f]">· con &lt; 24 h queda en revisión del profesional</span>
              )}
            </>
          )}
          {mode === "confirm-cancel" && (
            <>
              <span className="text-[12px] text-ink">¿Cancelar el turno de las {it.time}?</span>
              <button className={BTN_DANGER} disabled={busy} onClick={cancel}>
                Sí, cancelar
              </button>
              <button className={BTN} disabled={busy} onClick={() => setMode("idle")}>
                No
              </button>
            </>
          )}
        </div>
      )}

      {mode === "reschedule" && (
        <div className="mt-2 pl-[3.75rem]">
          <div className="flex items-center justify-between">
            <p className="text-[12px] font-semibold text-ink">Elegí un nuevo horario</p>
            <button className="text-[12px] text-muted hover:text-ink" onClick={() => setMode("idle")}>
              cerrar
            </button>
          </div>
          <SlotPicker
            organizationId={it.organizationId}
            providerId={it.providerId}
            disabled={busy}
            onPick={reschedule}
          />
        </div>
      )}

      {error && <p className="mt-1.5 pl-[3.75rem] text-[12px] text-[#c0392b]">{error}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Staff patient search box
// ---------------------------------------------------------------------------

export interface PatientHit {
  patientId: string;
  fullName: string;
  dni: string;
  coverage: string;
}

export function PatientPicker({
  selected,
  onSelect,
  autoFocus,
}: {
  selected: PatientHit | null;
  onSelect: (p: PatientHit | null) => void;
  autoFocus?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<PatientHit[]>([]);

  useEffect(() => {
    let alive = true;
    const q = query.trim();
    const t = setTimeout(() => {
      if (q.length < 2) {
        setHits([]);
        return;
      }
      fetch(`/api/patients/search?q=${encodeURIComponent(q)}`, { cache: "no-store" })
        .then((r) => r.json())
        .then((d) => alive && setHits(d.matches ?? []))
        .catch(() => {});
    }, 200);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [query]);

  if (selected) {
    return (
      <div className="flex items-center justify-between rounded-md border border-hairline bg-canvas px-2.5 py-1.5">
        <span className="text-[13px] text-ink">
          {selected.fullName} <span className="text-muted">· DNI {selected.dni}</span>
        </span>
        <button className="text-[12px] text-muted hover:text-ink" onClick={() => onSelect(null)}>
          cambiar
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      <input
        autoFocus={autoFocus}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Buscar paciente por nombre o DNI"
        className={FIELD}
      />
      {hits.map((h) => (
        <button
          key={h.patientId}
          onClick={() => {
            onSelect(h);
            setQuery("");
            setHits([]);
          }}
          className="block w-full rounded-md border border-hairline px-2.5 py-1.5 text-left text-[12px] text-ink hover:border-ink"
        >
          {h.fullName} · DNI {h.dni} · {h.coverage}
        </button>
      ))}
    </div>
  );
}
