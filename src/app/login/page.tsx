"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { SPECIALTIES } from "@/lib/domain/specialties";

type Screen = "login" | "signup" | "new-org" | "reset";
type OrgOpt = { id: string; name: string; address?: string; city?: string };
type FounderRole = "recepcion" | "medico";
const OTHER_SPECIALTY = "__other__";

const FIELD =
  "w-full rounded-md border border-hairline bg-surface px-3.5 py-2.5 text-[16px] text-ink placeholder:text-muted/70 transition-colors focus:border-ink focus:outline-none";
const PRIMARY =
  "w-full rounded-md bg-ink px-4 py-2.5 text-[16px] font-semibold text-white transition-colors hover:bg-ink-hover disabled:opacity-40";
const GHOST =
  "w-full rounded-md border border-hairline px-4 py-2.5 text-[15px] font-semibold text-ink transition-colors hover:border-ink disabled:opacity-40";
const CARD = "rounded-xl border border-hairline bg-surface p-5 shadow-card";
const LINK =
  "text-[13px] font-medium text-muted underline decoration-hairline-strong underline-offset-4 hover:text-ink";

export default function LoginPage() {
  const router = useRouter();
  const [screen, setScreen] = useState<Screen>("login");
  const [orgs, setOrgs] = useState<OrgOpt[]>([]);

  useEffect(() => {
    fetch("/api/organizations")
      .then((r) => r.json())
      .then((d) => setOrgs(d.organizations ?? []))
      .catch(() => {});
  }, []);

  const go = () => {
    router.replace("/");
    router.refresh();
  };

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-[460px] flex-col justify-center gap-6 px-6 py-10">
      <header className="space-y-1.5">
        <h1 className="text-[18px] font-semibold tracking-tight text-ink">CLAVDIA · Secretario médico</h1>
        <p className="text-[14px] text-muted">Plataforma multi-consultorio.</p>
      </header>

      {screen === "login" && (
        <div className="space-y-4">
          <div className={CARD}>
            <EmailLogin onDone={go} />
          </div>
          <div className="flex flex-col items-start gap-2">
            <button onClick={() => setScreen("reset")} className={LINK}>
              Olvidé mi PIN
            </button>
            <button onClick={() => setScreen("new-org")} className={LINK}>
              Registrar un consultorio nuevo
            </button>
            <button onClick={() => setScreen("signup")} className={LINK}>
              Soy paciente y no tengo cuenta
            </button>
          </div>
        </div>
      )}

      {screen === "signup" && (
        <Framed onBack={() => setScreen("login")}>
          <PacienteSignup orgs={orgs} onDone={go} />
        </Framed>
      )}

      {screen === "reset" && (
        <Framed onBack={() => setScreen("login")}>
          <PinReset onDone={go} />
        </Framed>
      )}

      {screen === "new-org" && (
        <Framed onBack={() => setScreen("login")}>
          <NewOrgWizard onDone={go} />
        </Framed>
      )}
    </main>
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

// ---------------------------------------------------------------------------
// Login — email + PIN, with the multi-org picker
// ---------------------------------------------------------------------------

function EmailLogin({ onDone }: { onDone: () => void }) {
  const [ident, setIdent] = useState("");
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
        body: JSON.stringify({ identifier: ident.trim(), pin, organizationId }),
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
          <button
            key={o.id}
            onClick={() => submit(o.id)}
            disabled={busy}
            className="w-full rounded-md border border-hairline px-3.5 py-2.5 text-left text-[15px] transition-colors hover:border-ink"
          >
            {o.name}
          </button>
        ))}
        <Err msg={error} />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <label className="block text-[13px] font-semibold text-ink">Email o DNI</label>
      <input
        autoFocus
        value={ident}
        onChange={(e) => setIdent(e.target.value)}
        placeholder="tu@email.com o tu DNI"
        className={FIELD}
      />
      <label className="block text-[13px] font-semibold text-ink">PIN</label>
      <input
        value={pin}
        onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
        onKeyDown={(e) => e.key === "Enter" && submit()}
        inputMode="numeric"
        placeholder="4 dígitos"
        className={`${FIELD} text-center text-[20px] tracking-[0.4em]`}
      />
      <button onClick={() => submit()} disabled={busy || !ident.trim() || pin.length < 4} className={PRIMARY}>
        Entrar
      </button>
      <Err msg={error} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// PIN recovery — one-time code by email / WhatsApp, then a new PIN
