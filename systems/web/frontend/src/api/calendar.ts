import { api } from "./http";
import type { UpcomingCalendar } from "./types";

/** What is scheduled for one market over the next few days: global macro releases, India's RBI/MoSPI/holiday dates, expiries. */
export const getUpcomingCalendar = (segment: "NSE" | "MCX" | "CRYPTO", days = 7) => api<UpcomingCalendar>("marketData", `/calendar/upcoming?segment=${segment}&days=${days}`);
