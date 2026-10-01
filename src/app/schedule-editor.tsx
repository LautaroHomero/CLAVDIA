"use client";

import { useEffect, useMemo, useState } from "react";
import { BTN, BTN_DARK, CARD, FIELD } from "./system-shared";

// Editor de horario de trabajo de un profesional: patrón semanal recurrente +
// excepciones puntuales por fecha (que le ganan al patrón ese día). Se usa
// tanto en "Mi perfil" (el propio médico) como en "Profesionales" (secretaría
// / admin editando el de otro) — ver `system-view.tsx`.

type Window = { startTime: string; endTime: string };
type WeekRule = { weekday: number; startTime: string; endTime: string };
type Override = { date: string; closed: boolean; windows: Window[] };

const WEEKDAYS = [
  { value: 1, label: "Lunes" },
  { value: 2, label: "Martes" },
  { value: 3, label: "Miércoles" },
  { value: 4, label: "Jueves" },
  { value: 5, label: "Viernes" },
  { value: 6, label: "Sábado" },
  { value: 0, label: "Domingo" },
];

const OVERRIDE_HORIZON_DAYS = 21;

const pad = (n: number) => String(n).padStart(2, "0");
const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const addDays = (dateStr: string, n: number) => {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const dayLabel = (dateStr: string) =>
  new Date(dateStr + "T12:00:00").toLocaleDateString("es-AR", { weekday: "short", day: "2-digit", month: "2-digit" });

export function ProviderScheduleCard({
  providerId,
  canEdit,
  onDone,
}: {
  providerId: string;
  canEdit: boolean;
  onDone: (msg: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [rules, setRules] = useState<WeekRule[] | null>(null);
  const [overrides, setOverrides] = useState<Override[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [expandedDate, setExpandedDate] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const from = todayStr();
    const to = addDays(from, OVERRIDE_HORIZON_DAYS);
    Promise.all([
      fetch(`/api/providers/${providerId}/schedule`).then((r) => r.json()),
      fetch(`/api/providers/${providerId}/schedule/overrides?from=${from}&to=${to}`).then((r) => r.json()),
    ])
      .then(([rulesRes, overridesRes]) => {
        if (cancelled) return;
        if (rulesRes.ok) setRules(rulesRes.rules);
        else setError(rulesRes.error ?? "No se pudo cargar el horario.");
        if (overridesRes.ok) setOverrides(overridesRes.overrides);
      })
      .catch(() => {
        if (!cancelled) setError("No se pudo cargar el horario.");
      });
    return () => {
      cancelled = true;
    };
  }, [open, providerId]);

  const windowsByWeekday = useMemo(() => {
    const map = new Map<number, Window[]>();
    for (const wd of WEEKDAYS.map((w) => w.value)) map.set(wd, []);
    for (const r of rules ?? []) map.get(r.weekday)?.push({ startTime: r.startTime, endTime: r.endTime });
    return map;
  }, [rules]);

  function updateWeekday(weekday: number, windows: Window[]) {
    setRules((prev) => {
      const rest = (prev ?? []).filter((r) => r.weekday !== weekday);
      return [...rest, ...windows.map((w) => ({ weekday, ...w }))];
    });
  }

  function reportSaved(message: string, conflicts: number) {
    onDone(
      conflicts > 0
        ? `${message} Ojo: ${conflicts} turno(s) ya reservados quedan fuera de este horario (no se tocaron).`
        : message,
    );
  }

  async function saveWeekly() {
    if (!rules) return;
    setBusy(true);
    setError("");
    try {
      const r = await fetch(`/api/providers/${providerId}/schedule`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rules }),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) {
        setError(d.error ?? "No se pudo guardar.");
        return;
      }
      setRules(d.rules);
      reportSaved(d.message ?? "Horario semanal actualizado.", d.conflicts ?? 0);
    } finally {
      setBusy(false);
    }
  }

  const overrideByDate = useMemo(() => {
    const map = new Map<string, Override>();
    for (const o of overrides ?? []) map.set(o.date, o);
    return map;
  }, [overrides]);

  function effectiveFor(date: string, weekday: number): { closed: boolean; windows: Window[] } {
    const o = overrideByDate.get(date);
    if (o) return { closed: o.closed, windows: o.windows };
    const windows = windowsByWeekday.get(weekday) ?? [];
    return { closed: windows.length === 0, windows };
  }

  async function saveOverride(date: string, spec: { closed: true } | { windows: Window[] }) {
    setBusy(true);
    setError("");
    try {
      const r = await fetch(`/api/providers/${providerId}/schedule/overrides/${date}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(spec),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) {
        setError(d.error ?? "No se pudo guardar.");
        return;
      }
      setOverrides((prev) => {
        const rest = (prev ?? []).filter((o) => o.date !== date);
        const next: Override =
          "closed" in spec ? { date, closed: true, windows: [] } : { date, closed: false, windows: spec.windows };
        return [...rest, next].sort((a, b) => a.date.localeCompare(b.date));
      });
      setExpandedDate(null);
      reportSaved(d.message ?? "Horario actualizado.", d.conflicts ?? 0);
    } finally {
      setBusy(false);
    }
  }

  async function clearOverride(date: string) {
    setBusy(true);
    setError("");
    try {
      const r = await fetch(`/api/providers/${providerId}/schedule/overrides/${date}`, { method: "DELETE" });
      const d = await r.json();
      if (!r.ok || !d.ok) {
        setError(d.error ?? "No se pudo actualizar.");
        return;
      }
      setOverrides((prev) => (prev ?? []).filter((o) => o.date !== date));
      onDone(d.message ?? "Listo.");
    } finally {
      setBusy(false);
    }
  }

  const upcomingDates = useMemo(() => {
    const start = todayStr();
    return Array.from({ length: OVERRIDE_HORIZON_DAYS }, (_, i) => addDays(start, i));
  }, []);

  if (!open) {
    return (
      <aside className={CARD}>
        <div className="flex items-center justify-between">
          <h3 className="text-[14px] font-semibold tracking-tight text-ink">Horario de trabajo</h3>
          <button className={BTN} onClick={() => setOpen(true)}>
            {canEdit ? "Editar" : "Ver"}
          </button>
        </div>
      </aside>
    );
  }

  return (
    <aside className={CARD}>
      <div className="flex items-center justify-between">
        <h3 className="text-[14px] font-semibold tracking-tight text-ink">Horario de trabajo</h3>
        <button className={BTN} onClick={() => setOpen(false)}>
          Cerrar
        </button>
      </div>

      {!rules || !overrides ? (
        <p className="text-[12px] text-muted">Cargando…</p>
      ) : (
        <>
          <div className="space-y-1.5">
            <p className="text-[12px] font-semibold text-ink">Patrón semanal</p>
            <div className="space-y-1.5">
              {WEEKDAYS.map((wd) => (
                <WeekdayRow
                  key={wd.value}
                  label={wd.label}
                  windows={windowsByWeekday.get(wd.value) ?? []}
                  disabled={!canEdit || busy}
                  onChange={(windows) => updateWeekday(wd.value, windows)}
                />
              ))}
            </div>
            {canEdit && (
              <button className={BTN_DARK} disabled={busy} onClick={saveWeekly}>
                Guardar horario semanal
              </button>
            )}
          </div>

          <div className="space-y-1.5 border-t border-hairline pt-3">
            <p className="text-[12px] font-semibold text-ink">Excepciones por día</p>
            <p className="text-[11px] text-muted">
              Cualquier día puntual se puede editar distinto del patrón semanal (horario especial, o cerrado).
            </p>
            <div className="max-h-72 space-y-1 overflow-y-auto pr-1">
              {upcomingDates.map((date) => {
                const weekday = new Date(date + "T12:00:00").getDay();
                const eff = effectiveFor(date, weekday);
                return (
                  <DateRow
                    key={date}
                    date={date}
                    closed={eff.closed}
                    windows={eff.windows}
                    hasOverride={overrideByDate.has(date)}
                    expanded={expandedDate === date}
                    canEdit={canEdit}
                    busy={busy}
                    onToggle={() => setExpandedDate((d) => (d === date ? null : date))}
                    onSave={(spec) => saveOverride(date, spec)}
                    onClear={() => clearOverride(date)}
                  />
                );
              })}
            </div>
          </div>
        </>
      )}

      {error && <p className="text-[11px] text-[#c0392b]">{error}</p>}
    </aside>
  );
}

function FranjaList({
  windows,
  disabled,
  onChange,
}: {
  windows: Window[];
  disabled?: boolean;
  onChange: (windows: Window[]) => void;
}) {
  const [start, setStart] = useState("09:00");
  const [end, setEnd] = useState("13:00");

  function add() {
    if (!start || !end || end <= start) return;
    onChange([...windows, { startTime: start, endTime: end }].sort((a, b) => a.startTime.localeCompare(b.startTime)));
  }
  function remove(i: number) {
    onChange(windows.filter((_, idx) => idx !== i));
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {windows.length === 0 && <span className="text-[11px] text-muted">Cerrado</span>}
      {windows.map((w, i) => (
        <span key={i} className="flex items-center gap-1 rounded-pill border border-hairline px-2 py-0.5 text-[11px] text-ink">
          {w.startTime}–{w.endTime}
          {!disabled && (
            <button onClick={() => remove(i)} className="text-muted hover:text-ink" aria-label="Quitar franja">
              ×
            </button>
          )}
        </span>
      ))}
      {!disabled && (
        <span className="flex items-center gap-1">
          <input type="time" value={start} onChange={(e) => setStart(e.target.value)} className={`${FIELD} w-[6.5rem] py-0.5`} />
          <span className="text-[11px] text-muted">–</span>
          <input type="time" value={end} onChange={(e) => setEnd(e.target.value)} className={`${FIELD} w-[6.5rem] py-0.5`} />
          <button className={BTN} onClick={add}>
            + franja
          </button>
        </span>
      )}
    </div>
  );
}

function WeekdayRow({
  label,
  windows,
  disabled,
  onChange,
}: {
  label: string;
  windows: Window[];
  disabled?: boolean;
  onChange: (windows: Window[]) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-hairline px-2.5 py-2 sm:flex-row sm:items-center sm:gap-3">
      <span className="w-20 shrink-0 text-[12px] font-medium text-ink">{label}</span>
      <FranjaList windows={windows} disabled={disabled} onChange={onChange} />
    </div>
  );
}

function DateRow({
  date,
  closed,
  windows,
  hasOverride,
  expanded,
  canEdit,
  busy,
  onToggle,
  onSave,
  onClear,
}: {
  date: string;
  closed: boolean;
  windows: Window[];
  hasOverride: boolean;
  expanded: boolean;
  canEdit: boolean;
  busy: boolean;
  onToggle: () => void;
  onSave: (spec: { closed: true } | { windows: Window[] }) => void;
  onClear: () => void;
}) {
  return (
    <div className="rounded-lg border border-hairline px-2.5 py-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[12px] font-medium capitalize text-ink">{dayLabel(date)}</span>
          <span className="text-[11px] text-muted">
            {closed ? "Cerrado" : windows.map((w) => `${w.startTime}–${w.endTime}`).join(", ")}
          </span>
          {hasOverride && (
            <span className="rounded-pill bg-canvas px-1.5 py-0.5 text-[10px] text-muted">excepción</span>
          )}
        </div>
        {canEdit && (
          <div className="flex items-center gap-1.5">
            {hasOverride && (
              <button className={BTN} disabled={busy} onClick={onClear}>
                Volver al habitual
              </button>
            )}
            <button className={BTN} disabled={busy} onClick={onToggle}>
              {expanded ? "Cancelar" : "Editar este día"}
            </button>
          </div>
        )}
      </div>
      {expanded && <DateEditForm key={date} initialWindows={windows} initialClosed={closed} busy={busy} onSave={onSave} />}
    </div>
  );
}

/** Formulario de una fecha puntual — se remonta al expandirse (`key={date}`), así arranca siempre con el horario efectivo vigente sin sincronizar estado vía effect. */
function DateEditForm({
  initialWindows,
  initialClosed,
  busy,
  onSave,
}: {
  initialWindows: Window[];
  initialClosed: boolean;
  busy: boolean;
  onSave: (spec: { closed: true } | { windows: Window[] }) => void;
}) {
  const [draft, setDraft] = useState<Window[]>(initialWindows);
  const [draftClosed, setDraftClosed] = useState(initialClosed);

  return (
    <div className="mt-2 space-y-2 border-t border-hairline pt-2">
      <label className="flex items-center gap-1.5 text-[11px] text-ink">
        <input type="checkbox" checked={draftClosed} onChange={(e) => setDraftClosed(e.target.checked)} />
        No atiende este día
      </label>
      {!draftClosed && <FranjaList windows={draft} disabled={busy} onChange={setDraft} />}
      <button
        className={BTN_DARK}
        disabled={busy || (!draftClosed && draft.length === 0)}
        onClick={() => onSave(draftClosed ? { closed: true } : { windows: draft })}
      >
        Guardar este día
      </button>
    </div>
  );
}
