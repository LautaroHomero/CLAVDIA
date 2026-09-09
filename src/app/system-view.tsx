"use client";

import { useEffect, useState } from "react";
import type { Actor } from "@/lib/domain/types";

const CARD = "flex w-full shrink-0 flex-col gap-3 rounded-xl border border-hairline bg-surface p-5 shadow-card";

type CalStatus = "scheduled" | "in-progress" | "completed" | "cancelled";
type CalItem = {
  time: string;
  who: string;
  provider?: string;
  reason: string;
  status: CalStatus;
  birthday?: boolean;
};
type CalData = { title: string; days: { date: string; label: string; items: CalItem[] }[] };

type SystemData =
  | {
      role: "staff";
      organization: { name: string; address: string; hours: string; phone: string } | null;
      me: { name: string; role: "medico" | "recepcion"; specialty: string | null };
      providers: { name: string; specialty: string; roomLabel: string }[];
      calendar: CalData;
    }
  | {
      role: "paciente";
      profile: {
        fullName: string;
        dni: string;
        dateOfBirth: string;
        coverage: string;
        phone: string;
        email: string;
        allergies: string[];
        activeConditions: string[];
        medications: { name: string; dose: string; chronic: boolean }[];
        orgs: string[];
      };
      calendar: CalData;
    };

const STATUS_DOT: Record<CalStatus, string> = {
  scheduled: "bg-hairline-strong",
  "in-progress": "bg-[#2e7d5b]",
  completed: "bg-[#2e7d5b]/40",
  cancelled: "bg-[#b23b3b]/50",
};
const STATUS_LABEL: Record<CalStatus, string> = {
  scheduled: "Agendado",
  "in-progress": "En atención",
  completed: "Atendido",
  cancelled: "Cancelado",
};

