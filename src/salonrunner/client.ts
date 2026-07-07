import type { Config } from "../config.js";
import type {
  AuthToken,
  JwtPayload,
  Service,
  Employee,
  EmployeeService,
  DaySchedule,
  Appointment,
  AvailableSlot,
} from "./types.js";

/** Decode a JWT payload without verifying (we only read non-secret claims). */
function decodeJwt(token: string): JwtPayload {
  const part = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(Buffer.from(part, "base64").toString("utf8"));
}

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}

/** Add `minutes` to a "YYYY-MM-DD HH:MM:SS" string, returning the same format. */
function addMinutes(dateTime: string, minutes: number): string {
  const [d, t] = dateTime.split(" ");
  const [y, mo, da] = d.split("-").map(Number);
  const [h, mi, s] = t.split(":").map(Number);
  const dt = new Date(Date.UTC(y, mo - 1, da, h, mi, s));
  dt.setUTCMinutes(dt.getUTCMinutes() + minutes);
  return (
    `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())} ` +
    `${pad(dt.getUTCHours())}:${pad(dt.getUTCMinutes())}:${pad(dt.getUTCSeconds())}`
  );
}

/**
 * Client for one SalonRunner customer account.
 *
 * Auth model (reverse-engineered, see README):
 *   1. POST /customer/login.htm  -> session cookies
 *   2. GET  /customer/authv2.json -> short-lived customer JWT (+ customerId in `sub`)
 *   3. v2 reads use `Authorization: Bearer <jwt>`; book/cancel use the session cookie.
 */
export class SalonRunnerClient {
  private cookies = new Map<string, string>();
  private jwt?: string;
  private jwtExpiresAt = 0;
  private corporateId?: number;
  private _customerId?: number;

  constructor(private cfg: Config) {
    this._customerId = cfg.customerId;
  }

