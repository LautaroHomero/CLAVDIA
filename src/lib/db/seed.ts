import { hashPin } from "@/lib/auth/pin";
import { DEMO_MMDD, DEMO_TOMORROW, demoNextSlot, shiftIso } from "@/lib/domain/clock";
import type { Sql } from "./connection";
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
    { org: "org_palermo", role: "medico", provider: "prov_p_ruiz", admin: false },
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
    id: "pat_gomez_2", name: "Mario Gómez", dni: "33.111.456", dob: `1990-${DEMO_MMDD}`,
    phone: "+54 9 11 5555-4040", email: "mario.gomez@example.com", coverage: "OSDE 310",
    allergies: [], conditions: ["Asma leve"],
    notes: "Homónimo parcial de María Gómez — confirmar identidad por DNI.",
    orgs: ["org_belgrano"], login: null,
  },
] as const;

const MEDS: [string, string, string, string, string, number][] = [
  ["med_1", "pat_gomez", "Enalapril", "10 mg / día", "2026-06-10", 1],
  ["med_2", "pat_gomez", "Levotiroxina", "75 mcg / día", "2026-05-02", 1],
  ["med_3", "pat_fernandez", "Apixabán", "5 mg c/12 h", "2026-08-20", 1],
  ["med_4", "pat_fernandez", "Metformina", "850 mg c/12 h", "2026-07-15", 1],
  ["med_5", "pat_gomez_2", "Salbutamol", "según necesidad", "2026-04-01", 0],
];

const slotIdFor = (providerId: string, isoStart: string) =>
  `slot_${providerId}_${isoStart.slice(0, 10)}_${isoStart.slice(11, 13)}${isoStart.slice(14, 16)}`;

type ApptRow = {
  id: string;
  organization_id: string;
  patient_id: string;
  provider_id: string;
  start: string;
  duration_minutes: number;
  reason: string;
  status: string;
  price: number;
  created_via: string;
};

