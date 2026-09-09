import type { Database } from "better-sqlite3";
import { hashPin } from "@/lib/auth/pin";
import { generateSlotRows } from "./slots";

/** Health professionals with their own agenda. `title` is baked into `name`. */
const SEED_PROVIDERS = [
  { id: "prov_ruiz", name: "Dra. Elena Ruiz", specialty: "Clínica Médica", roomLabel: "Consultorio 2", defaultFee: 18000 },
  { id: "prov_sosa", name: "Dr. Martín Sosa", specialty: "Cardiología", roomLabel: "Consultorio 5", defaultFee: 30000 },
  { id: "prov_paz", name: "Dra. Sofía Paz", specialty: "Dermatología", roomLabel: "Consultorio 3", defaultFee: 22000 },
  { id: "prov_bianchi", name: "Lic. Paula Bianchi", specialty: "Psicología", roomLabel: "Consultorio 7", defaultFee: 15000 },
  { id: "prov_ferrari", name: "Dr. Nicolás Ferrari", specialty: "Medicina del deporte", roomLabel: "Consultorio 4", defaultFee: 20000 },
] as const;

/** Named practices with their own price. */
const SEED_PRICES = [
  { providerId: "prov_sosa", label: "Consulta + ECG", amount: 42000 },
  { providerId: "prov_sosa", label: "Holter 24 h", amount: 65000 },
  { providerId: "prov_paz", label: "Crioterapia", amount: 30000 },
  { providerId: "prov_paz", label: "Biopsia de piel", amount: 48000 },
  { providerId: "prov_ferrari", label: "Evaluación funcional", amount: 35000 },
] as const;

/** PINs are printed in the README so reviewers can log in. */
const SEED_USERS = [
  { id: "u_ruiz", name: "Dra. Elena Ruiz", role: "medico", providerId: "prov_ruiz", pin: "2468" },
  { id: "u_sosa", name: "Dr. Martín Sosa", role: "medico", providerId: "prov_sosa", pin: "1357" },
  { id: "u_paz", name: "Dra. Sofía Paz", role: "medico", providerId: "prov_paz", pin: "3690" },
  { id: "u_bianchi", name: "Lic. Paula Bianchi", role: "medico", providerId: "prov_bianchi", pin: "1470" },
  { id: "u_ferrari", name: "Dr. Nicolás Ferrari", role: "medico", providerId: "prov_ferrari", pin: "2580" },
  { id: "u_recepcion", name: "Recepción (Sofía)", role: "recepcion", pin: "1234" },
  { id: "u_gomez", name: "María Gómez", role: "paciente", patientId: "pat_gomez", pin: "1111" },
  { id: "u_fernandez", name: "Jorge Fernández", role: "paciente", patientId: "pat_fernandez", pin: "2222" },
] as const;

function seedSlots(): { id: string; providerId: string; start: string }[] {
  return SEED_PROVIDERS.flatMap((p) => generateSlotRows(p.id));
}

export function seedIfEmpty(db: Database): void {
  const count = db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number };
  if (count.n > 0) return;

  const tx = db.transaction(() => {
    const provider = db.prepare(
      "INSERT INTO providers (id, name, specialty, room_label, default_fee) VALUES (?, ?, ?, ?, ?)",
    );
    for (const p of SEED_PROVIDERS) provider.run(p.id, p.name, p.specialty, p.roomLabel, p.defaultFee);

    const price = db.prepare(
      "INSERT INTO provider_prices (id, provider_id, label, amount) VALUES (?, ?, ?, ?)",
    );
    SEED_PRICES.forEach((p, i) => price.run(`price_${i + 1}`, p.providerId, p.label, p.amount));

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
      date_of_birth: "1990-09-09",
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
      INSERT INTO appointments (id, patient_id, provider_id, start, duration_minutes, reason, status, price, created_via)
      VALUES (@id, @patient, @provider, @start, 30, @reason, @status, @price, 'front-desk')
    `);
    const A = (
      id: string,
      patient: string,
      provider: string,
      start: string,
      reason: string,
      status = "scheduled",
      price = 0,
    ) => appt.run({ id, patient, provider, start, reason, status, price });

    // Upcoming (scheduled)
    A("apt_1001", "pat_gomez", "prov_ruiz", "2026-09-11T09:30:00", "Control de presión arterial");
    A("apt_1002", "pat_fernandez", "prov_sosa", "2026-09-10T10:00:00", "Control de anticoagulación");
    A("apt_1003", "pat_ortiz", "prov_ruiz", "2026-09-10T09:30:00", "Chequeo anual");
    A("apt_1004", "pat_gomez_2", "prov_ruiz", "2026-09-10T11:00:00", "Control de asma");

    // Today (2026-09-09) — some already attended (revenue history)…
    A("apt_0901", "pat_ortiz", "prov_ruiz", "2026-09-09T09:00:00", "Consulta clínica", "completed", 18000);
    A("apt_0904", "pat_fernandez", "prov_sosa", "2026-09-09T10:00:00", "Consulta + ECG", "completed", 42000);
    // …and Dra. Ruiz still has a live morning to run (for the agenda demo).
    // Mario cumple años hoy; María y Jorge tienen login y pueden ver la demora.
    A("apt_0910", "pat_gomez_2", "prov_ruiz", "2026-09-09T10:00:00", "Control de asma", "scheduled", 18000);
    A("apt_0911", "pat_gomez", "prov_ruiz", "2026-09-09T10:30:00", "Control de presión arterial", "scheduled", 18000);
    A("apt_0912", "pat_fernandez", "prov_ruiz", "2026-09-09T11:00:00", "Control clínico", "scheduled", 18000);

    db.prepare(
      `UPDATE slots SET taken = 1 WHERE id IN (
        'slot_prov_ruiz_2026-09-11_0930','slot_prov_sosa_2026-09-10_1000',
        'slot_prov_ruiz_2026-09-10_0930','slot_prov_ruiz_2026-09-10_1100',
        'slot_prov_ruiz_2026-09-09_0900','slot_prov_sosa_2026-09-09_1000',
        'slot_prov_ruiz_2026-09-09_1000','slot_prov_ruiz_2026-09-09_1030','slot_prov_ruiz_2026-09-09_1100'
      )`,
    ).run();

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
