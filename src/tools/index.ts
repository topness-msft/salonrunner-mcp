import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { SalonRunnerClient } from "../salonrunner/client.js";

const dateRe = /^\d{4}-\d{2}-\d{2}$/;
const dateTimeRe = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

function text(data: unknown) {
  return { content: [{ type: "text" as const, text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }] };
}

export function registerTools(server: McpServer, client: SalonRunnerClient) {
  server.registerTool(
    "list_services",
    {
      title: "List services",
      description: "List bookable services offered by the salon (name, id, price, base duration).",
      inputSchema: {},
    },
    async () => {
      const services = await client.listServices();
      return text(
        services.map((s) => ({ id: s.id, name: s.name, price: s.defaultPrice }))
      );
    }
  );

  server.registerTool(
    "list_providers",
    {
      title: "List providers",
      description: "List stylists/providers who take online bookings. Optionally filter to those who perform a given serviceId.",
      inputSchema: { serviceId: z.number().int().optional().describe("Only providers who perform this service") },
    },
    async ({ serviceId }) => {
      const [employees, empServices] = await Promise.all([
        client.listEmployees(),
        serviceId ? client.listEmployeeServices() : Promise.resolve([]),
      ]);
      let list = employees;
      if (serviceId) {
        const ids = new Set(empServices.filter((e) => e.serviceId === serviceId && e.online).map((e) => e.employeeId));
        list = employees.filter((e) => ids.has(e.id));
      }
      return text(list.map((e) => ({ id: e.id, name: `${e.firstName} ${e.lastName}`.trim() })));
    }
  );

  server.registerTool(
    "find_availability",
    {
      title: "Find availability",
      description:
        "Find open appointment slots for a service in a date range (inclusive). Dates are YYYY-MM-DD. Optionally restrict to one providerId. Returns startable times with the matching provider.",
      inputSchema: {
        serviceId: z.number().int().describe("Service id from list_services"),
        from: z.string().regex(dateRe).describe("Start date YYYY-MM-DD"),
        to: z.string().regex(dateRe).describe("End date YYYY-MM-DD (inclusive)"),
        providerId: z.number().int().optional().describe("Restrict to this provider id"),
        limit: z.number().int().min(1).max(200).optional().describe("Max slots to return (default 50)"),
      },
    },
    async ({ serviceId, from, to, providerId, limit }) => {
      const slots = await client.findAvailability(serviceId, from, to, providerId);
      return text({ count: slots.length, slots: slots.slice(0, limit ?? 50) });
    }
  );

  server.registerTool(
    "list_my_appointments",
    {
      title: "List my appointments",
      description: "List the signed-in client's upcoming (non-cancelled) appointments.",
      inputSchema: {},
    },
    async () => {
      const [appts, services, employees] = await Promise.all([
        client.listAppointments(),
        client.listServices(),
        client.listAllEmployees(),
      ]);
      const svc = new Map(services.map((s) => [s.id, s.name]));
      const emp = new Map(employees.map((e) => [e.id, `${e.firstName} ${e.lastName}`.trim()]));
      return text(
        appts.map((a) => ({
          appointmentId: a.id,
          start: a.startDate,
          end: a.endDate,
          service: svc.get(a.serviceId) ?? `service ${a.serviceId}`,
          provider: emp.get(a.employeeId) ?? `employee ${a.employeeId}`,
          status: a.status,
        }))
      );
    }
  );

  server.registerTool(
    "book_appointment",
    {
      title: "Book an appointment",
      description:
        "Book an appointment. startTime must be a value returned by find_availability ('YYYY-MM-DD HH:MM:SS'). End time is computed from the provider's service duration. This creates a REAL booking subject to the salon's cancellation policy.",
      inputSchema: {
        serviceId: z.number().int(),
        providerId: z.number().int().describe("Provider id from find_availability"),
        startTime: z.string().regex(dateTimeRe).describe("'YYYY-MM-DD HH:MM:SS' from find_availability"),
      },
    },
    async ({ serviceId, providerId, startTime }) => {
      await client.book(serviceId, providerId, startTime);
      return text({ ok: true, message: `Booked service ${serviceId} with provider ${providerId} at ${startTime}.` });
    }
  );

  server.registerTool(
    "cancel_appointment",
    {
      title: "Cancel an appointment",
      description: "Cancel an existing appointment by appointmentId (from list_my_appointments). Cancellation fees may apply per the salon's policy.",
      inputSchema: {
        appointmentId: z.number().int(),
        reason: z.string().min(1).describe("Reason for cancellation"),
      },
    },
    async ({ appointmentId, reason }) => {
      await client.cancel(appointmentId, reason);
      return text({ ok: true, message: `Cancelled appointment ${appointmentId}.` });
    }
  );

  const guidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  server.registerTool(
    "confirm_appointment",
    {
      title: "Confirm an appointment",
      description:
        "Confirm an appointment using the reminder link the salon emails/texts you (e.g. '…/customer/appointments/conf.htm?uid=<GUID>&uuid=<GUID>'). Pass the whole link as `link`, or the two GUIDs as `uid` and `uuid`. Idempotent — confirming twice still reports success.",
      inputSchema: {
        link: z.string().url().optional().describe("The full confirmation link from your reminder email/text"),
        uid: z.string().regex(guidRe).optional().describe("The uid GUID from the link (use instead of `link`)"),
        uuid: z.string().regex(guidRe).optional().describe("The uuid GUID from the link (use instead of `link`)"),
      },
    },
    async ({ link, uid, uuid }) => {
      if (link) {
        const params = new URL(link).searchParams;
        uid = params.get("uid") ?? uid;
        uuid = params.get("uuid") ?? uuid;
      }
      if (!uid || !uuid) {
        throw new Error("Provide the confirmation `link`, or both `uid` and `uuid` from it.");
      }
      const result = await client.confirm(uid, uuid);
      return text(result);
    }
  );
}
