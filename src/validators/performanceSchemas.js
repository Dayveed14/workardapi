import { z } from 'zod';

// GET /api/performance?month=2026-11&months=1|3|6&departmentId=
export const performanceQuerySchema = z.object({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Choose a month').optional(),
  months: z.coerce.number().int().refine((n) => [1, 3, 6].includes(n), 'Choose 1, 3 or 6 months').optional().default(1),
  departmentId: z.coerce.number().int().positive().optional(),
});