export function SystemView({ actor }: { actor: Actor }) {
  const [data, setData] = useState<SystemData | null>(null);

  useEffect(() => {
    const load = async () => {
      try {
        const r = await fetch("/api/system", { cache: "no-store" });
        if (r.ok) setData(await r.json());
      } catch {
        /* ignore */
      }
    };
    load();
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, [actor.activeOrg?.id]);

  const wide = actor.role !== "paciente";

  return (
    <div className="flex flex-1 flex-col gap-4 md:min-h-0 md:flex-row">
      <section className="flex min-h-[55vh] flex-1 flex-col overflow-hidden rounded-xl border border-hairline bg-surface shadow-card md:min-h-0">
        <header className="border-b border-hairline px-5 py-3.5">
          <h2 className="text-[15px] font-semibold tracking-tight text-ink">
            {data?.calendar.title ?? "Calendario"}
          </h2>
        </header>
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {!data ? (
            <p className="text-[13px] text-muted">Cargando…</p>
          ) : (
            <Calendar data={data.calendar} showProvider={data.role === "staff"} />
          )}
        </div>
      </section>

      <div
        className={`flex w-full flex-col gap-4 overflow-y-auto md:min-h-0 ${wide ? "md:w-96" : "md:w-80"}`}
      >
        {data?.role === "staff" && <StaffSidePanel data={data} />}
        {data?.role === "paciente" && <PatientProfile p={data.profile} />}
      </div>
    </div>
  );
}

function Calendar({ data, showProvider }: { data: CalData; showProvider: boolean }) {
  if (data.days.length === 0)
    return <p className="text-[13px] text-muted">No hay turnos agendados.</p>;

  return (
    <div className="space-y-5">
      {data.days.map((d) => (
        <div key={d.date} className="space-y-2">
          <p className="text-[12px] font-semibold uppercase tracking-wide capitalize text-muted">
            {d.label}
          </p>
          <div className="space-y-1.5">
            {d.items.map((it, i) => (
              <div key={i} className="flex items-start gap-3 rounded-lg border border-hairline px-3 py-2.5">
                <span
                  className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_DOT[it.status]}`}
                  aria-hidden
                />
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
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function StaffSidePanel({ data }: { data: Extract<SystemData, { role: "staff" }> }) {
  const roleLabel =
    data.me.role === "medico" ? data.me.specialty ?? "Médico/a" : "Recepción";

  return (
    <>
      <aside className={CARD}>
        <h3 className="text-[14px] font-semibold tracking-tight text-ink">Mi perfil</h3>
        <div className="space-y-0.5 text-[13px]">
          <p className="font-medium text-ink">{data.me.name}</p>
          <p className="text-muted">{roleLabel}</p>
        </div>
      </aside>

      {data.organization && (
        <aside className={CARD}>
          <h3 className="text-[14px] font-semibold tracking-tight text-ink">Consultorio</h3>
          <div className="space-y-1 text-[13px]">
            <p className="font-medium text-ink">{data.organization.name}</p>
            <InfoRow label="Dirección" value={data.organization.address} />
            <InfoRow label="Horarios" value={data.organization.hours} />
            <InfoRow label="Teléfono" value={data.organization.phone} />
          </div>
        </aside>
      )}

      <aside className={CARD}>
        <div className="flex items-center justify-between">
          <h3 className="text-[14px] font-semibold tracking-tight text-ink">Profesionales</h3>
          <span className="text-[11px] text-muted">{data.providers.length}</span>
        </div>
        <div className="space-y-2">
          {data.providers.length === 0 && (
            <p className="text-[12px] text-muted">
              Todavía no hay profesionales. Se dan de alta desde el chat (recepción).
            </p>
          )}
          {data.providers.map((p, i) => (
            <div key={i} className="rounded-lg border border-hairline px-3 py-2">
              <p className="text-[13px] font-medium text-ink">{p.name}</p>
              <p className="text-[12px] text-muted">
                {p.specialty} · {p.roomLabel}
              </p>
            </div>
          ))}
        </div>
      </aside>
    </>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  if (!value) return null;
  return (
    <p className="text-muted">
      <span className="text-ink/50">{label}: </span>
      {value}
    </p>
  );
}

function PatientProfile({ p }: { p: Extract<SystemData, { role: "paciente" }>["profile"] }) {
  const dob = new Date(`${p.dateOfBirth}T12:00:00`).toLocaleDateString("es-AR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });

  return (
    <aside className={CARD}>
      <h3 className="text-[14px] font-semibold tracking-tight text-ink">Mi ficha</h3>
      <div className="space-y-0.5 text-[13px]">
        <p className="text-[15px] font-semibold text-ink">{p.fullName}</p>
        <p className="text-muted">
          DNI {p.dni} · nació el {dob}
        </p>
        <p className="text-muted">{p.coverage}</p>
        {p.phone && <p className="text-muted">{p.phone}</p>}
        {p.email && <p className="text-muted">{p.email}</p>}
      </div>

      <Chips title="Alergias" items={p.allergies} empty="Sin alergias registradas." />
      <Chips title="Condiciones activas" items={p.activeConditions} empty="Sin condiciones registradas." />

      <div className="space-y-1.5">
        <p className="text-[12px] font-semibold uppercase tracking-wide text-muted">Medicación</p>
        {p.medications.length === 0 && (
          <p className="text-[12px] text-muted">Sin medicación registrada.</p>
        )}
        {p.medications.map((m, i) => (
          <div
            key={i}
            className="flex items-center justify-between rounded-lg border border-hairline px-3 py-1.5"
          >
            <span className="text-[12px] text-ink">
              {m.name} <span className="text-muted">{m.dose}</span>
            </span>
            {m.chronic && (
              <span className="rounded-full bg-canvas px-2 py-0.5 text-[10px] font-semibold text-muted">
                crónica
              </span>
            )}
          </div>
        ))}
      </div>

      <Chips title="Consultorios" items={p.orgs} empty="—" />
    </aside>
  );
}

function Chips({ title, items, empty }: { title: string; items: string[]; empty: string }) {
  return (
    <div className="space-y-1.5">
      <p className="text-[12px] font-semibold uppercase tracking-wide text-muted">{title}</p>
      {items.length === 0 ? (
        <p className="text-[12px] text-muted">{empty}</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {items.map((it, i) => (
            <span
              key={i}
              className="rounded-full border border-hairline px-2.5 py-1 text-[12px] text-ink"
            >
              {it}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