// ---------------------------------------------------------------------------

function PinReset({ onDone }: { onDone: () => void }) {
  const [phase, setPhase] = useState<"request" | "confirm">("request");
  const [ident, setIdent] = useState("");
  const [code, setCode] = useState("");
  const [newPin, setNewPin] = useState("");
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const identBody = () => (ident.includes("@") ? { email: ident.trim() } : { dni: ident.trim() });

  async function request() {
    setBusy(true);
    setError("");
    setMsg("");
    try {
      const r = await fetch("/api/auth/pin-reset/request", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(identBody()),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) return setError(d.error ?? "No se pudo enviar el código.");
      setMsg(d.message ?? "Si los datos son correctos, te enviamos un código.");
      setPhase("confirm");
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    setBusy(true);
    setError("");
    try {
      const r = await fetch("/api/auth/pin-reset/confirm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...identBody(), code: code.trim(), newPin }),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) return setError(d.error ?? "No se pudo restablecer el PIN.");
      if (d.staff) {
        setPhase("request");
        setCode("");
        setNewPin("");
        setMsg(d.message ?? "PIN actualizado. Iniciá sesión.");
        return;
      }
      onDone();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-[14px] font-semibold text-ink">Recuperar el PIN</p>
      {phase === "request" ? (
        <>
          <p className="text-[13px] text-muted">
            Ingresá tu email o DNI. Te mandamos un código de un solo uso al email (o WhatsApp) que
            figura en tu ficha.
          </p>
          <input
            autoFocus
            value={ident}
            onChange={(e) => setIdent(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && ident.trim() && request()}
            placeholder="Email o DNI"
            className={FIELD}
          />
          <button onClick={request} disabled={busy || !ident.trim()} className={PRIMARY}>
            Enviar código
          </button>
        </>
      ) : (
        <>
          {msg && <p className="text-[13px] text-muted">{msg}</p>}
          <input
            autoFocus
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
            inputMode="numeric"
            placeholder="Código de 6 dígitos"
            className={`${FIELD} text-center text-[18px] tracking-[0.3em]`}
          />
          <input
            value={newPin}
            onChange={(e) => setNewPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
            inputMode="numeric"
            placeholder="PIN nuevo (4 dígitos)"
            className={`${FIELD} text-center text-[18px] tracking-[0.4em]`}
          />
          <button
            onClick={confirm}
            disabled={busy || code.length !== 6 || newPin.length !== 4}
            className={PRIMARY}
          >
            Cambiar PIN y entrar
          </button>
          <button onClick={() => setPhase("request")} className={LINK}>
            Pedir otro código
          </button>
        </>
      )}
      <Err msg={error} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Patient self-signup
// ---------------------------------------------------------------------------

function PacienteSignup({ orgs, onDone }: { orgs: OrgOpt[]; onDone: () => void }) {
  const [f, setF] = useState({
    fullName: "",
    dni: "",
    dateOfBirth: "",
    coverage: "",
    email: "",
    phone: "",
    pin: "",
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
      <p className="text-[13px] text-muted">
        Alta de paciente. El <strong>email</strong> te sirve para entrar y, junto con el{" "}
        <strong>teléfono</strong>, para recuperar el PIN. Si el consultorio ya te cargó, tienen que
        coincidir con los de tu ficha. Elegí un consultorio (después podés sumarte a más).
      </p>
      <input value={f.fullName} onChange={set("fullName")} placeholder="Nombre y apellido" className={FIELD} />
      <input value={f.dni} onChange={set("dni")} placeholder="DNI" className={FIELD} />
      <input value={f.dateOfBirth} onChange={set("dateOfBirth")} placeholder="Fecha de nacimiento (AAAA-MM-DD)" className={FIELD} />
      <input value={f.coverage} onChange={set("coverage")} placeholder="Cobertura (obra social / prepaga)" className={FIELD} />
      <input type="email" value={f.email} onChange={set("email")} placeholder="Email (para ingresar)" className={FIELD} />
      <input value={f.phone} onChange={set("phone")} placeholder="Teléfono" className={FIELD} />
      <select value={f.organizationId} onChange={set("organizationId")} className={FIELD}>
        {orgs.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
      <input
        value={f.pin}
        onChange={set("pin")}
        inputMode="numeric"
        placeholder="Elegí un PIN de 4 dígitos"
        className={`${FIELD} text-center tracking-[0.4em]`}
      />
      <button
        onClick={submit}
        disabled={
          busy ||
          !f.fullName.trim() ||
          !f.dni.trim() ||
          !f.dateOfBirth.trim() ||
          !f.coverage.trim() ||
          !f.email.trim() ||
          !f.phone.trim() ||
          f.pin.replace(/\D/g, "").length !== 4
        }
        className={PRIMARY}
      >
        Crear cuenta y entrar
      </button>
      <Err msg={error} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// New organization — 3-step wizard
// ---------------------------------------------------------------------------

const STEPS = ["El consultorio", "Tu cuenta", "Confirmar"] as const;

function NewOrgWizard({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [f, setF] = useState({
    orgName: "",
    address: "",
    city: "",
    phone: "",
    hours: "Lunes a viernes de 8 a 18 h",
    founderName: "",
    founderEmail: "",
    founderDni: "",
    founderPhone: "",
    pin: "",
    founderRole: "recepcion" as FounderRole,
    specialty: "",
    specialtyOther: "",
    roomLabel: "",
  });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setF({ ...f, [k]: e.target.value });

  const specialty = f.specialty === OTHER_SPECIALTY ? f.specialtyOther.trim() : f.specialty;
  const step1ok = f.orgName.trim().length > 1;
  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.founderEmail.trim());
  const step2ok =
    f.founderName.trim().length > 1 &&
    emailOk &&
    f.founderDni.replace(/\D/g, "").length >= 7 &&
    f.founderPhone.replace(/\D/g, "").length >= 8 &&
    /^\d{4}$/.test(f.pin) &&
    (f.founderRole === "recepcion" || specialty.length > 1);

  async function submit() {
    setBusy(true);
    setError("");
    try {
      const r = await fetch("/api/organizations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...f,
          pin: f.pin.replace(/\D/g, "").slice(0, 4),
          specialty: f.founderRole === "medico" ? specialty : undefined,
        }),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) {
        setError(d.error ?? "No se pudo crear.");
        return;
      }
      onDone();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-1.5">
        {STEPS.map((label, i) => (
          <div key={label} className="flex flex-1 flex-col gap-1">
            <div className={`h-1 rounded-full ${i <= step ? "bg-ink" : "bg-hairline"}`} aria-hidden />
            <span className={`text-[11px] ${i === step ? "font-semibold text-ink" : "text-muted"}`}>
              {i + 1}. {label}
            </span>
          </div>
        ))}
      </div>

      {step === 0 && (
        <div className="space-y-2.5">
          <p className="text-[13px] text-muted">Dónde queda y cómo se llama.</p>
          <input autoFocus value={f.orgName} onChange={set("orgName")} placeholder="Nombre del consultorio" className={FIELD} />
          <input value={f.address} onChange={set("address")} placeholder="Dirección (calle y número)" className={FIELD} />
          <input value={f.city} onChange={set("city")} placeholder="Localidad / ciudad" className={FIELD} />
          <input value={f.phone} onChange={set("phone")} placeholder="Teléfono de contacto" className={FIELD} />
          <input value={f.hours} onChange={set("hours")} placeholder="Días y horarios de atención" className={FIELD} />
          <button onClick={() => setStep(1)} disabled={!step1ok} className={PRIMARY}>
            Continuar
          </button>
        </div>
      )}

      {step === 1 && (
        <div className="space-y-2.5">
          <p className="text-[13px] text-muted">Tu usuario para administrar el consultorio.</p>
          <input autoFocus value={f.founderName} onChange={set("founderName")} placeholder="Tu nombre completo" className={FIELD} />
          <input value={f.founderDni} onChange={set("founderDni")} placeholder="Tu DNI" className={FIELD} />
          <input type="email" value={f.founderEmail} onChange={set("founderEmail")} placeholder="Email (para ingresar)" className={FIELD} />
          <input value={f.founderPhone} onChange={set("founderPhone")} placeholder="Teléfono" className={FIELD} />
          <input
            value={f.pin}
            onChange={(e) => setF({ ...f, pin: e.target.value.replace(/\D/g, "").slice(0, 4) })}
            inputMode="numeric"
            placeholder="Elegí un PIN de 4 dígitos"
            className={`${FIELD} text-center tracking-[0.4em]`}
          />

          <p className="pt-1 text-[13px] font-semibold text-ink">¿Cómo vas a usar la plataforma?</p>
          <div className="grid grid-cols-1 gap-2">
            <RoleOption
              active={f.founderRole === "recepcion"}
              title="Secretaría administrativa"
              desc="Gestiono la agenda, doy de alta pacientes y profesionales."
              onClick={() => setF({ ...f, founderRole: "recepcion" })}
            />
            <RoleOption
              active={f.founderRole === "medico"}
              title="Profesional de la salud"
              desc="Atiendo pacientes. Como fundador/a, también podés dar de alta a otros."
              onClick={() => setF({ ...f, founderRole: "medico" })}
            />
          </div>

          {f.founderRole === "medico" && (
            <>
              <select value={f.specialty} onChange={set("specialty")} className={FIELD}>
                <option value="">Tipo de profesional…</option>
                {SPECIALTIES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
                <option value={OTHER_SPECIALTY}>Otra…</option>
              </select>
              {f.specialty === OTHER_SPECIALTY && (
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

          <div className="flex gap-2">
            <button onClick={() => setStep(0)} className={GHOST}>
              Atrás
            </button>
            <button onClick={() => setStep(2)} disabled={!step2ok} className={PRIMARY}>
              Continuar
            </button>
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="space-y-3">
          <p className="text-[13px] text-muted">Revisá antes de crear.</p>
          <dl className="space-y-1.5 rounded-md border border-hairline bg-canvas p-3.5 text-[13px]">
            <Review label="Consultorio" value={f.orgName} />
            <Review label="Dirección" value={[f.address, f.city].filter(Boolean).join(", ")} />
            <Review label="Teléfono" value={f.phone} />
            <Review label="Horarios" value={f.hours} />
            <Review label="Tu nombre" value={f.founderName} />
            <Review label="Email" value={f.founderEmail} />
            <Review
              label="Rol"
              value={
                f.founderRole === "recepcion"
                  ? "Secretaría administrativa"
                  : `Profesional · ${specialty}${f.roomLabel ? ` · ${f.roomLabel}` : ""}`
              }
            />
          </dl>
          <p className="text-[12px] text-muted">
            Después vas a poder dar de alta profesionales y pacientes desde la vista Sistema o el chat.
          </p>
          <div className="flex gap-2">
            <button onClick={() => setStep(1)} className={GHOST}>
              Atrás
            </button>
            <button onClick={submit} disabled={busy} className={PRIMARY}>
              Crear consultorio y entrar
            </button>
          </div>
          <Err msg={error} />
        </div>
      )}
    </div>
  );
}

function RoleOption({
  active,
  title,
  desc,
  onClick,
}: {
  active: boolean;
  title: string;
  desc: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-md border px-3.5 py-2.5 text-left transition-colors ${
        active ? "border-ink bg-ink text-white" : "border-hairline text-ink hover:border-ink"
      }`}
    >
      <span className="block text-[14px] font-semibold">{title}</span>
      <span className={`mt-0.5 block text-[12px] ${active ? "text-white/80" : "text-muted"}`}>{desc}</span>
    </button>
  );
}

function Review({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <dt className="w-24 shrink-0 text-muted">{label}</dt>
      <dd className="min-w-0 flex-1 text-ink">{value || "—"}</dd>
    </div>
  );
}
