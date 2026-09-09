"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

type Role = "medico" | "recepcion" | "paciente";
type PickUser = { id: string; name: string; role: Role };

const ROLE_LABEL: Record<Role, string> = {
  medico: "Médico/a",
  recepcion: "Recepción",
  paciente: "Paciente",
};

export default function LoginPage() {
  const router = useRouter();
  const [users, setUsers] = useState<PickUser[]>([]);
  const [selected, setSelected] = useState<PickUser | null>(null);
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch("/api/auth/users")
      .then((r) => r.json())
      .then((d) => setUsers(d.users ?? []))
      .catch(() => setError("No se pudo cargar la lista de usuarios."));
  }, []);

  async function submit() {
    if (!selected || pin.length < 4) return;
    setBusy(true);
    setError("");
    try {
      const r = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: selected.id, pin }),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) {
        setError(d.error ?? "No se pudo iniciar sesión.");
        setPin("");
        return;
      }
      router.replace("/");
    } finally {
      setBusy(false);
    }
  }

  const grouped = (["medico", "recepcion", "paciente"] as Role[]).map((role) => ({
    role,
    users: users.filter((u) => u.role === role),
  }));

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center gap-6 p-6 text-neutral-900">
      <div>
        <h1 className="text-lg font-semibold">Secretario médico</h1>
        <p className="text-xs text-neutral-500">
          Elegí quién sos e ingresá tu PIN. (Los PIN de demo están en el README.)
        </p>
      </div>

      {!selected ? (
        <div className="space-y-4">
          {grouped.map(
            (g) =>
              g.users.length > 0 && (
                <div key={g.role}>
                  <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
                    {ROLE_LABEL[g.role]}
                  </p>
                  <div className="space-y-1">
                    {g.users.map((u) => (
                      <button
                        key={u.id}
                        onClick={() => {
                          setSelected(u);
                          setPin("");
                          setError("");
                        }}
                        className="w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-left text-sm hover:border-neutral-400"
                      >
                        {u.name}
                      </button>
                    ))}
                  </div>
                </div>
              ),
          )}
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">{selected.name}</p>
              <p className="text-xs text-neutral-500">{ROLE_LABEL[selected.role]}</p>
            </div>
            <button
              onClick={() => setSelected(null)}
              className="text-xs text-neutral-500 underline"
            >
              cambiar
            </button>
          </div>
          <input
            autoFocus
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            inputMode="numeric"
            placeholder="PIN de 4 dígitos"
            className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-center text-lg tracking-[0.5em] outline-none focus:border-neutral-500"
          />
          <button
            onClick={submit}
            disabled={busy || pin.length < 4}
            className="w-full rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
          >
            Entrar
          </button>
        </div>
      )}

      {error && <p className="text-xs text-red-600">{error}</p>}
    </main>
  );
}
