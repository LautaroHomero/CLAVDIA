import type { Database } from "better-sqlite3";
import { hashPin } from "@/lib/auth/pin";
import { DEMO_MMDD, DEMO_TOMORROW, demoNextSlot, shiftIso } from "@/lib/domain/clock";
import { generateSlotRows } from "./slots";

/** Seeded organizations. */
const ORGS = [
  { id: "org_belgrano", name: "Consultorio Belgrano", slug: "belgrano", address: "Av. Cabildo 2200, piso 3", city: "CABA", phone: "+54 11 4788-0000" },
  { id: "org_palermo", name: "Centro Médico Palermo", slug: "palermo", address: "Av. Santa Fe 3800", city: "CABA", phone: "+54 11 4823-1111" },
  { id: "org_deporte", name: "Clínica del Deporte", slug: "deporte", address: "Av. Libertador 5000", city: "CABA", phone: "+54 11 4700-2222" },
] as const;

/** Providers, each in one organization. */
const PROVIDERS = [
  { id: "prov_b_ruiz", org: "org_belgrano", name: "Dra. Elena Ruiz", specialty: "Clínica Médica", room: "Consultorio 2", fee: 18000 },
  { id: "prov_b_sosa", org: "org_belgrano", name: "Dr. Martín Sosa", specialty: "Cardiología", room: "Consultorio 5", fee: 30000 },
  { id: "prov_p_ruiz", org: "org_palermo", name: "Dra. Elena Ruiz", specialty: "Clínica Médica", room: "Box 1", fee: 20000 },
  { id: "prov_p_paz", org: "org_palermo", name: "Dra. Sofía Paz", specialty: "Dermatología", room: "Box 4", fee: 22000 },
  { id: "prov_p_bianchi", org: "org_palermo", name: "Lic. Paula Bianchi", specialty: "Psicología", room: "Box 7", fee: 15000 },
  { id: "prov_d_ferrari", org: "org_deporte", name: "Dr. Nicolás Ferrari", specialty: "Medicina del deporte", room: "Sala A", fee: 20000 },
] as const;

const PRICES = [
  { org: "org_belgrano", provider: "prov_b_sosa", label: "Consulta + ECG", amount: 42000 },
  { org: "org_belgrano", provider: "prov_b_sosa", label: "Holter 24 h", amount: 65000 },
  { org: "org_palermo", provider: "prov_p_paz", label: "Crioterapia", amount: 30000 },
  { org: "org_palermo", provider: "prov_p_paz", label: "Biopsia de piel", amount: 48000 },
  { org: "org_deporte", provider: "prov_d_ferrari", label: "Evaluación funcional", amount: 35000 },
] as const;

/**
 * Staff logins + their org memberships. Login is by email; `admin: true` on a
 * membership marks who may onboard professionals (secretaría / founder).
 */
const STAFF = [
  { id: "u_ruiz", name: "Dra. Elena Ruiz", email: "elena.ruiz@clavdia.test", pin: "2468", memberships: [
    { org: "org_belgrano", role: "medico", provider: "prov_b_ruiz", admin: false },
    { org: "org_palermo", role: "medico", provider: "prov_p_ruiz", admin: false }, // trabaja en dos lugares
  ] },
  { id: "u_sosa", name: "Dr. Martín Sosa", email: "martin.sosa@clavdia.test", pin: "1357", memberships: [{ org: "org_belgrano", role: "medico", provider: "prov_b_sosa", admin: false }] },
  { id: "u_paz", name: "Dra. Sofía Paz", email: "sofia.paz@clavdia.test", pin: "3690", memberships: [{ org: "org_palermo", role: "medico", provider: "prov_p_paz", admin: false }] },
  { id: "u_bianchi", name: "Lic. Paula Bianchi", email: "paula.bianchi@clavdia.test", pin: "1470", memberships: [{ org: "org_palermo", role: "medico", provider: "prov_p_bianchi", admin: false }] },
  { id: "u_ferrari", name: "Dr. Nicolás Ferrari", email: "nicolas.ferrari@clavdia.test", pin: "2580", memberships: [{ org: "org_deporte", role: "medico", provider: "prov_d_ferrari", admin: true }] },
  { id: "u_recep_b", name: "Sofía (secretaría · Belgrano)", email: "recepcion.belgrano@clavdia.test", pin: "1234", memberships: [{ org: "org_belgrano", role: "recepcion", provider: null, admin: true }] },
  { id: "u_recep_p", name: "Diego (secretaría · Palermo)", email: "recepcion.palermo@clavdia.test", pin: "4321", memberships: [{ org: "org_palermo", role: "recepcion", provider: null, admin: true }] },
  { id: "u_recep_d", name: "Ana (secretaría · Deporte)", email: "recepcion.deporte@clavdia.test", pin: "5678", memberships: [{ org: "org_deporte", role: "recepcion", provider: null, admin: true }] },
] as const;

