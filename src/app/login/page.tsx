"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

type Screen = "pick" | "login-profesional" | "login-paciente" | "signup" | "new-org";
type OrgOpt = { id: string; name: string; role?: string };

const FIELD =
  "w-full rounded-md border border-hairline bg-surface px-3.5 py-2.5 text-[16px] text-ink placeholder:text-muted/70 transition-colors focus:border-ink focus:outline-none";
const PRIMARY =
  "w-full rounded-md bg-ink px-4 py-2.5 text-[16px] font-semibold text-white transition-colors hover:bg-ink-hover disabled:opacity-40";
const CARD = "rounded-xl border border-hairline bg-surface p-5 shadow-card";

export default function LoginPage() {
  const router = useRouter();
  const [screen, setScreen] = useState<Screen>("pick");
  const [staff, setStaff] = useState<{ name: string; orgs: string[] }[]>([]);
  const [orgs, setOrgs] = useState<OrgOpt[]>([]);

  useEffect(() => {
    fetch("/api/auth/users").then((r) => r.json()).then((d) => setStaff(d.staff ?? [])).catch(() => {});
    fetch("/api/organizations").then((r) => r.json()).then((d) => setOrgs(d.organizations ?? [])).catch(() => {});
  }, []);

  const go = () => {
    router.replace("/");
    router.refresh();
  };

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-[440px] flex-col justify-center gap-6 px-6 py-10">
      <header className="space-y-1.5">
        <h1 className="text-[18px] font-semibold tracking-tight text-ink">CLAVDIA Secretario médico</h1>
        <p className="text-[14px] text-muted">Plataforma multi-consultorio.</p>
      </header>

      {screen === "pick" && (
        <div className="space-y-3">
          <Choice title="Soy paciente" subtitle="Ver mis turnos, sacar turno, pedir mi receta"
            onClick={() => setScreen("login-paciente")} />
          <Choice title="Soy profesional" subtitle="Médico/a de cualquier especialidad, psicólogo/a o recepción"
            onClick={() => setScreen("login-profesional")} />
          <button
            onClick={() => setScreen("new-org")}
            className="pt-1 text-[13px] font-medium text-muted underline decoration-hairline-strong underline-offset-4 hover:text-ink"
          >
            Registrar un consultorio nuevo
          </button>
        </div>
      )}

      {screen === "login-profesional" && (
        <Framed onBack={() => setScreen("pick")}>
          <ProfesionalLogin hints={staff.filter((s) => s.orgs.length).map((s) => s.name)} onDone={go} />
        </Framed>
      )}

      {screen === "login-paciente" && (
        <Framed onBack={() => setScreen("pick")}>
          <PacienteLogin onDone={go} onSignup={() => setScreen("signup")} />
        </Framed>
      )}

      {screen === "signup" && (
        <Framed onBack={() => setScreen("login-paciente")}>
          <PacienteSignup orgs={orgs} onDone={go} />
        </Framed>
      )}

      {screen === "new-org" && (
        <Framed onBack={() => setScreen("pick")}>
          <NewOrg onDone={go} />
        </Framed>
      )}
    </main>
  );
}

function Choice({ title, subtitle, onClick }: { title: string; subtitle: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className={`${CARD} w-full text-left transition-all hover:border-ink`}>
      <span className="block text-[16px] font-semibold text-ink">{title}</span>
      <span className="mt-0.5 block text-[13px] text-muted">{subtitle}</span>
    </button>
  );
}

function Framed({ children, onBack }: { children: React.ReactNode; onBack: () => void }) {
  return (
    <div className="space-y-4">
      <button onClick={onBack} className="text-[13px] font-medium text-muted hover:text-ink">
        ← volver
      </button>
      <div className={CARD}>{children}</div>
    </div>
  );
}

function Err({ msg }: { msg: string }) {
  return msg ? <p className="text-[13px] text-[#c0392b]">{msg}</p> : null;
}

function ProfesionalLogin({ hints, onDone }: { hints: string[]; onDone: () => void }) {
  const [name, setName] = useState("");
  const [pin, setPin] = useState("");
  const [pending, setPending] = useState<OrgOpt[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(organizationId?: string) {
    setBusy(true);
    setError("");
    try {
      const r = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "profesional", name, pin, organizationId }),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) {
        setError(d.error ?? "No se pudo iniciar sesión.");
        setPin("");
        return;
      }
      if (d.needsOrg) {
        setPending(d.organizations);
        return;
      }
      onDone();
    } finally {
      setBusy(false);
    }
  }

  if (pending) {
    return (
      <div className="space-y-3">
        <p className="text-[14px] font-semibold text-ink">¿En qué consultorio entrás?</p>
        {pending.map((o) => (
          <button key={o.id} onClick={() => submit(o.id)} disabled={busy}
            className="w-full rounded-md border border-hairline px-3.5 py-2.5 text-left text-[15px] hover:border-ink">
            {o.name} <span className="text-[12px] text-muted">· {o.role}</span>
          </button>
        ))}
        <Err msg={error} />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <label className="block text-[13px] font-semibold text-ink">Nombre</label>
      <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Tu nombre" className={FIELD} />
      {hints.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {hints.map((h) => (
            <button key={h} onClick={() => setName(h)}
              className="rounded-full border border-hairline px-2.5 py-1 text-[12px] text-muted hover:border-ink hover:text-ink">
              {h}
            </button>
          ))}
        </div>
      )}
      <label className="block text-[13px] font-semibold text-ink">PIN</label>
      <input value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
        onKeyDown={(e) => e.key === "Enter" && submit()} inputMode="numeric" placeholder="4 dígitos"
        className={`${FIELD} text-center text-[20px] tracking-[0.4em]`} />
      <button onClick={() => submit()} disabled={busy || !name.trim() || pin.length < 4} className={PRIMARY}>
        Entrar
      </button>
      <Err msg={error} />
    </div>
  );
}

