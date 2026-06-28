export interface Config {
  salonId: number;
  username: string;
  password: string;
  customerId?: number;
  slotMinutes: number;
  readOnly: boolean;
  base: string;
  apiV2: string;
}

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable: ${name}`);
  return v;
}

export function loadConfig(): Config {
  return {
    salonId: parseInt(req("SALONRUNNER_SALON_ID"), 10),
    username: req("SALONRUNNER_USERNAME"),
    password: req("SALONRUNNER_PASSWORD"),
    customerId: process.env.SALONRUNNER_CUSTOMER_ID
      ? parseInt(process.env.SALONRUNNER_CUSTOMER_ID, 10)
      : undefined,
    slotMinutes: parseInt(process.env.SALONRUNNER_SLOT_MINUTES ?? "15", 10),
    readOnly: (process.env.SALONRUNNER_READ_ONLY ?? "false").toLowerCase() === "true",
    base: process.env.SALONRUNNER_BASE ?? "https://app.salonrunner.com",
    apiV2: process.env.SALONRUNNER_API_V2 ?? "https://app.rosysalonsoftware.com/api/v2",
  };
}