/** Patients: global ficha + which orgs they belong to + a login. */
const PATIENTS = [
  {
    id: "pat_gomez", name: "María Gómez", dni: "28.444.123", dob: "1981-03-12",
    phone: "+54 9 11 5555-1010", email: "maria.gomez@example.com", coverage: "OSDE 210",
    allergies: ["Penicilina"], conditions: ["Hipertensión arterial", "Hipotiroidismo"],
    notes: "Prefiere turnos por la mañana. Controla presión en casa.",
    orgs: ["org_belgrano", "org_palermo"], login: { id: "u_gomez", pin: "1111" },
  },
  {
    id: "pat_fernandez", name: "Jorge Fernández", dni: "20.999.888", dob: "1959-11-30",
    phone: "+54 9 11 5555-2020", email: "jorge.fernandez@example.com", coverage: "PAMI",
    allergies: [], conditions: ["Fibrilación auricular", "Diabetes tipo 2"],
    notes: "Anticoagulado: cualquier cambio de medicación lo define el Dr. Sosa.",
    orgs: ["org_belgrano"], login: { id: "u_fernandez", pin: "2222" },
  },
  {
    id: "pat_ortiz", name: "Lucía Ortiz", dni: "39.222.777", dob: "1997-07-08",
    phone: "+54 9 11 5555-3030", email: "lucia.ortiz@example.com", coverage: "Swiss Medical SMG20",
    allergies: ["Ibuprofeno"], conditions: [], notes: "Consulta habitual por controles anuales.",
    orgs: ["org_belgrano"], login: null,
  },
  {
    id: "pat_gomez_2", name: "Mario Gómez", dni: "33.111.456", dob: `1990-${DEMO_MMDD}`, // cumple años hoy
    phone: "+54 9 11 5555-4040", email: "mario.gomez@example.com", coverage: "OSDE 310",
    allergies: [], conditions: ["Asma leve"],
    notes: "Homónimo parcial de María Gómez — confirmar identidad por DNI.",
    orgs: ["org_belgrano"], login: null,
  },
] as const;

const MEDS = [
  ["med_1", "pat_gomez", "Enalapril", "10 mg / día", "2026-06-10", 1],
  ["med_2", "pat_gomez", "Levotiroxina", "75 mcg / día", "2026-05-02", 1],
  ["med_3", "pat_fernandez", "Apixabán", "5 mg c/12 h", "2026-08-20", 1],
  ["med_4", "pat_fernandez", "Metformina", "850 mg c/12 h", "2026-07-15", 1],
  ["med_5", "pat_gomez_2", "Salbutamol", "según necesidad", "2026-04-01", 0],
] as const;

const slotIdFor = (providerId: string, isoStart: string) =>
  `slot_${providerId}_${isoStart.slice(0, 10)}_${isoStart.slice(11, 13)}${isoStart.slice(14, 16)}`;