function PacienteLogin({ onDone, onSignup }: { onDone: () => void; onSignup: () => void }) {
  const [name, setName] = useState("");
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setError("");
    try {
      const r = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "paciente", name, pin }),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) {
        setError(d.error ?? "No se pudo iniciar sesión.");
        setPin("");
        return;
      }
      onDone();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Tu nombre y apellido" className={FIELD} />
      <input value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
        onKeyDown={(e) => e.key === "Enter" && submit()} inputMode="numeric" placeholder="PIN de 4 dígitos"
        className={`${FIELD} text-center text-[20px] tracking-[0.4em]`} />
      <button onClick={submit} disabled={busy || !name.trim() || pin.length < 4} className={PRIMARY}>
        Entrar
      </button>
      <Err msg={error} />
      <button onClick={onSignup} className="text-[13px] font-medium text-muted underline decoration-hairline-strong underline-offset-4 hover:text-ink">
        ¿Sos nuevo/a? Registrate
      </button>
    </div>
  );
}

function PacienteSignup({ orgs, onDone }: { orgs: OrgOpt[]; onDone: () => void }) {
  const [f, setF] = useState({
    fullName: "", dni: "", dateOfBirth: "", coverage: "", phone: "", email: "", pin: "",
    organizationId: orgs[0]?.id ?? "",
  });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setF({ ...f, [k]: e.target.value });

  useEffect(() => {
    if (!f.organizationId && orgs[0]) setF((s) => ({ ...s, organizationId: orgs[0].id }));
  }, [orgs, f.organizationId]);

  async function submit() {
    setBusy(true);
    setError("");
    try {
      const r = await fetch("/api/patients", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...f, pin: f.pin.replace(/\D/g, "").slice(0, 4) }),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) return setError(d.error ?? "No se pudo registrar.");
      onDone();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2.5">
      <p className="text-[13px] text-muted">Alta de paciente. Elegí en qué consultorio te querés atender (después podés sumarte a más).</p>
      <input value={f.fullName} onChange={set("fullName")} placeholder="Nombre y apellido" className={FIELD} />
      <input value={f.dni} onChange={set("dni")} placeholder="DNI" className={FIELD} />
      <input value={f.dateOfBirth} onChange={set("dateOfBirth")} placeholder="Fecha de nacimiento (AAAA-MM-DD)" className={FIELD} />
      <input value={f.coverage} onChange={set("coverage")} placeholder="Cobertura (obra social / prepaga)" className={FIELD} />
      <select value={f.organizationId} onChange={set("organizationId")} className={FIELD}>
        {orgs.map((o) => (
          <option key={o.id} value={o.id}>{o.name}</option>
        ))}
      </select>
      <input value={f.phone} onChange={set("phone")} placeholder="Teléfono (opcional)" className={FIELD} />
      <input value={f.email} onChange={set("email")} placeholder="Email (opcional)" className={FIELD} />
      <input value={f.pin} onChange={set("pin")} inputMode="numeric" placeholder="Elegí un PIN de 4 dígitos"
        className={`${FIELD} text-center tracking-[0.4em]`} />
      <button onClick={submit} disabled={busy} className={PRIMARY}>Crear cuenta y entrar</button>
      <Err msg={error} />
    </div>
  );
}

function NewOrg({ onDone }: { onDone: () => void }) {
  const [f, setF] = useState({ orgName: "", address: "", receptionName: "", pin: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });

  async function submit() {
    setBusy(true);
    setError("");
    try {
      const r = await fetch("/api/organizations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...f, pin: f.pin.replace(/\D/g, "").slice(0, 4) }),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) return setError(d.error ?? "No se pudo crear.");
      onDone();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2.5">
      <p className="text-[13px] text-muted">
        Crea la organización y tu usuario de <strong>recepción</strong>. Después, desde el chat, das de alta a los profesionales.
      </p>
      <input autoFocus value={f.orgName} onChange={set("orgName")} placeholder="Nombre del consultorio" className={FIELD} />
      <input value={f.address} onChange={set("address")} placeholder="Dirección (opcional)" className={FIELD} />
      <input value={f.receptionName} onChange={set("receptionName")} placeholder="Tu nombre (recepción)" className={FIELD} />
      <input value={f.pin} onChange={set("pin")} inputMode="numeric" placeholder="PIN de 4 dígitos"
        className={`${FIELD} text-center tracking-[0.4em]`} />
      <button onClick={submit} disabled={busy} className={PRIMARY}>Crear consultorio y entrar</button>
      <Err msg={error} />
    </div>
  );
}
