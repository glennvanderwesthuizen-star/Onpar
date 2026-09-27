import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';

/** Throws a 400 with `{ message, errors: { field: message } }` when invalid. */
export function parseBody<T extends z.ZodTypeAny>(schema: T, body: unknown): z.infer<T> {
  const r = schema.safeParse(body);
  if (r.success) return r.data;
  const errors: Record<string, string> = {};
  for (const issue of r.error.issues) {
    const key = issue.path.join('.') || '_';
    errors[key] ??= issue.message;
  }
  throw new BadRequestException({ message: 'Please fix the highlighted fields.', errors });
}

/** Throws the same 400 shape from a rules-package error map, if it has entries. */
export function throwIfErrors(errors: Record<string, string>) {
  if (Object.keys(errors).length) {
    throw new BadRequestException({ message: 'Please fix the highlighted fields.', errors });
  }
}

export const uuid = z.string().uuid();
