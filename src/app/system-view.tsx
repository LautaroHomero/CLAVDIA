"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Actor, ProviderSettings } from "@/lib/domain/types";
import { SPECIALTIES } from "@/lib/domain/specialties";
import { MonthCalendar } from "./system-calendar";
import { PatientsPanel } from "./system-patients";
import {
  BTN,
  BTN_DARK,
  CalRow,
  CARD,
  type CalRowItem,
  FIELD,
  fmtDateTime,
  PatientPicker,
  type PatientHit,
  SlotPicker,
} from "./system-shared";

type StaffView = "calendario" | "lista" | "pacientes" | "profesionales" ;
const STAFF_VIEW_KEY = "clavdia_sistema_view";

interface CalItem extends CalRowItem {
  startIso: string;
}
type CalData = { title: string; days: { date: string; label: string; items: CalItem[] }[] };

interface ChangeReq {
  id: string;
  kind: "cancel" | "reschedule";
  patientName: string;
  providerName: string;
  reason?: string;
  requestedBy: string;
  createdAt: string;
  currentStart: string | null;
  appointmentStatus: string | null;
}

type SystemData =
  | {
      role: "staff";
      organization: { name: string; address: string; city: string; hours: string; phone: string } | null;
      me: { name: string; role: "medico" | "recepcion"; specialty: string | null; canAdmin: boolean };
      providers: { name: string; specialty: string; roomLabel: string }[];
      calendar: CalData;
      providerSettings: ProviderSettings | null;
      changeRequests: ChangeReq[];
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
      orgs: { id: string; name: string }[];
      calendar: CalData;
      changeRequests: ChangeReq[];
    };

// ---------------------------------------------------------------------------