export function seedIfEmpty(db: Database): void {
  if ((db.prepare("SELECT COUNT(*) AS n FROM organizations").get() as { n: number }).n > 0) return;

  const tx = db.transaction(() => {
    const org = db.prepare(
      "INSERT INTO organizations (id, name, slug, address, city, hours, phone, created_at) VALUES (?, ?, ?, ?, ?, 'Lunes a viernes de 8 a 18 h', ?, ?)",
    );
    for (const o of ORGS) org.run(o.id, o.name, o.slug, o.address, o.city, o.phone, new Date().toISOString());

    const provider = db.prepare(
      "INSERT INTO providers (id, organization_id, name, specialty, room_label, default_fee) VALUES (?, ?, ?, ?, ?, ?)",
    );
    for (const p of PROVIDERS) provider.run(p.id, p.org, p.name, p.specialty, p.room, p.fee);

    const price = db.prepare(
      "INSERT INTO provider_prices (id, organization_id, provider_id, label, amount) VALUES (?, ?, ?, ?, ?)",
    );
    PRICES.forEach((p, i) => price.run(`price_${i + 1}`, p.org, p.provider, p.label, p.amount));

    const slot = db.prepare(
      "INSERT INTO slots (id, organization_id, provider_id, start, duration_minutes, taken) VALUES (?, ?, ?, ?, 30, 0)",
    );
    for (const p of PROVIDERS) for (const s of generateSlotRows(p.id)) slot.run(s.id, p.org, s.providerId, s.start);

    const patient = db.prepare(`
      INSERT INTO patients (id, full_name, dni, date_of_birth, phone, email, coverage, allergies, active_conditions, notes)
      VALUES (@id, @name, @dni, @dob, @phone, @email, @coverage, @allergies, @conditions, @notes)
    `);
    const patOrg = db.prepare(
      "INSERT INTO patient_organizations (patient_id, organization_id, joined_at) VALUES (?, ?, ?)",
    );
    const user = db.prepare(
      "INSERT INTO users (id, name, email, role, pin_hash, pin_salt, patient_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    for (const p of PATIENTS) {
      patient.run({
        id: p.id, name: p.name, dni: p.dni, dob: p.dob, phone: p.phone, email: p.email,
        coverage: p.coverage, allergies: JSON.stringify(p.allergies), conditions: JSON.stringify(p.conditions),
        notes: p.notes,
      });
      for (const o of p.orgs) patOrg.run(p.id, o, new Date().toISOString());
      if (p.login) {
        const { hash, salt } = hashPin(p.login.pin);
        user.run(p.login.id, p.name, p.email, "paciente", hash, salt, p.id);
      }
    }

    const med = db.prepare(
      "INSERT INTO medications (id, patient_id, name, dose, last_prescribed, chronic) VALUES (?, ?, ?, ?, ?, ?)",
    );
    for (const m of MEDS) med.run(...m);

    const staffUser = db.prepare(
      "INSERT INTO users (id, name, email, role, pin_hash, pin_salt) VALUES (?, ?, ?, ?, ?, ?)",
    );
    const membership = db.prepare(
      "INSERT INTO memberships (user_id, organization_id, role, provider_id, can_admin) VALUES (?, ?, ?, ?, ?)",
    );
    for (const s of STAFF) {
      const { hash, salt } = hashPin(s.pin);
      staffUser.run(s.id, s.name, s.email, s.memberships[0].role, hash, salt);
      for (const m of s.memberships) membership.run(s.id, m.org, m.role, m.provider, m.admin ? 1 : 0);
    }

    // ── Live agenda demo: Consultorio Belgrano, Dra. Ruiz ──────────────────
    const appt = db.prepare(`
      INSERT INTO appointments (id, organization_id, patient_id, provider_id, start, duration_minutes, reason, status, price, created_via)
      VALUES (@id, @org, @patient, @provider, @start, 30, @reason, @status, @price, 'front-desk')
    `);
    const A = (id: string, org: string, patient: string, provider: string, start: string, reason: string, status = "scheduled", price = 0) =>
      appt.run({ id, org, patient, provider, start, reason, status, price });

    const S = demoNextSlot(15);
    const B = "org_belgrano";

    A("apt_1001", B, "pat_gomez", "prov_b_ruiz", `${DEMO_TOMORROW}T11:30:00`, "Control de presión arterial");
    A("apt_1002", B, "pat_fernandez", "prov_b_sosa", `${DEMO_TOMORROW}T10:00:00`, "Control de anticoagulación");
    A("apt_1003", B, "pat_ortiz", "prov_b_ruiz", `${DEMO_TOMORROW}T09:30:00`, "Chequeo anual");
    // María también se atiende en Palermo → su vista "Mis turnos" cruza dos organizaciones
    A("apt_2001", "org_palermo", "pat_gomez", "prov_p_paz", `${DEMO_TOMORROW}T16:00:00`, "Control dermatológico");

    A("apt_0901", B, "pat_ortiz", "prov_b_ruiz", shiftIso(S, -60), "Consulta clínica", "completed", 18000);
    A("apt_0904", B, "pat_fernandez", "prov_b_sosa", shiftIso(S, -30), "Consulta + ECG", "completed", 42000);
    A("apt_0910", B, "pat_gomez_2", "prov_b_ruiz", S, "Control de asma", "scheduled", 18000);
    A("apt_0911", B, "pat_gomez", "prov_b_ruiz", shiftIso(S, 30), "Control de presión arterial", "scheduled", 18000);
    A("apt_0912", B, "pat_fernandez", "prov_b_ruiz", shiftIso(S, 60), "Control clínico", "scheduled", 18000);

    const taken = [
      slotIdFor("prov_b_ruiz", `${DEMO_TOMORROW}T11:30:00`),
      slotIdFor("prov_b_sosa", `${DEMO_TOMORROW}T10:00:00`),
      slotIdFor("prov_b_ruiz", `${DEMO_TOMORROW}T09:30:00`),
      slotIdFor("prov_p_paz", `${DEMO_TOMORROW}T16:00:00`),
      slotIdFor("prov_b_ruiz", shiftIso(S, -60)),
      slotIdFor("prov_b_sosa", shiftIso(S, -30)),
      slotIdFor("prov_b_ruiz", S),
      slotIdFor("prov_b_ruiz", shiftIso(S, 30)),
      slotIdFor("prov_b_ruiz", shiftIso(S, 60)),
    ];
    const mark = db.prepare("UPDATE slots SET taken = 1 WHERE id = ?");
    for (const id of taken) mark.run(id);

    const inv = db.prepare(
      "INSERT INTO invoices (id, organization_id, patient_id, date, concept, amount, status) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    inv.run("inv_5001", B, "pat_gomez", "2026-08-15", "Consulta clínica", 18000, "paid");
    inv.run("inv_5002", B, "pat_fernandez", "2026-08-28", "Consulta cardiología + ECG", 42000, "unpaid");
    inv.run("inv_5003", B, "pat_ortiz", "2026-07-30", "Chequeo anual", 25000, "paid");
    inv.run("inv_5004", B, "pat_ortiz", "2026-08-30", "Resonancia magnética de rodilla", 180000, "paid");

    const lab = db.prepare(
      "INSERT INTO lab_results (id, organization_id, patient_id, date, panel, status, summary) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    lab.run("lab_7001", B, "pat_fernandez", "2026-09-05", "RIN / coagulograma", "pending-review", "RIN 3.8 (rango objetivo 2.0–3.0).");
    lab.run("lab_7002", B, "pat_gomez", "2026-08-14", "Perfil tiroideo", "reviewed", "TSH 2.1 — dentro de rango.");
  });

  tx();
}
