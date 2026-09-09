"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

type Kind = "paciente" | "profesional";
type PickUser = { id: string; name: string; role: "medico" | "recepcion" | "paciente" };

const FIELD =
  "w-full rounded-md border border-hairline bg-surface px-3.5 py-2.5 text-[16px] text-ink placeholder:text-muted/70 transition-colors focus:border-ink focus:outline-none";
const PRIMARY_BTN =
  "w-full rounded-md bg-ink px-4 py-2.5 text-[16px] font-semibold text-white transition-colors hover:bg-ink-hover disabled:opacity-40";

export default function LoginPage() {
  const router = useRouter();
  const [kind, setKind] = useState<Kind | null>(null);
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [users, setUsers] = useState<PickUser[]>([]);

  useEffect(() => {
    fetch("/api/auth/users")
      .then((r) => r.json())
      .then((d) => setUsers(d.users ?? []))
      .catch(() => undefined);
  }, []);

  const hints =
    kind === "profesional"
      ? users.filter((u) => u.role !== "paciente").map((u) => u.name)
      : [];

  function goHome() {
    router.replace("/");
    router.refresh();
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-[420px] flex-col justify-center gap-7 px-6 py-10">
      <header className="space-y-1.5">
        <h1 className="text-[18px] font-semibold tracking-tight text-ink">Secretario médico</h1>
        <p className="text-[14px] text-muted">Ingresá para hablar con el agente.</p>
      </header>

      {!kind ? (
        <div className="space-y-3">
          <ProfileButton
            title="Soy paciente"
            subtitle="Ver mis turnos, sacar turno, pedir mi receta"
            onClick={() => {
              setKind("paciente");
              setMode("login");
            }}
          />
          <ProfileButton
            title="Soy profesional"
            subtitle="Médico/a o recepción"
            onClick={() => {
              setKind("profesional");
              setMode("login");
            }}
          />
        </div>
      ) : (
        <div className="space-y-5">
          <button
            onClick={() => setKind(null)}
            className="text-[13px] font-medium text-muted transition-colors hover:text-ink"
          >
            ← cambiar
          </button>

          <div className="rounded-xl border border-hairline bg-surface p-5 shadow-card">
            {mode === "login" ? (
              <LoginForm kind={kind} hints={hints} onDone={goHome} />
            ) : (
              <SignupForm onDone={goHome} />
            )}
          </div>

          {kind === "paciente" && (
            <button
              onClick={() => setMode(mode === "login" ? "signup" : "login")}
              className="text-[13px] font-medium text-muted underline decoration-hairline-strong underline-offset-4 transition-colors hover:text-ink"
            >
              {mode === "login" ? "¿Sos nuevo/a? Registrate" : "Ya tengo usuario, iniciar sesión"}
            </button>
          )}
        </div>
      )}
    </main>
  );
}

function ProfileButton({
  title,
  subtitle,
  onClick,
}: {
  title: string;
  subtitle: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="group w-full rounded-xl border border-hairline bg-surface px-5 py-4 text-left shadow-card transition-all hover:border-ink"
    >
      <span className="block text-[16px] font-semibold text-ink">{title}</span>
      <span className="mt-0.5 block text-[13px] text-muted">{subtitle}</span>
    </button>
  );
}

function LoginForm({
  kind,
  hints,
  onDone,
}: {
  kind: Kind;
  hints: string[];
  onDone: () => void;
}) {
  const [name, setName] = useState("");
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!name.trim() || pin.length < 4) return;
    setBusy(true);
    setError("");
    try {
      const r = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind, name, pin }),
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
    <div className="space-y-4">
      <div className="space-y-2">
        <label className="block text-[13px] font-semibold text-ink">Nombre</label>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Tu nombre y apellido"
          className={FIELD}
        />
        {hints.length > 0 && (
          <div className="flex flex-wrap gap-1.5 pt-0.5">
            {hints.map((h) => (
              <button
                key={h}
                onClick={() => setName(h)}
                className="rounded-full border border-hairline px-2.5 py-1 text-[12px] text-muted transition-colors hover:border-ink hover:text-ink"
              >
                {h}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="space-y-2">
        <label className="block text-[13px] font-semibold text-ink">PIN</label>
        <input
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          inputMode="numeric"
          placeholder="4 dígitos"
          className={`${FIELD} text-center text-[20px] tracking-[0.4em]`}
        />
      </div>

      <button onClick={submit} disabled={busy || !name.trim() || pin.length < 4} className={PRIMARY_BTN}>
        Entrar
      </button>
      {error && <p className="text-[13px] text-[#c0392b]">{error}</p>}
    </div>
  );
}

function SignupForm({ onDone }: { onDone: () => void }) {
  const [f, setF] = useState({
    fullName: "",
    dni: "",
    dateOfBirth: "",
    coverage: "",
    phone: "",
    email: "",
    pin: "",
  });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setF({ ...f, [k]: e.target.value });

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
      if (!r.ok || !d.ok) {
        setError(d.error ?? "No se pudo registrar.");
        return;
      }
      onDone();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-[13px] text-muted">
        Alta de paciente. Después podés completar el resto con el agente.
      </p>
      <input value={f.fullName} onChange={set("fullName")} placeholder="Nombre y apellido" className={FIELD} />
      <input value={f.dni} onChange={set("dni")} placeholder="DNI" className={FIELD} />
      <input
        value={f.dateOfBirth}
        onChange={set("dateOfBirth")}
        placeholder="Fecha de nacimiento (AAAA-MM-DD)"
        className={FIELD}
      />
      <input
        value={f.coverage}
        onChange={set("coverage")}
        placeholder="Cobertura (obra social / prepaga)"
        className={FIELD}
      />
      <input value={f.phone} onChange={set("phone")} placeholder="Teléfono (opcional)" className={FIELD} />
      <input value={f.email} onChange={set("email")} placeholder="Email (opcional)" className={FIELD} />
      <input
        value={f.pin}
        onChange={set("pin")}
        inputMode="numeric"
        placeholder="Elegí un PIN de 4 dígitos"
        className={`${FIELD} text-center tracking-[0.4em]`}
      />
      <button onClick={submit} disabled={busy} className={PRIMARY_BTN}>
        Crear cuenta y entrar
      </button>
      {error && <p className="text-[13px] text-[#c0392b]">{error}</p>}
    </div>
  );
}
