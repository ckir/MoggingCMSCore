import type { Field } from "./fields.js";

export type Collection = {
  readonly name: string;
  readonly fields: Record<string, Field>;
};

export function defineCollection(name: string, fields: Record<string, Field>): Collection {
  return { name, fields };
}
