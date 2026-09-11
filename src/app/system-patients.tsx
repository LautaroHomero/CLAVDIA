"use client";

import { useEffect, useState } from "react";
import { BTN, BTN_DARK, FIELD, fmtDateTime } from "./system-shared";

interface MedRow {
  id: string;
  name: string;
  dose: string;
  lastPrescribed: string;
  chronic: boolean;
}
interface Ficha {
  id: string;
  fullName: string;
  dni: string;
  dateOfBirth: string;
  phone: string;
  email: string;
  coverage: string;
  allergies: string[];
  activeConditions: string[];
  notes: string;
  medications: MedRow[];
}
interface Hit {
  patientId: string;
  fullName: string;
  dni: string;
  phone: string;
  email: string;
  coverage: string;
}

export function PatientsPanel({ onDone }: { onDone: (msg: string) => void }) {
  const [view, setView] = useState<"browse" | "new">("browse");
  const [openId, setOpenId] = useState<string | null>(null);

  return (
    <div className="space-y-3">
      {!openId && (
        <>
          <div className="flex items-center justify-between">
            <h3 className="text-[14px] font-semibold tracking-tight text-ink">Pacientes</h3>
            <button className={BTN_DARK} onClick={() => setView(view === "new" ? "browse" : "new")}>
              {view === "new" ? "Cerrar" : "+ Nuevo paciente"}
            </button>
          </div>
          {view === "new" ? (
            <NewPatientForm
              onCancel={() => setView("browse")}
              onDone={(msg, id) => {
                onDone(msg);
                setView("browse");
                setOpenId(id);
              }}
            />
          ) : (
            <BrowsePatients onOpen={setOpenId} />
          )}
        </>
      )}

      {openId && (
        <FichaEditor
          patientId={openId}
          onBack={() => setOpenId(null)}
          onDone={onDone}
        />
      )}
    </div>
  );
}

