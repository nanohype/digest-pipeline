/**
 * Zod schemas for every API boundary. Parsed with `.parse` in the handler;
 * throws become 400 via the Fastify error serializer.
 */

import { z } from 'zod';

export const DraftIdParamSchema = z.object({
  id: z.uuid(),
});
export type DraftIdParam = z.infer<typeof DraftIdParamSchema>;

export const EditsBodySchema = z.object({
  editedText: z.string().min(1).max(100_000),
});
export type EditsBody = z.infer<typeof EditsBodySchema>;

export class ValidationError extends Error {
  readonly issues: readonly z.core.$ZodIssue[];
  constructor(issues: readonly z.core.$ZodIssue[]) {
    super('Validation failed');
    this.name = 'ValidationError';
    this.issues = issues;
  }
}

export function parseOrThrow<S extends z.ZodType>(schema: S, data: unknown): z.infer<S> {
  const result = schema.safeParse(data);
  if (!result.success) throw new ValidationError(result.error.issues);
  return result.data;
}
