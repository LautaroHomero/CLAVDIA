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
  // The query a search actually completed for — lets us tell "still typing /
  // debouncing" apart from "searched this and got nothing", without setting
  // state synchronously inside the effect body.
  const [searchedQuery, setSearchedQuery] = useState<string | null>(null);
  const [addingNew, setAddingNew] = useState(false);

  useEffect(() => {
    let alive = true;
    const q = query.trim();
    const t = setTimeout(() => {
      if (q.length < 2) {
        setHits([]);
        setSearchedQuery(null);
        return;
      }
      fetch(`/api/patients/search?q=${encodeURIComponent(q)}`, { cache: "no-store" })
        .then((r) => r.json())
        .then((d) => {
          if (!alive) return;
          setHits(d.matches ?? []);
          setSearchedQuery(q);
        })
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

  const q = query.trim();

  if (addingNew) {
    const looksLikeDni = /^\d[\d.\s]*$/.test(q);
    return (
      <NewPatientForm
        initialDni={looksLikeDni ? q : ""}
        initialName={!looksLikeDni ? q : ""}
        onCancel={() => setAddingNew(false)}
        onDone={(r) => {
          onSelect({ patientId: r.patientId, fullName: r.fullName, dni: r.dni, coverage: r.coverage });
          setAddingNew(false);
          setQuery("");
          setHits([]);
        }}
      />
    );
  }

  const noMatches = q.length >= 2 && searchedQuery === q && hits.length === 0;

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
      {noMatches && (
        <div className="rounded-md border border-dashed border-hairline px-2.5 py-2 text-[12px] text-muted">
          Nadie coincide con &ldquo;{q}&rdquo;.{" "}
          <button
            className="font-semibold text-ink underline underline-offset-2 hover:opacity-80"
            onClick={() => setAddingNew(true)}
          >
            Dar de alta a esta persona
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// New-patient form — DNI-first: a lone DNI is enough for someone already in
// the system, a full ficha is only asked for once we know the DNI is new.
// Shared by the Pacientes tab ("+ Nuevo paciente") and the PatientPicker
// above (alta inline from the "Nuevo turno" search, so a walk-in booking
// never needs to leave the modal).
// ---------------------------------------------------------------------------

const NEW_PATIENT_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const newPatientPhoneOk = (s: string) => s.replace(/\D/g, "").length >= 8;
const newPatientDniOk = (s: string) => /^\d{7,8}$/.test(s.replace(/[.\s]/g, ""));

export interface NewPatientResult {
  patientId: string;
  fullName: string;
  dni: string;
  coverage: string;
  message: string;
  alreadyExisted: boolean;
}

export function NewPatientForm({
  initialDni = "",
  initialName = "",
  onCancel,
  onDone,
}: {
  initialDni?: string;
  initialName?: string;
  onCancel: () => void;
  onDone: (result: NewPatientResult) => void;
}) {
  const [step, setStep] = useState<"dni" | "existing" | "new">("dni");
  const [dni, setDni] = useState(initialDni);
  const [found, setFound] = useState<{ patientId: string; fullName: string; dni: string; coverage: string } | null>(
    null,
  );
  const [f, setF] = useState({ fullName: initialName, dateOfBirth: "", coverage: "", phone: "", email: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });

  async function checkDni() {
    if (!newPatientDniOk(dni)) {
      setError("El DNI no parece válido. Revisá que tenga 7 u 8 dígitos.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const d = await fetch(`/api/patients/by-dni?dni=${encodeURIComponent(dni.trim())}`, {
        cache: "no-store",
      }).then((r) => r.json());
      if (d.error) {
        setError(d.error);
        return;
      }
      if (d.exists) {
        setFound(d.patient);
        setStep("existing");
      } else {
        setStep("new");
      }
    } catch {
      setError("No se pudo verificar el DNI.");
    } finally {
      setBusy(false);
    }
  }

  async function submit(body: Record<string, unknown>, alreadyExisted: boolean) {
    setBusy(true);
    setError("");
    try {
      const r = await fetch("/api/patients", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) {
        setError(d.error ?? "No se pudo guardar.");
        return;
      }
      onDone({
        patientId: d.patientId,
        fullName: d.fullName ?? found?.fullName ?? f.fullName,
        dni: d.dni ?? dni.trim(),
        coverage: found?.coverage ?? f.coverage,
        message: d.message ?? "Listo.",
        alreadyExisted: d.alreadyExisted ?? alreadyExisted,
      });
    } finally {
      setBusy(false);
    }
  }

  const newValid =
    f.fullName.trim().length > 0 &&
    f.dateOfBirth.trim().length > 0 &&
    f.coverage.trim().length > 0 &&
    NEW_PATIENT_EMAIL_RE.test(f.email.trim()) &&
    newPatientPhoneOk(f.phone);

  if (step === "dni") {
    return (
      <div className="space-y-2 rounded-lg border border-hairline p-3">
        <input
          autoFocus
          value={dni}
          onChange={(e) => setDni(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && checkDni()}
          placeholder="DNI"
          className={FIELD}
        />
        <p className="text-[11px] text-muted">
          Si la persona ya está en el sistema, con el DNI alcanza para sumarla a este consultorio. Si es
          nueva, en el siguiente paso pedimos el resto de la ficha.
        </p>
        <div className="flex gap-2">
          <button className={BTN_DARK} disabled={busy || !dni.trim()} onClick={checkDni}>
            Continuar
          </button>
          <button className={BTN} onClick={onCancel}>
            Cancelar
          </button>
        </div>
        {error && <p className="text-[12px] text-[#c0392b]">{error}</p>}
      </div>
    );
  }

  if (step === "existing" && found) {
    return (
      <div className="space-y-2 rounded-lg border border-hairline p-3">
        <p className="text-[13px] text-ink">
          Ya está en el sistema: <span className="font-semibold">{found.fullName}</span>
        </p>
        <p className="text-[12px] text-muted">
          DNI {found.dni} · {found.coverage}
        </p>
        <div className="flex gap-2">
          <button className={BTN_DARK} disabled={busy} onClick={() => submit({ dni: found.dni }, true)}>
            Sumar a este consultorio
          </button>
          <button
            className={BTN}
            disabled={busy}
            onClick={() => {
              setStep("dni");
              setFound(null);
            }}
          >
            Volver
          </button>
        </div>
        {error && <p className="text-[12px] text-[#c0392b]">{error}</p>}
      </div>
    );
  }

  return (
    <div className="space-y-2 rounded-lg border border-hairline p-3">
      <p className="text-[11px] text-muted">DNI {dni.trim()} — persona nueva. Completá la ficha:</p>
      <input value={f.fullName} onChange={set("fullName")} placeholder="Nombre y apellido" className={FIELD} />
      <input
        type="date"
        value={f.dateOfBirth}
        onChange={set("dateOfBirth")}
        max={localToday()}
        className={FIELD}
      />
      <input value={f.coverage} onChange={set("coverage")} placeholder="Cobertura (obra social / prepaga)" className={FIELD} />
      <input value={f.phone} onChange={set("phone")} placeholder="Teléfono" className={FIELD} />
      <input value={f.email} onChange={set("email")} placeholder="Email" className={FIELD} />
      <div className="flex gap-2">
        <button className={BTN_DARK} disabled={busy || !newValid} onClick={() => submit({ dni: dni.trim(), ...f }, false)}>
          Dar de alta
        </button>
        <button className={BTN} disabled={busy} onClick={() => setStep("dni")}>
          Volver
        </button>
      </div>
      {error && <p className="text-[12px] text-[#c0392b]">{error}</p>}
    </div>
  );
}