/** Seeds a fresh database. No-op (returns false) if `organizations` isn't empty. */
export async function seedIfEmpty(sql: Sql): Promise<boolean> {
  const [{ n }] = (await sql`SELECT count(*)::int AS n FROM organizations`) as unknown as { n: number }[];
  if (n > 0) return false;

  const now = new Date().toISOString();

  await sql.begin(async (tx) => {
    await tx`INSERT INTO organizations ${tx(
      ORGS.map((o) => ({
        id: o.id, name: o.name, slug: o.slug, address: o.address, city: o.city,
        hours: "Lunes a viernes de 8 a 18 h", phone: o.phone, created_at: now,
      })),
    )}`;

    await tx`INSERT INTO providers ${tx(
      PROVIDERS.map((p) => ({
        id: p.id, organization_id: p.org, name: p.name, specialty: p.specialty,
        room_label: p.room, default_fee: p.fee,
      })),
    )}`;

    await tx`INSERT INTO provider_prices ${tx(
      PRICES.map((p, i) => ({
        id: `price_${i + 1}`, organization_id: p.org, provider_id: p.provider,
        label: p.label, amount: p.amount,
      })),
    )}`;

    const slotRows = PROVIDERS.flatMap((p) =>
      generateSlotRows(p.id).map((s) => ({
        id: s.id, organization_id: p.org, provider_id: s.providerId,
        start: s.start, duration_minutes: 30, taken: 0,
      })),
    );
    await tx`INSERT INTO slots ${tx(slotRows)}`;

    await tx`INSERT INTO patients ${tx(
      PATIENTS.map((p) => ({
        id: p.id, full_name: p.name, dni: p.dni, date_of_birth: p.dob, phone: p.phone,
        email: p.email, coverage: p.coverage,
        allergies: JSON.stringify(p.allergies), active_conditions: JSON.stringify(p.conditions),
        notes: p.notes,
      })),
    )}`;

    const patOrgRows = PATIENTS.flatMap((p) =>
      p.orgs.map((o) => ({ patient_id: p.id, organization_id: o, joined_at: now })),
    );
    await tx`INSERT INTO patient_organizations ${tx(patOrgRows)}`;

    const patientUserRows = PATIENTS.filter((p) => p.login).map((p) => {
      const { hash, salt } = hashPin(p.login!.pin);
      return {
        id: p.login!.id, name: p.name, email: p.email, dni: p.dni, phone: p.phone,
        role: "paciente", pin_hash: hash, pin_salt: salt, patient_id: p.id,
      };
    });
    if (patientUserRows.length) await tx`INSERT INTO users ${tx(patientUserRows)}`;

    await tx`INSERT INTO medications ${tx(
      MEDS.map(([id, pid, name, dose, last, chronic]) => ({
        id, patient_id: pid, name, dose, last_prescribed: last, chronic,
      })),
    )}`;

    const staffUserRows = STAFF.map((s) => {
      const { hash, salt } = hashPin(s.pin);
      return {
        id: s.id, name: s.name, email: s.email, dni: "", phone: "",
        role: s.memberships[0].role, pin_hash: hash, pin_salt: salt, patient_id: null,
      };
    });
    await tx`INSERT INTO users ${tx(staffUserRows)}`;

    const membershipRows = STAFF.flatMap((s) =>
      s.memberships.map((m) => ({
        user_id: s.id, organization_id: m.org, role: m.role,
        provider_id: m.provider, can_admin: m.admin ? 1 : 0,
      })),
    );
    await tx`INSERT INTO memberships ${tx(membershipRows)}`;

    // ── Live agenda demo: Consultorio Belgrano, Dra. Ruiz ──────────────────
    const S = demoNextSlot(15);
    const B = "org_belgrano";
    const A = (
      id: string, org: string, patient: string, provider: string, start: string,
      reason: string, status = "scheduled", price = 0,
    ): ApptRow => ({
      id, organization_id: org, patient_id: patient, provider_id: provider, start,
      duration_minutes: 30, reason, status, price, created_via: "front-desk",
    });

    const appts: ApptRow[] = [
      A("apt_1001", B, "pat_gomez", "prov_b_ruiz", `${DEMO_TOMORROW}T11:30:00`, "Control de presión arterial"),
      A("apt_1002", B, "pat_fernandez", "prov_b_sosa", `${DEMO_TOMORROW}T10:00:00`, "Control de anticoagulación"),
      A("apt_1003", B, "pat_ortiz", "prov_b_ruiz", `${DEMO_TOMORROW}T09:30:00`, "Chequeo anual"),
      A("apt_2001", "org_palermo", "pat_gomez", "prov_p_paz", `${DEMO_TOMORROW}T16:00:00`, "Control dermatológico"),
      A("apt_0901", B, "pat_ortiz", "prov_b_ruiz", shiftIso(S, -60), "Consulta clínica", "completed", 18000),
      A("apt_0904", B, "pat_fernandez", "prov_b_sosa", shiftIso(S, -30), "Consulta + ECG", "completed", 42000),
      A("apt_0910", B, "pat_gomez_2", "prov_b_ruiz", S, "Control de asma", "scheduled", 18000),
      A("apt_0911", B, "pat_gomez", "prov_b_ruiz", shiftIso(S, 30), "Control de presión arterial", "scheduled", 18000),
      A("apt_0912", B, "pat_fernandez", "prov_b_ruiz", shiftIso(S, 60), "Control clínico", "scheduled", 18000),
    ];
    await tx`INSERT INTO appointments ${tx(appts)}`;

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
    await tx`UPDATE slots SET taken = 1 WHERE id IN ${tx(taken)}`;

    await tx`INSERT INTO invoices ${tx([
      { id: "inv_5001", organization_id: B, patient_id: "pat_gomez", date: "2026-08-15", concept: "Consulta clínica", amount: 18000, status: "paid" },
      { id: "inv_5002", organization_id: B, patient_id: "pat_fernandez", date: "2026-08-28", concept: "Consulta cardiología + ECG", amount: 42000, status: "unpaid" },
      { id: "inv_5003", organization_id: B, patient_id: "pat_ortiz", date: "2026-07-30", concept: "Chequeo anual", amount: 25000, status: "paid" },
      { id: "inv_5004", organization_id: B, patient_id: "pat_ortiz", date: "2026-08-30", concept: "Resonancia magnética de rodilla", amount: 180000, status: "paid" },
    ])}`;

    await tx`INSERT INTO lab_results ${tx([
      { id: "lab_7001", organization_id: B, patient_id: "pat_fernandez", date: "2026-09-05", panel: "RIN / coagulograma", status: "pending-review", summary: "RIN 3.8 (rango objetivo 2.0–3.0)." },
      { id: "lab_7002", organization_id: B, patient_id: "pat_gomez", date: "2026-08-14", panel: "Perfil tiroideo", status: "reviewed", summary: "TSH 2.1 — dentro de rango." },
    ])}`;
  });

  return true;
}
