import type { Database } from "better-sqlite3";
import { hashPin } from "@/lib/auth/pin";

/** PINs are printed in the README so reviewers can log in. */
const SEED_USERS = [
  { id: "u_ruiz", name: "Dra. Elena Ruiz", role: "medico", providerId: "prov_ruiz", pin: "2468" },
  { id: "u_sosa", name: "Dr. Martín Sosa", role: "medico", providerId: "prov_sosa", pin: "1357" },
  { id: "u_recepcion", name: "Recepción (Sofía)", role: "recepcion", pin: "1234" },
  { id: "u_gomez", name: "María Gómez", role: "paciente", patientId: "pat_gomez", pin: "1111" },
  { id: "u_fernandez", name: "Jorge Fernández", role: "paciente", patientId: "pat_fernandez", pin: "2222" },
] as const;

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function seedSlots(): { id: string; providerId: string; start: string }[] {
  const out: { id: string; providerId: string; start: string }[] = [];
  const base = new Date("2026-09-09T00:00:00");
  for (const providerId of ["prov_ruiz", "prov_sosa"]) {
    let added = 0;
    let offset = 1;
    while (added < 6) {
      const day = new Date(base);
      day.setDate(base.getDate() + offset++);
      if (day.getDay() === 0 || day.getDay() === 6) continue;
      added++;
      const d = `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
      for (let h = 9; h < 12; h++) {
        for (const m of [0, 30]) {
          out.push({ id: `slot_${providerId}_${d}_${pad(h)}${pad(m)}`, providerId, start: `${d}T${pad(h)}:${pad(m)}:00` });
        }
      }
    }
  }
  return out;
}

export function seedIfEmpty(db: Database): void {
  const count = db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number };
  if (count.n > 0) return;

  const tx = db.transaction(() => {
    const provider = db.prepare(
      "INSERT INTO providers (id, name, specialty, room_label) VALUES (?, ?, ?, ?)",
    );
    provider.run("prov_ruiz", "Dra. Elena Ruiz", "Clínica Médica", "Consultorio 2");
    provider.run("prov_sosa", "Dr. Martín Sosa", "Cardiología", "Consultorio 5");

    const patient = db.prepare(`
      INSERT INTO patients (id, full_name, dni, date_of_birth, phone, email, coverage, allergies, active_conditions, notes)
      VALUES (@id, @full_name, @dni, @date_of_birth, @phone, @email, @coverage, @allergies, @active_conditions, @notes)
    `);
    patient.run({
      id: "pat_gomez",
      full_name: "María Gómez",
      dni: "28.444.123",
      date_of_birth: "1981-03-12",
      phone: "+54 9 11 5555-1010",
      email: "maria.gomez@example.com",
      coverage: "OSDE 210",
      allergies: JSON.stringify(["Penicilina"]),
      active_conditions: JSON.stringify(["Hipertensión arterial", "Hipotiroidismo"]),
      notes: "Prefiere turnos por la mañana. Controla presión en casa.",
    });
    patient.run({
      id: "pat_fernandez",
      full_name: "Jorge Fernández",
      dni: "20.999.888",
      date_of_birth: "1959-11-30",
      phone: "+54 9 11 5555-2020",
      email: "jorge.fernandez@example.com",
      coverage: "PAMI",
      allergies: JSON.stringify([]),
      active_conditions: JSON.stringify(["Fibrilación auricular", "Diabetes tipo 2"]),
      notes: "Anticoagulado: cualquier cambio de medicación lo define el Dr. Sosa.",
    });
    patient.run({
      id: "pat_ortiz",
      full_name: "Lucía Ortiz",
      dni: "39.222.777",
      date_of_birth: "1997-07-08",
      phone: "+54 9 11 5555-3030",
      email: "lucia.ortiz@example.com",
      coverage: "Swiss Medical SMG20",
      allergies: JSON.stringify(["Ibuprofeno"]),
      active_conditions: JSON.stringify([]),
      notes: "Consulta habitual por controles anuales.",
    });
    patient.run({
      id: "pat_gomez_2",
      full_name: "Mario Gómez",
      dni: "33.111.456",
      date_of_birth: "1988-01-22",
      phone: "+54 9 11 5555-4040",
      email: "mario.gomez@example.com",
      coverage: "OSDE 310",
      allergies: JSON.stringify([]),
      active_conditions: JSON.stringify(["Asma leve"]),
      notes: "Homónimo parcial de María Gómez — confirmar identidad por DNI.",
    });

    const med = db.prepare(
      "INSERT INTO medications (id, patient_id, name, dose, last_prescribed, chronic) VALUES (?, ?, ?, ?, ?, ?)",
    );
    med.run("med_1", "pat_gomez", "Enalapril", "10 mg / día", "2026-06-10", 1);
    med.run("med_2", "pat_gomez", "Levotiroxina", "75 mcg / día", "2026-05-02", 1);
    med.run("med_3", "pat_fernandez", "Apixabán", "5 mg c/12 h", "2026-08-20", 1);
    med.run("med_4", "pat_fernandez", "Metformina", "850 mg c/12 h", "2026-07-15", 1);
    med.run("med_5", "pat_gomez_2", "Salbutamol", "según necesidad", "2026-04-01", 0);

    const slot = db.prepare(
      "INSERT INTO slots (id, provider_id, start, duration_minutes, taken) VALUES (?, ?, ?, 30, 0)",
    );
    for (const s of seedSlots()) slot.run(s.id, s.providerId, s.start);

    const appt = db.prepare(`
      INSERT INTO appointments (id, patient_id, provider_id, start, duration_minutes, reason, status, created_via)
      VALUES (?, ?, ?, ?, 30, ?, 'scheduled', 'front-desk')
    `);
    appt.run("apt_1001", "pat_gomez", "prov_ruiz", "2026-09-11T09:30:00", "Control de presión arterial");
    appt.run("apt_1002", "pat_fernandez", "prov_sosa", "2026-09-10T10:00:00", "Control de anticoagulación");

    const inv = db.prepare(
      "INSERT INTO invoices (id, patient_id, date, concept, amount, status) VALUES (?, ?, ?, ?, ?, ?)",
    );
    inv.run("inv_5001", "pat_gomez", "2026-08-15", "Consulta clínica", 18000, "paid");
    inv.run("inv_5002", "pat_fernandez", "2026-08-28", "Consulta cardiología + ECG", 42000, "unpaid");
    inv.run("inv_5003", "pat_ortiz", "2026-07-30", "Chequeo anual", 25000, "paid");
    inv.run("inv_5004", "pat_ortiz", "2026-08-30", "Resonancia magnética de rodilla", 180000, "paid");

    const lab = db.prepare(
      "INSERT INTO lab_results (id, patient_id, date, panel, status, summary) VALUES (?, ?, ?, ?, ?, ?)",
    );
    lab.run("lab_7001", "pat_fernandez", "2026-09-05", "RIN / coagulograma", "pending-review", "RIN 3.8 (rango objetivo 2.0–3.0).");
    lab.run("lab_7002", "pat_gomez", "2026-08-14", "Perfil tiroideo", "reviewed", "TSH 2.1 — dentro de rango.");

    const user = db.prepare(`
      INSERT INTO users (id, name, role, pin_hash, pin_salt, patient_id, provider_id)
      VALUES (@id, @name, @role, @pin_hash, @pin_salt, @patient_id, @provider_id)
    `);
    for (const u of SEED_USERS) {
      const { hash, salt } = hashPin(u.pin);
      user.run({
        id: u.id,
        name: u.name,
        role: u.role,
        pin_hash: hash,
        pin_salt: salt,
        patient_id: "patientId" in u ? u.patientId : null,
        provider_id: "providerId" in u ? u.providerId : null,
      });
    }
  });

  tx();
}