export function SystemView({ actor }: { actor: Actor }) {
  const [data, setData] = useState<SystemData | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [staffView, setStaffView] = useState<StaffView>("calendario");
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reloadRef = useRef<() => void>(() => {});

  useEffect(() => {
    const restore = () => {
      try {
        const v = localStorage.getItem(STAFF_VIEW_KEY);
        if (v === "calendario" || v === "lista" || v === "pacientes" || v === "profesionales") setStaffView(v);
      } catch {
        /* ignore */
      }
    };
    restore();
  }, []);

  function changeStaffView(v: StaffView) {
    setStaffView(v);
    try {
      localStorage.setItem(STAFF_VIEW_KEY, v);
    } catch {
      /* ignore */
    }
  }

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch("/api/system", { cache: "no-store" });
        if (alive && r.ok) setData(await r.json());
      } catch {
        /* ignore */
      }
    };
    reloadRef.current = load;
    load();
    const id = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [actor.activeOrg?.id]);

  const load = useCallback(() => reloadRef.current(), []);

  const notify = useCallback((msg: string) => {
    setFlash(msg);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash(null), 4000);
  }, []);

  const done = useCallback(
    (msg: string) => {
      notify(msg);
      load();
    },
    [notify, load],
  );

  const isStaff = data?.role === "staff";
  const wide = actor.role !== "paciente";

  return (
    <div className="flex flex-1 flex-col gap-4 md:min-h-0 md:flex-row">
      <section className="flex min-h-[55vh] flex-1 flex-col overflow-hidden rounded-xl border border-hairline bg-surface shadow-card md:min-h-0">
        <header className="relative flex flex-wrap items-center justify-between gap-3 border-b border-hairline px-5 py-3.5">
          {isStaff && data ? (
            <div className="flex rounded-pill border border-hairline p-0.5 text-[12px] font-semibold">
              {([
                "calendario",
                "lista",
                "pacientes",
                ...(data.role === "staff" && data.me.canAdmin ? (["profesionales"] as const) : []),
              ] as StaffView[]).map((v) => (
                <button
                  key={v}
                  onClick={() => changeStaffView(v)}
                  className={`rounded-pill px-3 py-1 capitalize transition-colors ${
                    staffView === v ? "bg-ink text-white" : "text-muted hover:text-ink"
                  }`}
                >
                  {v}
                </button>
              ))}
            </div>
          ) : (
            <h2 className="text-[15px] font-semibold tracking-tight text-ink">
              {data?.calendar.title ?? "Calendario"}
            </h2>
          )}
          {data && (!isStaff || staffView === "lista") && (
            <NewAppointmentButton data={data} onDone={done} />
          )}
        </header>

        {flash && (
          <p className="border-b border-hairline bg-canvas px-5 py-2 text-[12px] text-ink/80">{flash}</p>
        )}

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {!data ? (
            <p className="text-[13px] text-muted">Cargando…</p>
          ) : data.role === "staff" && staffView === "calendario" ? (
            <MonthCalendar role={data.me.role} onDone={done} />
          ) : data.role === "staff" && staffView === "pacientes" ? (
            <PatientsPanel onDone={done} />
          ) : data.role === "staff" && staffView === "profesionales" && data.me.canAdmin ? (
            <ProfesionalesPanel data={data} onDone={done} />
          ) : (
            <ListCalendar data={data.calendar} showProvider={data.role === "staff"} onDone={done} />
          )}
        </div>
        <footer className="border-t border-hairline px-5 py-2 text-center text-[11px] text-muted/70">
          CLAVDIA · Клавдия
        </footer>
      </section>

      <div className={`flex w-full flex-col gap-4 overflow-y-auto md:min-h-0 ${wide ? "md:w-96" : "md:w-80"}`}>
        {data?.role === "staff" && <StaffSidePanel data={data} onDone={done} />}
        {data?.role === "paciente" && (
          <>
            <PatientProfile p={data.profile} />
            {data.changeRequests.length > 0 && <PatientChangeRequests items={data.changeRequests} />}
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// List view
// ---------------------------------------------------------------------------

function ListCalendar({
  data,
  showProvider,
  onDone,
}: {
  data: CalData;
  showProvider: boolean;
  onDone: (msg: string) => void;
}) {
  if (data.days.length === 0) return <p className="text-[13px] text-muted">No hay turnos agendados.</p>;
  return (
    <div className="space-y-5">
      {data.days.map((d) => (
        <div key={d.date} className="space-y-2">
          <p className="text-[12px] font-semibold uppercase tracking-wide capitalize text-muted">{d.label}</p>
          <div className="space-y-1.5">
            {d.items.map((it) => (
              <CalRow key={it.appointmentId} it={it} showProvider={showProvider} onDone={onDone} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}


function NewAppointmentButton({ data, onDone }: { data: SystemData; onDone: (msg: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className={BTN_DARK} onClick={() => setOpen((v) => !v)}>
        {open ? "Cerrar" : "+ Nuevo turno"}
      </button>
      {open && (
        <div className="absolute inset-x-0 top-full z-20 mt-1 max-h-[70vh] overflow-y-auto rounded-xl border border-hairline bg-surface p-4 shadow-card">
          <BookingForm
            data={data}
            onClose={() => setOpen(false)}
            onDone={(msg) => {
              setOpen(false);
              onDone(msg);
            }}
          />
        </div>
      )}
    </>
  );
}

function BookingForm({
  data,
  onClose,
  onDone,
}: {
  data: SystemData;
  onClose: () => void;
  onDone: (msg: string) => void;
}) {
  const isPatient = data.role === "paciente";
  const orgs = isPatient ? data.orgs : [];
  const [orgId, setOrgId] = useState(orgs[0]?.id ?? "");
  const [patient, setPatient] = useState<PatientHit | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const readyToPickSlot = isPatient ? orgs.length <= 1 || !!orgId : !!patient;

  async function book(slotId: string) {
    setBusy(true);
    setError("");
    try {
      const body: Record<string, unknown> = { slotId, reason: reason.trim() || undefined };
      if (isPatient) {
        if (orgId) body.organizationId = orgId;
      } else if (patient) {
        body.patientId = patient.patientId;
      }
      const r = await fetch("/api/appointments", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) {
        setError(d.error ?? "No se pudo agendar.");
        return;
      }
      onDone(`Turno agendado: ${fmtDateTime(d.appointment?.start)}.`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-[13px] font-semibold text-ink">Nuevo turno</p>
        <button className="text-[12px] text-muted hover:text-ink" onClick={onClose}>
          cerrar
        </button>
      </div>

      {isPatient && orgs.length > 1 && (
        <select value={orgId} onChange={(e) => setOrgId(e.target.value)} className={FIELD}>
          {orgs.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
      )}

      {!isPatient && <PatientPicker selected={patient} onSelect={setPatient} autoFocus />}

      <input
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Motivo (opcional)"
        className={FIELD}
      />

      {readyToPickSlot ? (
        <SlotPicker
          organizationId={isPatient ? orgId || undefined : undefined}
          disabled={busy}
          onPick={book}
          showProvider
        />
      ) : (
        <p className="text-[12px] text-muted">
          {isPatient ? "Elegí el consultorio." : "Elegí un paciente para ver los horarios."}
        </p>
      )}

      {error && <p className="text-[12px] text-[#c0392b]">{error}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Staff side panel
// ---------------------------------------------------------------------------

function StaffSidePanel({
  data,
  onDone,
}: {
  data: Extract<SystemData, { role: "staff" }>;
  onDone: (msg: string) => void;
}) {
  const roleLabel = data.me.role === "medico" ? data.me.specialty ?? "Médico/a" : "Recepción";

  return (
    <>
      <aside className={CARD}>
        <h3 className="text-[14px] font-semibold tracking-tight text-ink">Mi perfil</h3>
        <div className="space-y-0.5 text-[13px]">
          <p className="font-medium text-ink">{data.me.name}</p>
          <p className="text-muted">{roleLabel}</p>
        </div>
      </aside>

      {data.me.role === "medico" && data.providerSettings && (
        <ChangePolicyCard settings={data.providerSettings} onDone={onDone} />
      )}

      {data.changeRequests.length > 0 && <ChangeRequestsCard items={data.changeRequests} onDone={onDone} />}

      {data.organization && (
        <aside className={CARD}>
          <h3 className="text-[14px] font-semibold tracking-tight text-ink">Consultorio</h3>
          <div className="space-y-1 text-[13px]">
            <p className="font-medium text-ink">{data.organization.name}</p>
            <InfoRow
              label="Dirección"
              value={[data.organization.address, data.organization.city].filter(Boolean).join(", ")}
            />
            <InfoRow label="Horarios" value={data.organization.hours} />
            <InfoRow label="Teléfono" value={data.organization.phone} />
          </div>
        </aside>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Profesionales tab (admin / secretaría only)
// ---------------------------------------------------------------------------

function ProfesionalesPanel({
  data,
  onDone,
}: {
  data: Extract<SystemData, { role: "staff" }>;
  onDone: (msg: string) => void;
}) {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-[14px] font-semibold tracking-tight text-ink">
          Profesionales <span className="text-[11px] font-normal text-muted">({data.providers.length})</span>
        </h3>
      </div>

      {data.providers.length === 0 ? (
        <p className="text-[13px] text-muted">
          Todavía no hay profesionales. Agregá el primero acá abajo o desde el chat.
        </p>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2">
          {data.providers.map((p, i) => (
            <div key={i} className="rounded-lg border border-hairline px-3.5 py-3">
              <p className="text-[13px] font-medium text-ink">{p.name}</p>
              <p className="text-[12px] text-muted">
                {p.specialty} · {p.roomLabel}
              </p>
            </div>
          ))}
        </div>
      )}

      <div className="max-w-md">
        <AddProfessional onDone={onDone} />
      </div>

      {data.providers.length === 0 && <OnboardingChecklist />}
    </div>
  );
}

const OTHER = "__other__";

/** Secretaría / founder: add a team member (secretaría or professional) to the active org. */
function AddProfessional({ onDone }: { onDone: (msg: string) => void }) {
  const [open, setOpen] = useState(false);
  const [role, setRole] = useState<"medico" | "recepcion">("medico");
  const [f, setF] = useState({ dni: "", name: "", email: "", phone: "", specialty: "", specialtyOther: "", roomLabel: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setF({ ...f, [k]: e.target.value });

  const specialty = f.specialty === OTHER ? f.specialtyOther.trim() : f.specialty;
  // DNI alone is enough for someone already in the system; the server asks for
  // the rest only when the person is new.
  const ready = f.dni.replace(/\D/g, "").length >= 7;

  function reset() {
    setF({ dni: "", name: "", email: "", phone: "", specialty: "", specialtyOther: "", roomLabel: "" });
    setRole("medico");
  }

  async function submit() {
    setBusy(true);
    setError("");
    try {
      const r = await fetch("/api/professionals", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          role,
          dni: f.dni.trim(),
          name: f.name.trim() || undefined,
          email: f.email.trim() || undefined,
          phone: f.phone.trim() || undefined,
          specialty: role === "medico" ? specialty || undefined : undefined,
          roomLabel: role === "medico" ? f.roomLabel.trim() || undefined : undefined,
        }),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) {
        setError(d.error ?? "No se pudo dar de alta.");
        return;
      }
      reset();
      setOpen(false);
      onDone(d.message ?? "Alta realizada.");
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button className={BTN} onClick={() => setOpen(true)}>
        + Agregar al equipo
      </button>
    );
  }

  return (
    <div className="space-y-2 rounded-lg border border-hairline p-3">
      <div className="flex items-center justify-between">
        <p className="text-[13px] font-semibold text-ink">Nueva persona</p>
        <button className="text-[12px] text-muted hover:text-ink" onClick={() => setOpen(false)}>
          cerrar
        </button>
      </div>

      <div className="flex rounded-md border border-hairline p-0.5 text-[12px] font-semibold">
        {(
          [
            ["medico", "Profesional"],
            ["recepcion", "Secretaría"],
          ] as const
        ).map(([v, label]) => (
          <button
            key={v}
            onClick={() => setRole(v)}
            className={`flex-1 rounded-[5px] px-2 py-1 transition-colors ${
              role === v ? "bg-ink text-white" : "text-muted hover:text-ink"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <input value={f.dni} onChange={set("dni")} placeholder="DNI" className={FIELD} />
      <p className="text-[11px] text-muted">
        Si ya está en el sistema, con el DNI alcanza. Si es nuevo/a, completá también:
      </p>
      <input
        value={f.name}
        onChange={set("name")}
        placeholder={role === "medico" ? "Nombre con título (Dra. Laura Gómez)" : "Nombre y apellido"}
        className={FIELD}
      />
      <input type="email" value={f.email} onChange={set("email")} placeholder="Email para ingresar / recuperar PIN" className={FIELD} />
      <input value={f.phone} onChange={set("phone")} placeholder="Teléfono" className={FIELD} />

      {role === "medico" && (
        <>
          <select value={f.specialty} onChange={set("specialty")} className={FIELD}>
            <option value="">Tipo de profesional…</option>
            {SPECIALTIES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
            <option value={OTHER}>Otra…</option>
          </select>
          {f.specialty === OTHER && (
            <input
              value={f.specialtyOther}
              onChange={set("specialtyOther")}
              placeholder="Especificá la especialidad / profesión"
              className={FIELD}
            />
          )}
          <input value={f.roomLabel} onChange={set("roomLabel")} placeholder="Consultorio / box (opcional)" className={FIELD} />
        </>
      )}

      <p className="text-[11px] text-muted">
        La persona entra con su DNI o email y “Olvidé mi PIN” para elegir su PIN.
      </p>
      <button className={BTN_DARK} disabled={busy || !ready} onClick={submit}>
        Dar de alta
      </button>
      {error && <p className="text-[12px] text-[#c0392b]">{error}</p>}
    </div>
  );
}

/** Shown right after a consultorio is created, while there are no professionals yet. */
function OnboardingChecklist() {
  return (
    <aside className={`${CARD} border-ink/20 bg-canvas`}>
      <h3 className="text-[14px] font-semibold tracking-tight text-ink">Primeros pasos</h3>
      <ul className="space-y-1.5 text-[12px] text-ink/80">
        <li>• Agregá tus profesionales acá arriba (o desde el chat).</li>
        <li>• Revisá dirección y horarios en el panel “Consultorio”.</li>
        <li>• Cargá pacientes desde la pestaña “Pacientes” o el chat.</li>
        <li>• Cada profesional carga sus precios y su política de cambios de turno.</li>
      </ul>
    </aside>
  );
}

function ChangePolicyCard({
  settings,
  onDone,
}: {
  settings: ProviderSettings;
  onDone: (msg: string) => void;
}) {
  const [busy, setBusy] = useState(false);

  async function patch(body: Partial<ProviderSettings>) {
    setBusy(true);
    try {
      const r = await fetch("/api/providers/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (r.ok) onDone("Política de cambios actualizada.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <aside className={CARD}>
      <h3 className="text-[14px] font-semibold tracking-tight text-ink">Cambios de turno (mi agenda)</h3>

      <Toggle
        label="¿Quién puede sacar o cambiar turnos?"
        value={settings.whoCanChange}
        disabled={busy}
        options={[
          { value: "anyone", label: "Cualquiera (incluye paciente)" },
          { value: "staff_only", label: "Solo recepción y yo" },
        ]}
        onChange={(v) => patch({ whoCanChange: v as ProviderSettings["whoCanChange"] })}
      />

      <Toggle
        label="Cambios del paciente con menos de 24 h"
        value={settings.lateChangePolicy}
        disabled={busy}
        options={[
          { value: "direct", label: "Directos" },
          { value: "needs_approval", label: "Requieren mi aprobación" },
        ]}
        onChange={(v) => patch({ lateChangePolicy: v as ProviderSettings["lateChangePolicy"] })}
      />
    </aside>
  );
}

function Toggle({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  disabled?: boolean;
  onChange: (v: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      <p className="text-[12px] font-semibold text-ink">{label}</p>
      <div className="flex flex-col gap-1">
        {options.map((o) => (
          <button
            key={o.value}
            disabled={disabled || o.value === value}
            onClick={() => onChange(o.value)}
            className={`rounded-md border px-2.5 py-1.5 text-left text-[12px] transition-colors ${
              o.value === value
                ? "border-ink bg-ink text-white"
                : "border-hairline text-ink hover:border-ink disabled:opacity-40"
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function ChangeRequestsCard({ items, onDone }: { items: ChangeReq[]; onDone: (msg: string) => void }) {
  return (
    <aside className={CARD}>
      <h3 className="text-[14px] font-semibold tracking-tight text-ink">
        Pedidos de cambio <span className="text-[11px] text-muted">({items.length})</span>
      </h3>
      {items.map((it) => (
        <ChangeRequestRow key={it.id} it={it} onDone={onDone} />
      ))}
    </aside>
  );
}

function ChangeRequestRow({ it, onDone }: { it: ChangeReq; onDone: (msg: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function decide(approved: boolean) {
    setBusy(true);
    setError("");
    try {
      const r = await fetch("/api/appointment-changes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: it.id, approved }),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) {
        setError(d.error ?? "No se pudo procesar.");
        return;
      }
      onDone(
        approved
          ? `Cambio aplicado (${it.kind === "cancel" ? "cancelación" : "reprogramación"}).`
          : "Pedido rechazado.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2 rounded-lg border border-hairline p-3">
      <p className="text-[13px] font-semibold text-ink">
        {it.kind === "cancel" ? "Cancelar" : "Reprogramar"} · {it.patientName}
      </p>
      <p className="text-[12px] text-muted">
        {it.providerName} · {fmtDateTime(it.currentStart)}
        {it.reason ? ` · ${it.reason}` : ""}
      </p>
      <p className="text-[11px] text-muted/80">Pedido por {it.requestedBy}</p>
      {it.appointmentStatus && it.appointmentStatus !== "scheduled" && (
        <p className="text-[11px] text-[#9a6a1f]">El turno ya está {it.appointmentStatus}.</p>
      )}
      <div className="flex gap-2">
        <button className={BTN_DARK} disabled={busy} onClick={() => decide(true)}>
          Aprobar
        </button>
        <button className={BTN} disabled={busy} onClick={() => decide(false)}>
          Rechazar
        </button>
      </div>
      {error && <p className="text-[12px] text-[#c0392b]">{error}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Patient panels
// ---------------------------------------------------------------------------

function PatientChangeRequests({ items }: { items: ChangeReq[] }) {
  return (
    <aside className={CARD}>
      <h3 className="text-[14px] font-semibold tracking-tight text-ink">Mis pedidos de cambio</h3>
      {items.map((it) => (
        <div key={it.id} className="rounded-lg border border-hairline px-3 py-2">
          <p className="text-[12px] font-medium text-ink">
            {it.kind === "cancel" ? "Cancelación" : "Reprogramación"} · {fmtDateTime(it.currentStart)}
          </p>
          <p className="text-[11px] text-[#9a6a1f]">En revisión del profesional.</p>
        </div>
      ))}
    </aside>
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
        {p.medications.length === 0 && <p className="text-[12px] text-muted">Sin medicación registrada.</p>}
        {p.medications.map((m, i) => (
          <div key={i} className="flex items-center justify-between rounded-lg border border-hairline px-3 py-1.5">
            <span className="text-[12px] text-ink">
              {m.name} <span className="text-muted">{m.dose}</span>
            </span>
            {m.chronic && (
              <span className="rounded-full bg-canvas px-2 py-0.5 text-[10px] font-semibold text-muted">crónica</span>
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
            <span key={i} className="rounded-full border border-hairline px-2.5 py-1 text-[12px] text-ink">
              {it}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
