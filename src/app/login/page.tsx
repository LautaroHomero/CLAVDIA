"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

type Kind = "paciente" | "profesional";
type PickUser = { id: string; name: string; role: "medico" | "recepcion" | "paciente" };

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
      : users.filter((u) => u.role === "paciente").map((u) => u.name);

  function goHome() {
    router.replace("/");
    router.refresh();
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center gap-6 p-6 text-neutral-900">
      <div>
        <h1 className="text-lg font-semibold">Secretario médico</h1>
        <p className="text-xs text-neutral-500">Ingresá para hablar con el agente.</p>
      </div>

      {!kind ? (
        <div className="space-y-2">
          <button
            onClick={() => {
              setKind("paciente");
              setMode("login");
            }}
            className="w-full rounded-lg border border-neutral-200 bg-white px-4 py-3 text-left text-sm hover:border-neutral-400"
          >
            <span className="font-medium">Soy paciente</span>
            <span className="block text-xs text-neutral-500">Ver mis turnos, sacar turno, pedir mi receta</span>
          </button>
          <button
            onClick={() => {
              setKind("profesional");
              setMode("login");
            }}
            className="w-full rounded-lg border border-neutral-200 bg-white px-4 py-3 text-left text-sm hover:border-neutral-400"
          >
            <span className="font-medium">Soy profesional</span>
            <span className="block text-xs text-neutral-500">Médico/a o recepción</span>
          </button>
        </div>
      ) : (
        <div className="space-y-4">
          <button onClick={() => setKind(null)} className="text-xs text-neutral-500 underline">
            ← cambiar
          </button>

          {mode === "login" ? (
            <LoginForm kind={kind} hints={hints} onDone={goHome} />
          ) : (
            <SignupForm onDone={goHome} />
          )}

          {kind === "paciente" && (
            <button
              onClick={() => setMode(mode === "login" ? "signup" : "login")}
              className="text-xs text-neutral-600 underline"
            >
              {mode === "login" ? "¿Sos nuevo/a? Registrate" : "Ya tengo usuario, iniciar sesión"}
            </button>
          )}
        </div>
      )}
    </main>
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
    <div className="space-y-3">
      <label className="block text-xs font-medium text-neutral-500">Nombre</label>
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Tu nombre y apellido"
        className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-neutral-500"
      />
      {hints.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {hints.map((h) => (
            <button
              key={h}
              onClick={() => setName(h)}
              className="rounded-full border border-neutral-200 px-2 py-0.5 text-[11px] text-neutral-500 hover:bg-neutral-100"
            >
              {h}
            </button>
          ))}
        </div>
      )}
      <label className="block text-xs font-medium text-neutral-500">PIN</label>
      <input
        value={pin}
        onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
        onKeyDown={(e) => e.key === "Enter" && submit()}
        inputMode="numeric"
        placeholder="4 dígitos"
        className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-center text-lg tracking-[0.4em] outline-none focus:border-neutral-500"
      />
      <button
        onClick={submit}
        disabled={busy || !name.trim() || pin.length < 4}
        className="w-full rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
      >
        Entrar
      </button>
      {error && <p className="text-xs text-red-600">{error}</p>}
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
    <div className="space-y-2">
      <p className="text-xs text-neutral-500">Alta de paciente. Después podés completar el resto con el agente.</p>
      <input value={f.fullName} onChange={set("fullName")} placeholder="Nombre y apellido"
        className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm" />
      <input value={f.dni} onChange={set("dni")} placeholder="DNI"
        className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm" />
      <input value={f.dateOfBirth} onChange={set("dateOfBirth")} placeholder="Fecha de nacimiento (AAAA-MM-DD)"
        className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm" />
      <input value={f.coverage} onChange={set("coverage")} placeholder="Cobertura (obra social / prepaga)"
        className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm" />
      <input value={f.phone} onChange={set("phone")} placeholder="Teléfono (opcional)"
        className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm" />
      <input value={f.email} onChange={set("email")} placeholder="Email (opcional)"
        className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm" />
      <input value={f.pin} onChange={set("pin")} inputMode="numeric" placeholder="Elegí un PIN de 4 dígitos"
        className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-center tracking-[0.4em]" />
      <button
        onClick={submit}
        disabled={busy}
        className="w-full rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
      >
        Crear cuenta y entrar
      </button>
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}
