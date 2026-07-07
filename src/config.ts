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

/** The salon-account credentials a user supplies (env in stdio mode, init screen in HTTP mode). */
export interface Credentials {
  salonId: number;
  username: string;
  password: string;
}

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable: ${name}`);
  return v;
}

/** Non-credential settings, sourced from env, shared by every client. */
export function envDefaults(): Omit<Config, "salonId" | "username" | "password" | "customerId"> {
  return {
    slotMinutes: parseInt(process.env.SALONRUNNER_SLOT_MINUTES ?? "15", 10),
    readOnly: (process.env.SALONRUNNER_READ_ONLY ?? "false").toLowerCase() === "true",
    base: process.env.SALONRUNNER_BASE ?? "https://app.salonrunner.com",
    apiV2: process.env.SALONRUNNER_API_V2 ?? "https://app.rosysalonsoftware.com/api/v2",
  };
}

/** Build a full Config from user credentials plus env defaults (HTTP / multi-user mode). */
export function configFor(creds: Credentials): Config {
  return { ...envDefaults(), ...creds };
}

/** Full config from environment (used by the local stdio entrypoint). */
export function loadConfig(): Config {
  return configFor({
    salonId: parseInt(req("SALONRUNNER_SALON_ID"), 10),
    username: req("SALONRUNNER_USERNAME"),
    password: req("SALONRUNNER_PASSWORD"),
  });
}