  // ---- cookie jar -------------------------------------------------------
  private storeCookies(res: Response) {
    // Node's fetch exposes multiple Set-Cookie headers via getSetCookie().
    const raw = (res.headers as any).getSetCookie?.() as string[] | undefined;
    for (const line of raw ?? []) {
      const [pair] = line.split(";");
      const eq = pair.indexOf("=");
      if (eq > 0) this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }

  private cookieHeader(): string {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  // ---- authentication ---------------------------------------------------
  private async login(): Promise<void> {
    const body = new URLSearchParams({
      salonId: String(this.cfg.salonId),
      username: this.cfg.username,
      password: this.cfg.password,
      rememberMe: "checked",
    });
    const res = await fetch(`${this.cfg.base}/customer/login.htm`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      redirect: "manual",
    });
    this.storeCookies(res);

    // Success redirects to home; failure bounces back to login (with an errorMessage cookie).
    const location = res.headers.get("location") ?? "";
    if (this.cookies.has("errorMessage") || /login\.htm/.test(location)) {
      throw new Error("SalonRunner login failed — check SALONRUNNER_USERNAME / SALONRUNNER_PASSWORD / SALONRUNNER_SALON_ID.");
    }
    if (!this.cookies.size) {
      throw new Error("SalonRunner login returned no session cookie.");
    }
  }

  /**
   * Discover the numeric customerId for the logged-in account. `authv2.json`
   * requires it (it returns `{}` without it). The booking page reliably embeds
   * it as `customerId = NNNN` in its inline JS; appointment rows carry it too.
   */
  private async resolveCustomerId(): Promise<number> {
    if (this._customerId) return this._customerId;
    if (!this.cookies.size) await this.login();

    const newPage = await fetch(`${this.cfg.base}/customer/appointments/new.htm`, {
      headers: { Accept: "text/html", Cookie: this.cookieHeader() },
    });
    const html = await newPage.text();
    let m = html.match(/customerId["'=:\s]{1,6}(\d{4,})/i);
    if (!m) {
      const appts = await fetch(`${this.cfg.base}/customer/appointments/fetchAppointments.htm`, {
        headers: { Cookie: this.cookieHeader() },
      });
      m = (await appts.text()).match(/data-customer-id=["'](\d+)["']/i);
    }
    if (!m) throw new Error("Could not discover customerId after login; set SALONRUNNER_CUSTOMER_ID.");
    this._customerId = parseInt(m[1], 10);
    return this._customerId;
  }

  /** Mint a customer JWT for the given customerId (returns null token body if invalid). */
  private async mintToken(customerId: number): Promise<AuthToken | null> {
    const res = await fetch(
      `${this.cfg.base}/customer/authv2.json?salonId=${this.cfg.salonId}&customerId=${customerId}`,
      { headers: { Accept: "application/json", Cookie: this.cookieHeader() } }
    );
    const text = await res.text();
    if (!text.trimStart().startsWith("{")) return null; // session expired -> login HTML
    const parsed = JSON.parse(text) as Partial<AuthToken>;
    return parsed.token ? (parsed as AuthToken) : null; // `{}` when customerId missing/invalid
  }

  /** Ensure we hold a valid (non-expired) JWT, logging in / refreshing as needed. */
  private async ensureToken(): Promise<string> {
    if (this.jwt && Date.now() < this.jwtExpiresAt - 120_000) return this.jwt;

    if (!this.cookies.size) await this.login();
    let auth = await this.mintToken(await this.resolveCustomerId());

    // Session expired -> re-login (and re-discover customerId) once.
    if (!auth) {
      this.cookies.clear();
      this._customerId = this.cfg.customerId;
      await this.login();
      auth = await this.mintToken(await this.resolveCustomerId());
      if (!auth) throw new Error("Could not mint customer token after re-login.");
    }

    const payload = decodeJwt(auth.token);
    this.jwt = auth.token;
    this.jwtExpiresAt = payload.exp * 1000;
    this.corporateId = payload.salon.c;
    return this.jwt;
  }

  async customerId(): Promise<number> {
    if (this._customerId) return this._customerId;
    return this.resolveCustomerId();
  }

  // ---- low-level requests ----------------------------------------------
  private async v2<T = any>(path: string): Promise<T> {
    const token = await this.ensureToken();
    const sep = path.includes("?") ? "&" : "?";
    const url = `${this.cfg.apiV2}${path}${sep}salonId=${this.cfg.salonId}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    if (res.status === 204) return {} as T;
    if (!res.ok) throw new Error(`v2 GET ${path} failed: HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  private embedded<T>(obj: any, key: string): T[] {
    return (obj?._embedded?.[key] as T[]) ?? [];
  }

  /** A session-cookie GET against app.salonrunner.com/customer (used for writes). */
  private async customerGet(path: string): Promise<string> {
    await this.ensureToken(); // guarantees a live session cookie
    const res = await fetch(`${this.cfg.base}${path}`, {
      headers: { Accept: "application/json", "X-Requested-With": "XMLHttpRequest", Cookie: this.cookieHeader() },
    });
    if (!res.ok) throw new Error(`GET ${path} failed: HTTP ${res.status}`);
    return await res.text();
  }

  // ---- reads ------------------------------------------------------------
  async listServices(): Promise<Service[]> {
    const data = await this.v2(`/services?includes=defaults&active=true`);
    return this.embedded<Service>(data, "services").filter((s) => s.online);
  }

  async listEmployees(): Promise<Employee[]> {
    const data = await this.v2(
      `/employees?includes=schedule,performsServices&active=true&performsServices=true&online=true`
    );
    return this.embedded<Employee>(data, "employees");
  }

  /** All active employees — used for resolving provider names (a superset of the online list). */
  async listAllEmployees(): Promise<Employee[]> {
    const data = await this.v2(`/employees?active=true`);
    return this.embedded<Employee>(data, "employees");
  }

  async listEmployeeServices(): Promise<EmployeeService[]> {
    const data = await this.v2(`/employeeServices?includeTerminated=false`);
    return this.embedded<EmployeeService>(data, "employeeServices");
  }

  async listAppointments(): Promise<Appointment[]> {
    await this.ensureToken(); // guarantees corporateId (read from the JWT) is loaded
    const clientId = await this.customerId();
    const data = await this.v2(
      `/appointments?corporateId=${this.corporateId}&cancelled=false&clientId=${clientId}&from=today&showAllEmployee=true`
    );
    return this.embedded<Appointment>(data, "appointments");
  }

  private async daySchedules(employeeId: number, from: string, to: string): Promise<DaySchedule[]> {
    const data = await this.v2(
      `/employeeSchedules?format=slots&from=${from}&to=${to}&employeeId=${employeeId}`
    );
    // The endpoint may return schedules for several employees; keep only this one.
    return this.embedded<DaySchedule>(data, "employeeSchedules").filter(
      (d) => d.employeeId === employeeId
    );
  }

  // ---- availability -----------------------------------------------------
  /**
   * Find bookable slots for a service between two dates.
   * A start is bookable when there are enough consecutive free increments to
   * cover the provider's duration for that service.
   */
  async findAvailability(
    serviceId: number,
    from: string,
    to: string,
    employeeId?: number
  ): Promise<AvailableSlot[]> {
    const [services, onlineEmployees, allEmployees, empServices] = await Promise.all([
      this.listServices(),
      this.listEmployees(),
      this.listAllEmployees(),
      this.listEmployeeServices(),
    ]);
    const service = services.find((s) => s.id === serviceId);
    if (!service) throw new Error(`Unknown serviceId ${serviceId}. Use list_services.`);

    const increment = this.cfg.slotMinutes;
    // Only providers who take online bookings AND offer this service online.
    const onlineIds = new Set(onlineEmployees.filter((e) => e.availableOnline).map((e) => e.id));
    const candidates = empServices.filter(
      (es) =>
        es.serviceId === serviceId &&
        es.online &&
        onlineIds.has(es.employeeId) &&
        (!employeeId || es.employeeId === employeeId)
    );
    if (!candidates.length) {
      throw new Error(`No online provider offers serviceId ${serviceId}${employeeId ? ` (employee ${employeeId})` : ""}.`);
    }

    const out: AvailableSlot[] = [];
    for (const es of candidates) {
      const emp = allEmployees.find((e) => e.id === es.employeeId);
      const name = emp ? `${emp.firstName} ${emp.lastName}`.trim() : `Employee ${es.employeeId}`;
      const needed = Math.max(1, Math.ceil((es.duration + es.processTime) / increment));
      const days = await this.daySchedules(es.employeeId, from, to);
      for (const day of days) {
        if (day.off) continue;
        for (let i = 0; i + needed <= day.slots.length; i++) {
          if (day.slots.slice(i, i + needed).every(Boolean)) {
            const start = `${day.day} ${day.startTime}`;
            const slotStart = addMinutes(start, i * increment);
            out.push({
              start: slotStart,
              end: addMinutes(slotStart, es.duration),
              employeeId: es.employeeId,
              employeeName: name,
              serviceId,
              serviceName: service.name,
              durationMinutes: es.duration,
            });
          }
        }
      }
    }
    out.sort((a, b) => a.start.localeCompare(b.start));
    return out;
  }

  // ---- writes -----------------------------------------------------------
  async book(serviceId: number, employeeId: number, startTime: string): Promise<{ ok: true; raw: string }> {
    if (this.cfg.readOnly) throw new Error("Server is in read-only mode (SALONRUNNER_READ_ONLY=true).");
    const empServices = await this.listEmployeeServices();
    const es = empServices.find((e) => e.employeeId === employeeId && e.serviceId === serviceId);
    if (!es) throw new Error(`Provider ${employeeId} does not offer service ${serviceId}.`);
    const endTime = addMinutes(startTime, es.duration);
    const customerId = await this.customerId();
    const q = new URLSearchParams({
      customerId: String(customerId),
      appointmentSalonId: String(this.cfg.salonId),
      startTime,
      endTime,
      employeeId: String(employeeId),
      serviceId: String(serviceId),
      status: "",
      id: "",
    });
    const raw = await this.customerGet(`/customer/appointments/book.json?${q.toString()}`);
    return { ok: true, raw };
  }

  async cancel(appointmentId: number, reason: string): Promise<{ ok: true; raw: string }> {
    if (this.cfg.readOnly) throw new Error("Server is in read-only mode (SALONRUNNER_READ_ONLY=true).");
    const customerId = await this.customerId();
    const q = new URLSearchParams({
      appointmentId: String(appointmentId),
      customerId: String(customerId),
      reason,
    });
    const raw = await this.customerGet(`/customer/appointments/cancel.json?${q.toString()}`);
    return { ok: true, raw };
  }

  /**
   * Confirm an appointment from a reminder link the salon emails/texts you, e.g.
   * `…/customer/appointments/conf.htm?uid=<GUID>&uuid=<GUID>`.
   *
   * The two GUIDs are the capability — no login is required (the link is clicked
   * straight from the message). The endpoint confirms on GET and renders an HTML
   * page; success and failure are distinguished by its message text. Confirming
   * an already-confirmed appointment is idempotent (still reports success).
   */
  async confirm(uid: string, uuid: string): Promise<{ ok: boolean; message: string }> {
    const q = new URLSearchParams({ uid, uuid });
    const res = await fetch(`${this.cfg.rosyBase}/customer/appointments/conf.htm?${q.toString()}`, {
      headers: { Accept: "text/html", "User-Agent": "Mozilla/5.0" },
    });
    const body = await res.text();
    if (/has been confirmed/i.test(body)) {
      return { ok: true, message: "Your appointment has been confirmed." };
    }
    if (/could not be confirmed/i.test(body)) {
      return {
        ok: false,
        message: "Appointment could not be confirmed — the link may be invalid or expired. Please call the salon.",
      };
    }
    return { ok: false, message: `Unexpected response from confirmation endpoint (HTTP ${res.status}).` };
  }
}
