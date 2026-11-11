export type FieldOptions = {
  localized?: boolean;
  fallback?: string[] | "none";
  body?: boolean;
  required?: boolean;
};

type Base = {
  localized: boolean;
  fallback?: string[] | "none";
  body: boolean;
  required: boolean;
};

export type Field =
  | (Base & { kind: "text" })
  | (Base & { kind: "richText" })
  | (Base & { kind: "number" })
  | (Base & { kind: "boolean" })
  | (Base & { kind: "dateTime" })
  | (Base & { kind: "slug" })
  | (Base & { kind: "reference"; collection: string })
  | (Base & { kind: "list"; item: Field })
  | (Base & { kind: "object"; fields: Record<string, Field> });

function base(o: FieldOptions = {}): Base {
  const b: Base = {
    localized: o.localized ?? false,
    body: o.body ?? false,
    required: o.required ?? false,
  };
  if (o.fallback !== undefined) b.fallback = o.fallback;
  return b;
}

export const text = (o?: FieldOptions): Field => ({ kind: "text", ...base(o) });
export const richText = (o?: FieldOptions): Field => ({ kind: "richText", ...base(o) });
export const number = (o?: FieldOptions): Field => ({ kind: "number", ...base(o) });
export const boolean = (o?: FieldOptions): Field => ({ kind: "boolean", ...base(o) });
export const dateTime = (o?: FieldOptions): Field => ({ kind: "dateTime", ...base(o) });
export const slug = (): Field => ({ kind: "slug", ...base() });
export const reference = (collection: string, o?: FieldOptions): Field => ({
  kind: "reference", collection, ...base(o),
});
export const list = (item: Field, o?: FieldOptions): Field => ({ kind: "list", item, ...base(o) });
export const object = (fields: Record<string, Field>, o?: FieldOptions): Field => ({
  kind: "object", fields, ...base(o),
});