function BrowsePatients({ onOpen }: { onOpen: (id: string) => void }) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [total, setTotal] = useState(0);

  useEffect(() => {
    let alive = true;
    const q = query.trim();
    const t = setTimeout(() => {
      const run = async () => {
        try {
          const d = await fetch(`/api/patients/search?q=${encodeURIComponent(q)}`, {
            cache: "no-store",
          }).then((r) => r.json());
          if (!alive) return;
          setHits(d.matches ?? []);
          setTotal(d.count ?? (d.matches?.length ?? 0));
        } catch {
          if (alive) setHits([]);
        }
      };
      run();
    }, 180);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [query]);

  const filtering = query.trim().length > 0;

  return (
    <div className="space-y-2">
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Filtrar por nombre, DNI, email o celular"
        className={FIELD}
      />

      {hits === null ? (
        <p className="text-[12px] text-muted">Cargando pacientes…</p>
      ) : (
        <>
          <p className="text-[11px] text-muted">
            {filtering
              ? `${hits.length} de ${total} paciente${total === 1 ? "" : "s"}`
              : `${total} paciente${total === 1 ? "" : "s"} en el consultorio`}
          </p>
          {hits.length === 0 && (
            <p className="text-[12px] text-muted">
              {filtering
                ? "Ningún paciente coincide. Podés darlo de alta con “+ Nuevo paciente”."
                : "Todavía no hay pacientes. Cargá el primero con “+ Nuevo paciente”."}
            </p>
          )}
          <div className="max-h-[60vh] space-y-1.5 overflow-y-auto">
            {hits.map((h) => (
              <button
                key={h.patientId}
                onClick={() => onOpen(h.patientId)}
                className="block w-full rounded-lg border border-hairline px-3 py-2 text-left transition-colors hover:border-ink"
              >
                <p className="text-[13px] font-medium text-ink">{h.fullName}</p>
                <p className="text-[12px] text-muted">
                  DNI {h.dni} · {h.coverage}
                  {h.phone ? ` · ${h.phone}` : ""}
                  {h.email ? ` · ${h.email}` : ""}
                </p>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

const LABEL = "text-[12px] font-semibold text-ink";

function NewPatientForm({
  onCancel,
  onDone,
}: {
  onCancel: () => void;
  onDone: (msg: string, id: string) => void;
}) {
  const [f, setF] = useState({ fullName: "", dni: "", dateOfBirth: "", coverage: "", phone: "", email: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });

  async function submit() {
    setBusy(true);
    setError("");
    try {
      const r = await fetch("/api/patients", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(f),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) {
        setError(d.error ?? "No se pudo crear.");
        return;
      }
      onDone(d.message ?? "Paciente dado de alta.", d.patientId);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2 rounded-lg border border-hairline p-3">
      <input value={f.dni} onChange={set("dni")} placeholder="DNI" className={FIELD} />
      <p className="text-[11px] text-muted">
        Si el paciente ya está en el sistema, con el DNI alcanza: se lo suma a este consultorio. Si es
        nuevo/a, completá también nombre, nacimiento, cobertura, email y teléfono (email y teléfono le
        sirven para recuperar el PIN y entrar).
      </p>
      <input value={f.fullName} onChange={set("fullName")} placeholder="Nombre y apellido" className={FIELD} />
      <input
        value={f.dateOfBirth}
        onChange={set("dateOfBirth")}
        placeholder="Fecha de nacimiento (AAAA-MM-DD)"
        className={FIELD}
      />
      <input value={f.coverage} onChange={set("coverage")} placeholder="Cobertura (obra social / prepaga)" className={FIELD} />
      <input value={f.phone} onChange={set("phone")} placeholder="Teléfono" className={FIELD} />
      <input value={f.email} onChange={set("email")} placeholder="Email" className={FIELD} />
      <div className="flex gap-2">
        <button
          className={BTN_DARK}
          disabled={
            busy ||
            f.dni.replace(/\D/g, "").length < 7
          }
          onClick={submit}
        >
          Dar de alta
        </button>
        <button className={BTN} onClick={onCancel}>
          Cancelar
        </button>
      </div>
      {error && <p className="text-[12px] text-[#c0392b]">{error}</p>}
    </div>
  );
}

function FichaEditor({
  patientId,
  onBack,
  onDone,
}: {
  patientId: string;
  onBack: () => void;
  onDone: (msg: string) => void;
}) {
  const [ficha, setFicha] = useState<Ficha | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    const run = async () => {
      setFicha(null);
      setError("");
      try {
        const d = await fetch(`/api/patients/${patientId}`, { cache: "no-store" }).then((r) => r.json());
        if (!alive) return;
        if (d.ok) setFicha(d.patient);
        else setError(d.error ?? "No se pudo cargar la ficha.");
      } catch {
        if (alive) setError("No se pudo cargar la ficha.");
      }
    };
    run();
    return () => {
      alive = false;
    };
  }, [patientId]);

  function upd<K extends keyof Ficha>(k: K, v: Ficha[K]) {
    setFicha((f) => (f ? { ...f, [k]: v } : f));
  }

  async function save() {
    if (!ficha) return;
    setBusy(true);
    setError("");
    try {
      const r = await fetch(`/api/patients/${patientId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          fullName: ficha.fullName,
          dni: ficha.dni,
          dateOfBirth: ficha.dateOfBirth,
          phone: ficha.phone,
          email: ficha.email,
          coverage: ficha.coverage,
          notes: ficha.notes,
          allergies: ficha.allergies,
          activeConditions: ficha.activeConditions,
        }),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) {
        setError(d.error ?? "No se pudo guardar.");
        return;
      }
      setFicha(d.patient);
      onDone("Ficha guardada.");
    } finally {
      setBusy(false);
    }
  }

  async function medApi(url: string, method: string, body?: unknown) {
    const r = await fetch(url, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const d = await r.json();
    if (r.ok && d.ok) setFicha((f) => (f ? { ...f, medications: d.medications } : f));
    else setError(d.error ?? "No se pudo actualizar la medicación.");
  }

  return (
    <div className="space-y-3">
      <button className="text-[12px] font-medium text-muted hover:text-ink" onClick={onBack}>
        ← volver a pacientes
      </button>

      {error && <p className="text-[12px] text-[#c0392b]">{error}</p>}
      {!ficha ? (
        <p className="text-[13px] text-muted">Cargando ficha…</p>
      ) : (
        <div className="space-y-4">
          <div className="grid gap-2 sm:grid-cols-2">
            <Field label="Nombre y apellido" value={ficha.fullName} onChange={(v) => upd("fullName", v)} />
            <Field label="DNI" value={ficha.dni} onChange={(v) => upd("dni", v)} />
            <Field label="Fecha de nacimiento" value={ficha.dateOfBirth} onChange={(v) => upd("dateOfBirth", v)} type="date" />
            <Field label="Cobertura" value={ficha.coverage} onChange={(v) => upd("coverage", v)} />
            <Field label="Teléfono" value={ficha.phone} onChange={(v) => upd("phone", v)} />
            <Field label="Email" value={ficha.email} onChange={(v) => upd("email", v)} />
          </div>

          <ChipEditor
            label="Alergias"
            items={ficha.allergies}
            onChange={(v) => upd("allergies", v)}
          />
          <ChipEditor
            label="Condiciones activas"
            items={ficha.activeConditions}
            onChange={(v) => upd("activeConditions", v)}
          />

          <div className="space-y-1.5">
            <p className={LABEL}>Notas internas</p>
            <textarea
              value={ficha.notes}
              onChange={(e) => upd("notes", e.target.value)}
              rows={3}
              className={FIELD}
            />
          </div>

          <button className={BTN_DARK} disabled={busy} onClick={save}>
            Guardar cambios
          </button>

          <div className="space-y-2 border-t border-hairline pt-3">
            <p className={LABEL}>Medicación</p>
            {ficha.medications.length === 0 && (
              <p className="text-[12px] text-muted">Sin medicación registrada.</p>
            )}
            {ficha.medications.map((m) => (
              <div key={m.id} className="flex items-center justify-between rounded-lg border border-hairline px-3 py-1.5">
                <span className="text-[12px] text-ink">
                  {m.name} <span className="text-muted">{m.dose}</span>
                  {m.chronic && (
                    <span className="ml-1.5 rounded-full bg-canvas px-2 py-0.5 text-[10px] font-semibold text-muted">
                      crónica
                    </span>
                  )}
                  <span className="ml-1.5 text-[10px] text-muted/70">últ. {fmtDateTime(`${m.lastPrescribed}T12:00:00`).replace(/,.*/, "")}</span>
                </span>
                <button
                  className="text-[11px] font-semibold text-[#b23b3b] hover:opacity-80"
                  onClick={() => medApi(`/api/patients/${patientId}/medications/${m.id}`, "DELETE")}
                >
                  quitar
                </button>
              </div>
            ))}
            <AddMedRow onAdd={(body) => medApi(`/api/patients/${patientId}/medications`, "POST", body)} />
          </div>
        </div>
      )}
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  type,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
}) {
  return (
    <label className="space-y-1">
      <span className={LABEL}>{label}</span>
      <input type={type ?? "text"} value={value} onChange={(e) => onChange(e.target.value)} className={FIELD} />
    </label>
  );
}

function ChipEditor({
  label,
  items,
  onChange,
}: {
  label: string;
  items: string[];
  onChange: (v: string[]) => void;
}) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const v = draft.trim();
    if (v && !items.includes(v)) onChange([...items, v]);
    setDraft("");
  };
  return (
    <div className="space-y-1.5">
      <p className={LABEL}>{label}</p>
      <div className="flex flex-wrap gap-1.5">
        {items.map((it) => (
          <span
            key={it}
            className="flex items-center gap-1 rounded-full border border-hairline px-2.5 py-1 text-[12px] text-ink"
          >
            {it}
            <button
              className="text-muted hover:text-ink"
              onClick={() => onChange(items.filter((x) => x !== it))}
              aria-label={`Quitar ${it}`}
            >
              ✕
            </button>
          </span>
        ))}
      </div>
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            add();
          }
        }}
        onBlur={add}
        placeholder={`Agregar y Enter`}
        className={FIELD}
      />
    </div>
  );
}

function AddMedRow({ onAdd }: { onAdd: (body: { name: string; dose: string; chronic: boolean }) => void }) {
  const [name, setName] = useState("");
  const [dose, setDose] = useState("");
  const [chronic, setChronic] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-hairline px-3 py-2">
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Medicamento" className={`${FIELD} max-w-[10rem]`} />
      <input value={dose} onChange={(e) => setDose(e.target.value)} placeholder="Dosis" className={`${FIELD} max-w-[9rem]`} />
      <label className="flex items-center gap-1 text-[12px] text-muted">
        <input type="checkbox" checked={chronic} onChange={(e) => setChronic(e.target.checked)} />
        crónica
      </label>
      <button
        className={BTN_DARK}
        disabled={!name.trim() || !dose.trim()}
        onClick={() => {
          onAdd({ name: name.trim(), dose: dose.trim(), chronic });
          setName("");
          setDose("");
          setChronic(false);
        }}
      >
        Agregar
      </button>
    </div>
  );
}
