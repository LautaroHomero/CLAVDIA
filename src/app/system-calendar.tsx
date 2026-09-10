"use client";

import { useEffect, useState } from "react";
import {
  BTN_DARK,
  CalRow,
  FIELD,
  fmtDay,
  localToday,
  pad,
  PatientPicker,
  type CalRowItem,
  type PatientHit,
} from "./system-shared";

const WEEKDAYS = ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"];
const MONTHS = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];

const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

interface DayCount {
  date: string;
  appts: number;
  free: number;
}
interface ProviderOpt {
  id: string;
  name: string;
  specialty: string;
}
interface GridResp {
  days: DayCount[];
  providers: ProviderOpt[];
}

interface DayAppt {
  id: string;
  time: string;
  startIso: string;
  patientName: string;
  reason: string;
  status: CalRowItem["status"];
  providerId: string;
  providerName: string;
  manage: CalRowItem["manage"];
}
interface FreeSlot {
  slotId: string;
  time: string;
  providerId: string;
  providerName: string;
}
interface DayResp {
  date: string;
  appointments: DayAppt[];
  freeSlots: FreeSlot[];
}

export function MonthCalendar({
  role,
  onDone,
}: {
  role: "medico" | "recepcion";
  onDone: (msg: string) => void;
}) {
  const today = localToday();
  const [cursor, setCursor] = useState(() => {
    const d = new Date();
    return { year: d.getFullYear(), month: d.getMonth() };
  });
  const [providerId, setProviderId] = useState("all");
  const [grid, setGrid] = useState<GridResp | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  // Visible 6×7 grid (Monday-first).
  const first = new Date(cursor.year, cursor.month, 1);
  const startOffset = (first.getDay() + 6) % 7;
  const gridStart = new Date(cursor.year, cursor.month, 1 - startOffset);
  const cells: Date[] = Array.from({ length: 42 }, (_, i) => {
    const d = new Date(gridStart);
    d.setDate(gridStart.getDate() + i);
    return d;
  });
  const from = ymd(cells[0]);
  const to = ymd(cells[41]);

  useEffect(() => {
    let alive = true;
    const run = async () => {
      const params = new URLSearchParams({ from, to });
      if (role === "recepcion" && providerId !== "all") params.set("providerId", providerId);
      try {
        const d = await fetch(`/api/calendar-grid?${params}`, { cache: "no-store" }).then((r) => r.json());
        if (alive && !d.error) setGrid(d);
      } catch {
        /* ignore */
      }
    };
    run();
    return () => {
      alive = false;
    };
  }, [from, to, providerId, role]);

  const countFor = (date: string) => grid?.days.find((x) => x.date === date);
  const monthLabel = `${MONTHS[cursor.month]} ${cursor.year}`;

  function shift(delta: number) {
    setSelected(null);
    setCursor((c) => {
      const d = new Date(c.year, c.month + delta, 1);
      return { year: d.getFullYear(), month: d.getMonth() };
    });
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <button className={navBtn} onClick={() => shift(-1)} aria-label="Mes anterior">
            ‹
          </button>
          <span className="min-w-[9rem] text-center text-[13px] font-semibold capitalize text-ink">
            {monthLabel}
          </span>
          <button className={navBtn} onClick={() => shift(1)} aria-label="Mes siguiente">
            ›
          </button>
          <button
            className="ml-1 rounded-md px-2 py-1 text-[12px] font-medium text-muted hover:text-ink"
            onClick={() => {
              const d = new Date();
              setCursor({ year: d.getFullYear(), month: d.getMonth() });
              setSelected(today);
            }}
          >
            hoy
          </button>
        </div>
        {role === "recepcion" && grid && (
          <select
            value={providerId}
            onChange={(e) => {
              setProviderId(e.target.value);
              setSelected(null);
            }}
            className={`${FIELD} max-w-[14rem]`}
          >
            <option value="all">Todos los profesionales</option>
            {grid.providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} · {p.specialty}
              </option>
            ))}
          </select>
        )}
      </div>

      <div className="grid grid-cols-7 gap-1">
        {WEEKDAYS.map((w) => (
          <div key={w} className="pb-1 text-center text-[11px] font-semibold uppercase tracking-wide text-muted">
            {w}
          </div>
        ))}
        {cells.map((d) => {
          const key = ymd(d);
          const inMonth = d.getMonth() === cursor.month;
          const isToday = key === today;
          const isPast = key < today;
          const c = countFor(key);
          return (
            <button
              key={key}
              onClick={() => setSelected(key)}
              className={`flex min-h-[4.25rem] flex-col gap-1 rounded-md border p-1.5 text-left transition-colors ${
                selected === key ? "border-ink" : "border-hairline hover:border-hairline-strong"
              } ${inMonth ? "bg-surface" : "bg-canvas/50"} ${isPast ? "opacity-55" : ""}`}
            >
              <span
                className={`text-[12px] font-semibold tabular-nums ${
                  isToday
                    ? "flex h-5 w-5 items-center justify-center rounded-full bg-ink text-white"
                    : inMonth
                      ? "text-ink"
                      : "text-muted"
                }`}
              >
                {d.getDate()}
              </span>
              {inMonth && c && (c.appts > 0 || c.free > 0) && (
                <span className="mt-auto flex flex-wrap gap-1">
                  {c.appts > 0 && (
                    <span className="rounded-full bg-[#e6f4ec] px-1.5 py-0.5 text-[10px] font-semibold text-[#2e7d5b]">
                      {c.appts} turno{c.appts === 1 ? "" : "s"}
                    </span>
                  )}
                  {c.free > 0 && (
                    <span className="rounded-full bg-canvas px-1.5 py-0.5 text-[10px] font-semibold text-muted">
                      {c.free} libre{c.free === 1 ? "" : "s"}
                    </span>
                  )}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {!grid && <p className="text-[13px] text-muted">Cargando calendario…</p>}

      {selected && (
        <DayPanel
          date={selected}
          providerId={role === "recepcion" ? providerId : "all"}
          role={role}
          onClose={() => setSelected(null)}
          onDone={onDone}
        />
      )}
    </div>
  );
}

const navBtn =
  "rounded-md border border-hairline px-2 py-1 text-[13px] font-semibold text-ink transition-colors hover:border-ink";

function DayPanel({
  date,
  providerId,
  role,
  onClose,
  onDone,
}: {
  date: string;
  providerId: string;
  role: "medico" | "recepcion";
  onClose: () => void;
  onDone: (msg: string) => void;
}) {
  const [data, setData] = useState<DayResp | null>(null);
  const [nonce, setNonce] = useState(0);
  const [booking, setBooking] = useState<FreeSlot | null>(null);

  useEffect(() => {
    let alive = true;
    const run = async () => {
      setData(null);
      const params = new URLSearchParams({ date });
      if (role === "recepcion" && providerId !== "all") params.set("providerId", providerId);
      try {
        const d = await fetch(`/api/calendar-grid?${params}`, { cache: "no-store" }).then((r) => r.json());
        if (alive && !d.error) setData(d);
      } catch {
        /* ignore */
      }
    };
    run();
    return () => {
      alive = false;
    };
  }, [date, providerId, role, nonce]);

  const refresh = () => setNonce((n) => n + 1);

  return (
    <div className="rounded-xl border border-hairline bg-canvas/40 p-4">
      <div className="flex items-center justify-between">
        <p className="text-[13px] font-semibold capitalize text-ink">{fmtDay(date)}</p>
        <button className="text-[12px] text-muted hover:text-ink" onClick={onClose}>
          cerrar
        </button>
      </div>

      {!data ? (
        <p className="mt-2 text-[12px] text-muted">Cargando…</p>
      ) : (
        <div className="mt-3 space-y-4">
          <div className="space-y-1.5">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">
              Turnos ({data.appointments.length})
            </p>
            {data.appointments.length === 0 && (
              <p className="text-[12px] text-muted">Sin turnos agendados.</p>
            )}
            {data.appointments.map((a) => (
              <CalRow
                key={a.id}
                showProvider
                onDone={(m) => {
                  onDone(m);
                  refresh();
                }}
                it={{
                  appointmentId: a.id,
                  time: a.time,
                  who: a.patientName,
                  reason: a.reason,
                  status: a.status,
                  providerId: a.providerId,
                  provider: a.providerName,
                  manage: a.manage,
                }}
              />
            ))}
          </div>

          <div className="space-y-1.5">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">
              Horarios libres ({data.freeSlots.length})
            </p>
            {data.freeSlots.length === 0 && (
              <p className="text-[12px] text-muted">No quedan horarios libres.</p>
            )}
            <div className="flex flex-wrap gap-1.5">
              {data.freeSlots.map((s) => (
                <button
                  key={s.slotId}
                  onClick={() => setBooking(s)}
                  className={`rounded-md border px-2 py-1 text-[12px] transition-colors ${
                    booking?.slotId === s.slotId
                      ? "border-ink bg-ink text-white"
                      : "border-hairline text-ink hover:border-ink"
                  }`}
                >
                  {s.time}
                  {role === "recepcion" ? ` · ${s.providerName}` : ""}
                </button>
              ))}
            </div>
          </div>

          {booking && (
            <SlotBooking
              slot={booking}
              onCancel={() => setBooking(null)}
              onDone={(m) => {
                setBooking(null);
                onDone(m);
                refresh();
              }}
            />
          )}
        </div>
      )}
    </div>
  );
}

function SlotBooking({
  slot,
  onCancel,
  onDone,
}: {
  slot: FreeSlot;
  onCancel: () => void;
  onDone: (msg: string) => void;
}) {
  const [patient, setPatient] = useState<PatientHit | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function book() {
    if (!patient) return;
    setBusy(true);
    setError("");
    try {
      const r = await fetch("/api/appointments", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slotId: slot.slotId, patientId: patient.patientId, reason: reason.trim() || undefined }),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) {
        setError(d.error ?? "No se pudo agendar.");
        return;
      }
      onDone(`Turno agendado: ${slot.time} · ${patient.fullName}.`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2 rounded-lg border border-hairline bg-surface p-3">
      <p className="text-[12px] font-semibold text-ink">
        Nuevo turno · {slot.time}
        {slot.providerName ? ` · ${slot.providerName}` : ""}
      </p>
      <PatientPicker selected={patient} onSelect={setPatient} autoFocus />
      <input
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Motivo (opcional)"
        className={FIELD}
      />
      <div className="flex gap-2">
        <button className={BTN_DARK} disabled={busy || !patient} onClick={book}>
          Agendar
        </button>
        <button
          className="rounded-md border border-hairline px-2.5 py-1 text-[12px] font-semibold text-ink hover:border-ink"
          onClick={onCancel}
        >
          Cancelar
        </button>
      </div>
      {error && <p className="text-[12px] text-[#c0392b]">{error}</p>}
    </div>
  );
}
