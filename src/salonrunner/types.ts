// Shapes returned by the SalonRunner / Rosy customer API (v2 uses HAL `_embedded`).
// Captured live from app.rosysalonsoftware.com/api/v2 and app.salonrunner.com/customer.

export interface AuthToken {
  token: string;
  expiry: string; // ISO timestamp
  refreshToken: string;
}

export interface JwtPayload {
  sub: string; // "custId:32764868"
  salon: { id: number; c: number; h: number; tz: string };
  exp: number;
  iss: string;
}

export interface Service {
  id: number;
  name: string;
  serviceGroupId: number;
  online: boolean;
  active: boolean;
  defaultPrice: number;
  defaultDurationPrice: number; // base time increment (minutes)
  defaultProcessTime: number;
}

export interface Employee {
  id: number;
  firstName: string;
  lastName: string;
  performsServices: boolean;
  availableOnline: boolean;
}

export interface EmployeeService {
  employeeId: number;
  serviceId: number;
  price: number;
  duration: number; // minutes — the authoritative per-provider service length
  processTime: number;
  online: boolean;
}

export interface DaySchedule {
  day: string; // "2026-07-01"
  employeeId: number;
  off: boolean;
  startTime: string; // "07:30:00"
  slots: boolean[]; // each element = one increment of `slotMinutes`, true = free
}

export interface Appointment {
  id: number;
  employeeId: number;
  serviceId: number;
  status: string;
  startDate: string; // "2026-07-11 10:30:00"
  endDate: string;
  serviceDate: string;
  clientId: number;
}

export interface AvailableSlot {
  start: string; // "YYYY-MM-DD HH:MM:SS"
  end: string;
  employeeId: number;
  employeeName: string;
  serviceId: number;
  serviceName: string;
  durationMinutes: number;
}
